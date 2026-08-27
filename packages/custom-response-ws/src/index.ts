import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	stream as streamOpenAIResponses,
	streamSimple as streamSimpleOpenAIResponses,
	type OpenAIResponsesOptions,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
	registerSessionResourceCleanup,
	type Model,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type MessageEvent as UndiciMessageEvent, WebSocket } from "undici";

const API = "openai-responses-ws";
const PI_USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
const DEFAULT_BETA = "responses_websockets=2026-02-06";
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const MAX_AUTO_WEBSOCKET_RETRIES = 3;
const IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_CONNECTION_AGE_MS = 55 * 60 * 1000;
const PREVIOUS_RESPONSE_NOT_FOUND = "previous_response_not_found";
const CONNECTION_LIMIT_REACHED = "websocket_connection_limit_reached";
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);

type Socket = InstanceType<typeof WebSocket>;
type RequestBody = Record<string, unknown> & {
	input?: unknown[];
	previous_response_id?: string;
};

interface ContinuationState {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: unknown[];
}

interface CachedConnection {
	socket: Socket;
	sessionId: string;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: ContinuationState;
}

interface AcquiredConnection {
	socket: Socket;
	entry?: CachedConnection;
	release(keep: boolean): void;
}

interface TransportConfig {
	beta: string;
}

const connectionCache = new Map<string, CachedConnection>();
const sseFallbackSessions = new Set<string>();

class WebSocketApiError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "WebSocketApiError";
		this.code = code;
	}
}

function closeSocket(socket: Socket, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function closeConnections(sessionId?: string): void {
	for (const [key, entry] of connectionCache) {
		if (sessionId && entry.sessionId !== sessionId) continue;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeSocket(entry.socket, 1000, "session_cleanup");
		connectionCache.delete(key);
	}
	if (sessionId) sseFallbackSessions.delete(sessionId);
	else sseFallbackSessions.clear();
}

registerSessionResourceCleanup(closeConnections);

function errorMessage(value: unknown, fallback: string): string {
	if (value && typeof value === "object") {
		const event = value as { error?: unknown; message?: unknown; code?: unknown; reason?: unknown };
		if (event.error instanceof Error) return event.error.message;
		if (typeof event.message === "string" && event.message) return event.message;
		if (typeof event.reason === "string" && event.reason) return event.reason;
		if (typeof event.code === "number" && event.code) return `${fallback} (${event.code})`;
	}
	return fallback;
}

async function connect(url: string, headers: Record<string, string>, signal?: AbortSignal, timeoutMs?: number): Promise<Socket> {
	if (signal?.aborted) throw new Error("Request was aborted");

	return new Promise<Socket>((resolve, reject) => {
		const socket = new WebSocket(url, { headers });
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			closeSocket(socket, 1000, "connect_failed");
			reject(error);
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError = (event: Event) => fail(new Error(errorMessage(event, "WebSocket connection failed")));
		const onClose = (event: Event) => fail(new Error(errorMessage(event, "WebSocket closed while connecting")));
		const onAbort = () => fail(new Error("Request was aborted"));

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });

		const effectiveTimeout = timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		if (effectiveTimeout > 0) {
			timer = setTimeout(
				() => fail(new Error(`WebSocket connect timeout after ${effectiveTimeout}ms`)),
				effectiveTimeout,
			);
		}
	});
}

function isOpen(socket: Socket): boolean {
	return socket.readyState === WebSocket.OPEN;
}

function isExpired(entry: CachedConnection): boolean {
	return Date.now() - entry.createdAt >= MAX_CONNECTION_AGE_MS;
}

