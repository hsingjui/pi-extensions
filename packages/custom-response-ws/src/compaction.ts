import { DEFAULT_BETA, PI_USER_AGENT } from "./constants.js";
import { closeSocket, connect, decodeMessage } from "./connection.js";
import { errorMessage, eventError, WebSocketApiError } from "./errors.js";
import { authorizationHeader, normalizeRequestBody, responsesWebSocketUrl } from "./request.js";
import type { AcquiredConnection, CachedWebSocketCompactionResult, RequestBody, WebSocketListener } from "./types.js";

async function acquireStandaloneCompactionConnection(
	sessionId: string,
	url: string,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal?: AbortSignal,
): Promise<AcquiredConnection> {
	const requestId = Array.from(sessionId).slice(0, 64).join("");
	const socket = await connect(
		url,
		{
			Authorization: authorizationHeader(apiKey, headers),
			"User-Agent": PI_USER_AGENT,
			"OpenAI-Beta": DEFAULT_BETA,
			"x-client-request-id": requestId,
			"session-id": requestId,
		},
		signal,
	);
	return {
		socket,
		release: () => closeSocket(socket, 1000, "compaction_done"),
	};
}

function compactionCreatedAt(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
	}
	if (typeof value === "string" && value.trim()) {
		const trimmed = value.trim();
		const parsed = Date.parse(trimmed);
		return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
	}
	return new Date().toISOString();
}

function receiveCompaction(
	connection: AcquiredConnection,
	fullBody: RequestBody,
	signal?: AbortSignal,
): Promise<CachedWebSocketCompactionResult> {
	const { previous_response_id: _previousResponseId, ...baselineBody } = fullBody;
	const requestBody: RequestBody = {
		...baselineBody,
		input: [...(fullBody.input ?? []), { type: "compaction_trigger" }],
	};

	return new Promise((resolve, reject) => {
		const doneItems: Record<string, unknown>[] = [];
		let settled = false;
		let processing = Promise.resolve();

		const cleanup = () => {
			connection.socket.removeEventListener("message", onMessage);
			connection.socket.removeEventListener("error", onError);
			connection.socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const complete = (event: Record<string, unknown>) => {
			const response =
				event.response && typeof event.response === "object"
					? (event.response as Record<string, unknown>)
					: undefined;
			const responseOutput = Array.isArray(response?.output) ? response.output : [];
			const output = doneItems.length > 0 ? doneItems : responseOutput;
			if (
				!output.every((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
			) {
				throw new Error("Responses WebSocket compaction returned malformed output");
			}
			if (!output.some((item) => item.type === "compaction")) {
				throw new Error("Responses WebSocket compaction returned no compaction item");
			}
			const responseId = typeof response?.id === "string" && response.id.trim() ? response.id.trim() : undefined;
			if (!responseId) {
				throw new Error("Responses WebSocket compaction returned no response id");
			}
			settled = true;
			cleanup();
			resolve({
				compactedWindow: output,
				compactResponseId: responseId,
				createdAt: compactionCreatedAt(response?.created_at),
			});
		};
		const onMessage: WebSocketListener = (message) => {
			processing = processing
				.then(async () => {
					if (settled || !message || typeof message !== "object" || !("data" in message)) return;
					const event = JSON.parse(await decodeMessage((message as { data?: unknown }).data)) as unknown;
					if (!event || typeof event !== "object" || Array.isArray(event)) {
						throw new Error("Invalid Responses WebSocket event");
					}
					const parsed = event as Record<string, unknown>;
					if (typeof parsed.type !== "string") throw new Error("Invalid Responses WebSocket event");
					if (parsed.type === "error" || parsed.type === "response.failed") throw eventError(parsed);
					if (
						parsed.type === "response.output_item.done" &&
						parsed.item &&
						typeof parsed.item === "object" &&
						!Array.isArray(parsed.item)
					) {
						doneItems.push(parsed.item as Record<string, unknown>);
					}
					if (parsed.type === "response.completed" || parsed.type === "response.done") complete(parsed);
				})
				.catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
		};
		const onError: WebSocketListener = (event) => fail(new Error(errorMessage(event, "WebSocket compaction failed")));
		const onClose: WebSocketListener = (event) => {
			processing.then(() => fail(new Error(errorMessage(event, "WebSocket closed before compaction completed"))));
		};
		const onAbort = () => fail(new Error("Request was aborted"));

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
	});
}

export async function compactCachedOpenAIResponsesWebSocket(args: {
	sessionId: string;
	baseUrl: string;
	request: Record<string, unknown> & { input?: unknown[] };
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}): Promise<CachedWebSocketCompactionResult> {
	if (args.signal?.aborted) throw new Error("Request was aborted");
	const fullBody = normalizeRequestBody({
		...args.request,
		input: Array.isArray(args.request.input) ? [...args.request.input] : [],
	});
	const connection = await acquireStandaloneCompactionConnection(
		args.sessionId,
		responsesWebSocketUrl(args.baseUrl),
		args.apiKey,
		args.headers,
		args.signal,
	);
	try {
		const result = await receiveCompaction(connection, fullBody, args.signal);
		connection.release(true);
		return result;
	} catch (error) {
		connection.release(false);
		throw error;
	}
}