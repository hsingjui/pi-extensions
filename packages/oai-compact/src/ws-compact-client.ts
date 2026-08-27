import os from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import { type MessageEvent as UndiciMessageEvent, WebSocket } from "undici";
import type { NativeCompactionRequestBody } from "./serializer.js";

const API = "openai-responses-ws";
const PI_USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
const WEBSOCKET_BETA = "responses_websockets=2026-02-06";
const CONNECT_TIMEOUT_MS = 15_000;

type Socket = InstanceType<typeof WebSocket>;

export interface WebSocketCompactionResult {
	compactedWindow: Record<string, unknown>[];
	compactResponseId?: string;
	createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function responsesWebSocketUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	if (!url.pathname.endsWith("/responses")) {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/responses`;
	}
	if (url.protocol === "http:") url.protocol = "ws:";
	else if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error(`Unsupported WebSocket protocol: ${url.protocol}`);
	}
	return url.toString();
}

function authorizationHeader(apiKey?: string, headers?: Record<string, string>): string {
	const configured = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "authorization")?.[1];
	if (configured) return configured;
	if (!apiKey) throw new Error("Responses WebSocket compaction requires an API key");
	return /^Bearer\s/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`;
}

function eventError(event: Record<string, unknown>): Error {
	const response = isRecord(event.response) ? event.response : undefined;
	const source = event.error ?? response?.error;
	const nested = isRecord(source) ? source : undefined;
	const message =
		typeof event.message === "string"
			? event.message
			: typeof nested?.message === "string"
				? nested.message
				: "Responses WebSocket compaction failed";
	return new Error(message);
}

function socketError(event: Event, fallback: string): Error {
	const value = event as Event & { message?: unknown; reason?: unknown; code?: unknown };
	if (typeof value.message === "string" && value.message) return new Error(value.message);
	if (typeof value.reason === "string" && value.reason) return new Error(value.reason);
	return new Error(typeof value.code === "number" && value.code ? `${fallback} (${value.code})` : fallback);
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

function connect(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Socket> {
	if (signal?.aborted) return Promise.reject(new Error("Request was aborted"));

	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers });
		const timer = setTimeout(() => fail(new Error(`WebSocket connection timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
		let settled = false;

		const cleanup = () => {
			clearTimeout(timer);
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			try {
				socket.close(1000, "connect_failed");
			} catch {}
			reject(error);
		};
		const onOpen = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError = (event: Event) => fail(socketError(event, "WebSocket connection failed"));
		const onClose = (event: Event) => fail(socketError(event, "WebSocket closed while connecting"));
		const onAbort = () => fail(new Error("Request was aborted"));

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeRequestBody(request: NativeCompactionRequestBody): NativeCompactionRequestBody {
	const body = { ...request };
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
				if (!isRecord(tool)) return tool;
				return tool.type === "function" && tool.strict !== true ? { ...tool, strict: null } : tool;
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
		text: { verbosity: "low", ...(isRecord(body.text) ? body.text : {}) },
		include: ["reasoning.encrypted_content"],
		tool_choice: body.tool_choice ?? "auto",
		parallel_tool_calls: true,
	};
}

function receiveCompaction(
	socket: Socket,
	request: NativeCompactionRequestBody,
	signal?: AbortSignal,
): Promise<WebSocketCompactionResult> {
	return new Promise((resolve, reject) => {
		const body = normalizeRequestBody(request);
		const doneItems: Record<string, unknown>[] = [];
		let settled = false;
		let processing = Promise.resolve();

		const cleanup = () => {
			socket.removeEventListener("message", onMessage);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const complete = (event: Record<string, unknown>) => {
			const response = isRecord(event.response) ? event.response : undefined;
			const responseOutput = Array.isArray(response?.output) ? response.output : [];
			const output = doneItems.length > 0 ? doneItems : responseOutput;
			if (!output.every(isRecord)) throw new Error("Responses WebSocket compaction returned malformed output");
			if (!output.some((item) => item.type === "compaction")) {
				throw new Error("Responses WebSocket compaction returned no compaction item");
			}

			const createdAt = response?.created_at;
			settled = true;
			cleanup();
			resolve({
				compactedWindow: output,
				compactResponseId: typeof response?.id === "string" ? response.id : undefined,
				createdAt:
					typeof createdAt === "number" && Number.isFinite(createdAt)
						? new Date(createdAt * 1000).toISOString()
						: new Date().toISOString(),
			});
		};
		const onMessage = (message: UndiciMessageEvent) => {
			processing = processing
				.then(async () => {
					if (settled) return;
					const event = JSON.parse(await decodeMessage(message.data)) as unknown;
					if (!isRecord(event) || typeof event.type !== "string") {
						throw new Error("Invalid Responses WebSocket event");
					}
					if (event.type === "error" || event.type === "response.failed") throw eventError(event);
					if (event.type === "response.output_item.done" && isRecord(event.item)) doneItems.push(event.item);
					if (event.type === "response.completed" || event.type === "response.done") complete(event);
				})
				.catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
		};
		const onError = (event: Event) => fail(socketError(event, "WebSocket response failed"));
		const onClose = (event: Event) => {
			processing.then(() => fail(socketError(event, "WebSocket closed before compaction completed")));
		};
		const onAbort = () => fail(new Error("Request was aborted"));

		socket.addEventListener("message", onMessage);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}

		try {
			socket.send(JSON.stringify({
				type: "response.create",
				...body,
				input: [...body.input, { type: "compaction_trigger" }],
			}));
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

export async function compactOpenAIResponsesWebSocket(args: {
	model: Model<typeof API>;
	request: NativeCompactionRequestBody;
	sessionId: string;
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}): Promise<WebSocketCompactionResult> {
	const requestId = Array.from(args.sessionId).slice(0, 64).join("");
	const socket = await connect(
		responsesWebSocketUrl(args.model.baseUrl),
		{
			Authorization: authorizationHeader(args.apiKey, args.headers),
			"User-Agent": PI_USER_AGENT,
			"OpenAI-Beta": WEBSOCKET_BETA,
			"x-client-request-id": requestId,
			"session-id": requestId,
		},
		args.signal,
	);

	try {
		return await receiveCompaction(socket, args.request, args.signal);
	} finally {
		try {
			socket.close(1000, "compaction_done");
		} catch {}
	}
}