function connectionKey(sessionId: string, url: string, headers: Record<string, string>): string {
	const headerFingerprint = createHash("sha256")
		.update(JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
	return `${sessionId}\n${url}\n${headerFingerprint}`;
}

async function acquireConnection(
	url: string,
	headers: Record<string, string>,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): Promise<AcquiredConnection> {
	const key = sessionId ? connectionKey(sessionId, url, headers) : undefined;
	const cached = key ? connectionCache.get(key) : undefined;

	if (cached && cached.idleTimer) {
		clearTimeout(cached.idleTimer);
		cached.idleTimer = undefined;
	}
	if (cached && !cached.busy && (isExpired(cached) || !isOpen(cached.socket))) {
		closeSocket(cached.socket, 1000, isExpired(cached) ? "connection_age_limit" : "done");
		connectionCache.delete(key!);
	} else if (cached && !cached.busy) {
		cached.busy = true;
		return {
			socket: cached.socket,
			entry: cached,
			release: createRelease(key!, cached),
		};
	}

	const socket = await connect(url, headers, signal, timeoutMs);
	if (!key || cached?.busy) {
		return { socket, release: () => closeSocket(socket) };
	}

	const entry: CachedConnection = { socket, sessionId: sessionId!, busy: true, createdAt: Date.now() };
	connectionCache.set(key, entry);
	return { socket, entry, release: createRelease(key, entry) };
}

function createRelease(key: string, entry: CachedConnection): (keep: boolean) => void {
	let released = false;
	return (keep) => {
		if (released) return;
		released = true;
		entry.busy = false;
		if (!keep || !isOpen(entry.socket)) {
			closeSocket(entry.socket);
			if (connectionCache.get(key) === entry) connectionCache.delete(key);
			return;
		}
		entry.idleTimer = setTimeout(() => {
			if (entry.busy || connectionCache.get(key) !== entry) return;
			closeSocket(entry.socket, 1000, "idle_timeout");
			connectionCache.delete(key);
		}, IDLE_TTL_MS);
		entry.idleTimer.unref();
	};
}

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function resolveWebSocketUrl(input: string | URL | Request): string {
	const url = new URL(requestUrl(input));
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`Unsupported WebSocket protocol: ${url.protocol}`);
	}
	return url.toString();
}

function requestHeaders(
	input: string | URL | Request,
	init: RequestInit | undefined,
	beta: string,
	requestId: string,
): Record<string, string> {
	const source = new Headers(input instanceof Request ? input.headers : undefined);
	for (const [key, value] of new Headers(init?.headers)) source.set(key, value);
	const authorization = source.get("authorization");
	if (!authorization) throw new Error("Responses WebSocket requires an Authorization header");
	return {
		Authorization: authorization,
		"User-Agent": PI_USER_AGENT,
		"OpenAI-Beta": beta,
		"x-client-request-id": requestId,
		"session-id": requestId,
	};
}

async function parseRequestBody(
	input: string | URL | Request,
	body: BodyInit | null | undefined,
): Promise<RequestBody> {
	let text: string;
	if (body === undefined && input instanceof Request) text = await input.clone().text();
	else if (typeof body === "string") text = body;
	else if (body instanceof URLSearchParams) text = body.toString();
	else if (body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
	else if (ArrayBuffer.isView(body)) text = new TextDecoder().decode(body);
	else throw new Error("Responses WebSocket requires a JSON request body");

	const parsed = JSON.parse(text) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Responses WebSocket request body must be a JSON object");
	}
	return parsed as RequestBody;
}

function normalizeRequestBody(body: RequestBody): RequestBody {
	const input = Array.isArray(body.input) ? [...body.input] : [];
	const first = input[0] as { role?: unknown; content?: unknown } | undefined;
	const hasInstructions =
		first !== undefined &&
		(first.role === "developer" || first.role === "system") &&
		typeof first.content === "string";
	const instructions = hasInstructions ? (first.content as string) : "You are a helpful assistant.";
	if (hasInstructions) input.shift();

	const reasoning = body.reasoning as { effort?: unknown; summary?: unknown } | undefined;
	if (reasoning?.effort === "none" && reasoning.summary === undefined) delete body.reasoning;
	else if (reasoning && reasoning.summary === undefined) body.reasoning = { ...reasoning, summary: "auto" };

	const tools = Array.isArray(body.tools)
		? body.tools.map((tool) => {
				if (!tool || typeof tool !== "object") return tool;
				const value = tool as Record<string, unknown>;
				return value.type === "function" && value.strict !== true ? { ...value, strict: null } : tool;
			})
		: body.tools;

	delete body.max_output_tokens;
	delete body.prompt_cache_retention;
	delete body.prompt_cache_options;
	delete body.background;
	return {
		...body,
		store: false,
		stream: true,
		instructions,
		input,
		...(tools === undefined ? {} : { tools }),
		text: { verbosity: "low", ...(body.text as Record<string, unknown> | undefined) },
		include: ["reasoning.encrypted_content"],
		tool_choice: body.tool_choice ?? "auto",
		parallel_tool_calls: true,
	};
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const {
		input: _input,
		previous_response_id: _previousResponseId,
		context_management: _contextManagement,
		...rest
	} = body;
	return rest;
}

function getInputDelta(body: RequestBody, continuation: ContinuationState): unknown[] | undefined {
	if (!isDeepStrictEqual(requestBodyWithoutInput(body), requestBodyWithoutInput(continuation.lastRequestBody))) {
		return undefined;
	}
	const input = body.input ?? [];
	const replayedResponseItems = continuation.lastResponseItems.filter(
		(item) => !item || typeof item !== "object" || (item as Record<string, unknown>).type !== "compaction",
	);
	const previousInput = (continuation.lastRequestBody.input ?? []).filter(
		(item) => !item || typeof item !== "object" || (item as Record<string, unknown>).type !== "compaction_trigger",
	);
	const baseline = [...previousInput, ...replayedResponseItems];
	if (input.length < baseline.length || !isDeepStrictEqual(input.slice(0, baseline.length), baseline)) return undefined;
	return input.slice(baseline.length);
}

function buildCachedRequestBody(entry: CachedConnection, body: RequestBody): RequestBody {
	if (!entry.continuation) return body;
	const delta = getInputDelta(body, entry.continuation);
	if (!delta) {
		entry.continuation = undefined;
		return body;
	}
	return {
		...body,
		previous_response_id: entry.continuation.lastResponseId,
		input: delta,
	};
}

function normalizeResponseItem(item: unknown): unknown {
	if (!item || typeof item !== "object") return item;
	const value = item as Record<string, unknown>;
	if (value.type === "message") {
		const content = Array.isArray(value.content)
			? value.content.map((part) => {
					if (!part || typeof part !== "object") return part;
					const p = part as Record<string, unknown>;
					return p.type === "output_text"
						? { type: "output_text", text: p.text, annotations: p.annotations ?? [] }
						: p.type === "refusal"
							? { type: "refusal", refusal: p.refusal }
							: part;
				})
			: [];
		return {
			type: "message",
			role: "assistant",
			content,
			status: value.status,
			id: value.id,
			...(value.phase === undefined ? {} : { phase: value.phase }),
		};
	}
	if (value.type === "function_call") {
		return {
			type: "function_call",
			id: value.id,
			call_id: value.call_id,
			name: value.name,
			arguments: value.arguments,
			...(value.namespace === undefined ? {} : { namespace: value.namespace }),
		};
	}
	if (value.type === "custom_tool_call") {
		return {
			type: "custom_tool_call",
			id: value.id,
			call_id: value.call_id,
			name: value.name,
			input: value.input,
			...(value.namespace === undefined ? {} : { namespace: value.namespace }),
		};
	}
	return item;
}

function eventError(event: Record<string, unknown>): WebSocketApiError {
	const response =
		event.response && typeof event.response === "object" ? (event.response as Record<string, unknown>) : undefined;
	const source = event.error ?? response?.error;
	const nested = source && typeof source === "object" ? (source as Record<string, unknown>) : undefined;
	const code = typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined;
	const message =
		typeof event.message === "string"
			? event.message
			: typeof nested?.message === "string"
				? nested.message
				: code || "Responses WebSocket API error";
	return new WebSocketApiError(message, code);
}

async function decodeMessage(data: unknown): Promise<string> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
	if (data && typeof data === "object" && "text" in data && typeof data.text === "function") {
		return data.text();
	}
	throw new Error("Unsupported WebSocket message type");
}

async function createEventStreamResponse(
	connection: AcquiredConnection,
	fullBody: RequestBody,
	requestBody: RequestBody,
	useCachedContext: boolean,
	signal?: AbortSignal,
): Promise<Response> {
	const encoder = new TextEncoder();
	const responseItems: unknown[] = [];
	let responseId: string | undefined;
	let cancelStream: (() => void) | undefined;
	let responseStarted = false;
	let resolveFirstResponseEvent: (() => void) | undefined;
	let rejectFirstResponseEvent: ((error: Error) => void) | undefined;
	const firstResponseEvent = new Promise<void>((resolve, reject) => {
		resolveFirstResponseEvent = resolve;
		rejectFirstResponseEvent = reject;
	});
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let settled = false;
			let processing = Promise.resolve();

			const cleanup = () => {
				connection.socket.removeEventListener("message", onMessage);
				connection.socket.removeEventListener("error", onError);
				connection.socket.removeEventListener("close", onClose);
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = (keep: boolean) => {
				if (settled) return;
				settled = true;
				cleanup();
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
				connection.release(keep);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (connection.entry) connection.entry.continuation = undefined;
				controller.error(error);
				connection.release(false);
				if (!responseStarted) rejectFirstResponseEvent?.(error);
			};
			const onMessage = (event: UndiciMessageEvent) => {
				processing = processing
					.then(async () => {
						if (settled) return;
						const text = await decodeMessage(event.data);
						const parsed = JSON.parse(text) as Record<string, unknown>;
						if (!parsed || typeof parsed.type !== "string") throw new Error("Invalid WebSocket event");
						let type = parsed.type;
						if (type === "response.done") {
							type = "response.completed";
							parsed.type = type;
						}

						const error = type === "error" || type === "response.failed" ? eventError(parsed) : undefined;
						if (type === "error" && error) {
							parsed.code ??= error.code;
							parsed.message ??= error.message;
						}
						if (
							error &&
							(error.code === PREVIOUS_RESPONSE_NOT_FOUND || error.code === CONNECTION_LIMIT_REACHED) &&
							!responseStarted
						) {
							fail(error);
							return;
						}

						if (type === "response.output_item.done") {
							responseItems.push(normalizeResponseItem(parsed.item));
						}
						const response =
							parsed.response && typeof parsed.response === "object"
								? (parsed.response as Record<string, unknown>)
								: undefined;
						if (typeof response?.id === "string") responseId = response.id;
						const responseOutput = response?.output;
						if (responseItems.length === 0 && Array.isArray(responseOutput)) {
							responseItems.push(...responseOutput.map(normalizeResponseItem));
						}

						controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
						if (!responseStarted && (type.startsWith("response.") || type === "error")) {
							responseStarted = true;
							resolveFirstResponseEvent?.();
						}
						if (TERMINAL_EVENTS.has(type)) {
							const successful = type === "response.completed" || type === "response.incomplete";
							if (successful && useCachedContext && connection.entry && responseId) {
								connection.entry.continuation = {
									lastRequestBody: fullBody,
									lastResponseId: responseId,
									lastResponseItems: responseItems,
								};
							}
							finish(successful);
						}
					})
					.catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
			};
			const failAfterMessages = (error: Error) => {
				processing = processing.then(() => fail(error));
			};
			const onError = (event: Event) => failAfterMessages(new Error(errorMessage(event, "WebSocket error")));
			const onClose = (event: Event) =>
				failAfterMessages(new Error(errorMessage(event, "WebSocket closed before completion")));
			const onAbort = () => fail(new Error("Request was aborted"));
			cancelStream = onAbort;

			connection.socket.addEventListener("message", onMessage);
			connection.socket.addEventListener("error", onError);
			connection.socket.addEventListener("close", onClose);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				onAbort();
				return;
			}
			try {
				connection.socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		},
		cancel() {
			cancelStream?.();
		},
	});

	await firstResponseEvent;
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function fallbackRequest(init: RequestInit | undefined, body: RequestBody): RequestInit {
	const headers = new Headers(init?.headers);
	headers.delete("content-length");
	headers.set("User-Agent", PI_USER_AGENT);
	return { ...init, headers, body: JSON.stringify(body) };
}

function createWebSocketFetch(
	config: TransportConfig,
	model: Model<typeof API>,
	options?: StreamOptions,
): typeof globalThis.fetch {
	const fallbackFetch = options?.fetch ?? globalThis.fetch.bind(globalThis);
	const transport = options?.transport ?? "auto";

	return async (input, init) => {
		const signal = init?.signal ?? (input instanceof Request ? input.signal : options?.signal);
		const url = resolveWebSocketUrl(input);
		const requestId = options?.sessionId ? Array.from(options.sessionId).slice(0, 64).join("") : randomUUID();
		const headers = requestHeaders(input, init, config.beta, requestId);
		let fullBody = normalizeRequestBody(await parseRequestBody(input, init?.body));
		const replacement = await options?.onPayload?.(fullBody, model);
		if (replacement !== undefined) {
			if (!replacement || typeof replacement !== "object" || Array.isArray(replacement)) {
				throw new Error("Responses WebSocket payload replacement must be an object");
			}
			fullBody = replacement as RequestBody;
		}
		const fallbackInit = fallbackRequest(init, fullBody);
		const sessionFallback =
			transport === "auto" && options?.sessionId !== undefined && sseFallbackSessions.has(options.sessionId);
		if (transport === "sse" || sessionFallback) {
			if (process.env.PI_RESPONSE_WS_DEBUG === "1") {
				console.error("[custom-response-ws] using SSE", {
					reason: transport === "sse" ? "configured" : "session_fallback",
				});
			}
			return fallbackFetch(input, fallbackInit);
		}

		const useCachedContext = transport === "auto" || transport === "websocket-cached";
		let autoWebSocketRetries = 0;
		let retriedMissingContinuation = false;
		let retriedConnectionLimit = false;

		while (true) {
			let connection: AcquiredConnection | undefined;
			try {
				connection = await acquireConnection(
					url,
					headers,
					options?.sessionId,
					signal,
					options?.websocketConnectTimeoutMs,
				);
				if (!useCachedContext && connection.entry) connection.entry.continuation = undefined;
				const requestBody =
					useCachedContext && connection.entry ? buildCachedRequestBody(connection.entry, fullBody) : fullBody;
				const response = await createEventStreamResponse(connection, fullBody, requestBody, useCachedContext, signal);
				if (options?.sessionId) sseFallbackSessions.delete(options.sessionId);
				return response;
			} catch (error) {
				connection?.release(false);
				if (process.env.PI_RESPONSE_WS_DEBUG === "1") {
					console.error("[custom-response-ws] transport error", {
						transport,
						message: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
						code: error instanceof WebSocketApiError ? error.code : undefined,
					});
				}
				if (signal?.aborted) throw error;
				if (
					error instanceof WebSocketApiError &&
					error.code === PREVIOUS_RESPONSE_NOT_FOUND &&
					!retriedMissingContinuation
				) {
					retriedMissingContinuation = true;
					continue;
				}
				if (
					error instanceof WebSocketApiError &&
					error.code === CONNECTION_LIMIT_REACHED &&
					!retriedConnectionLimit
				) {
					retriedConnectionLimit = true;
					continue;
				}
				if (error instanceof WebSocketApiError || transport !== "auto") throw error;
				if (autoWebSocketRetries < MAX_AUTO_WEBSOCKET_RETRIES) {
					autoWebSocketRetries++;
					continue;
				}
				if (options?.sessionId) sseFallbackSessions.add(options.sessionId);
				return fallbackFetch(input, fallbackInit);
			}
		}
	};
}

export default function (_pi: ExtensionAPI): void {
	const config = { beta: DEFAULT_BETA };
	registerApiProvider<typeof API, OpenAIResponsesOptions>({
		api: API,
		stream: (model, context, options) => {
			const responsesModel = model as unknown as Model<"openai-responses">;
			return streamOpenAIResponses(responsesModel, context, {
				...options,
				onPayload: undefined,
				fetch: createWebSocketFetch(config, model, options),
			});
		},
		streamSimple: (model, context, options) => {
			const responsesModel = model as unknown as Model<"openai-responses">;
			return streamSimpleOpenAIResponses(responsesModel, context, {
				...options,
				onPayload: undefined,
				fetch: createWebSocketFetch(config, model, options),
			});
		},
	});
}
