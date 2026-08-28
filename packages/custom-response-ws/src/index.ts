import { randomUUID } from "node:crypto";
import {
	stream as streamOpenAIResponses,
	streamSimple as streamSimpleOpenAIResponses,
	type OpenAIResponsesOptions,
} from "@earendil-works/pi-ai/api/openai-responses";
import type { Model, StreamOptions } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireConnection, sseFallbackSessions } from "./connection.js";
import {
	API,
	CONNECTION_LIMIT_REACHED,
	DEFAULT_BETA,
	MAX_AUTO_WEBSOCKET_RETRIES,
	PREVIOUS_RESPONSE_NOT_FOUND,
} from "./constants.js";
import { WebSocketApiError } from "./errors.js";
import {
	buildCachedRequestBody,
	fallbackRequest,
	normalizeRequestBody,
	parseRequestBody,
	requestHeaders,
	resolveWebSocketUrl,
} from "./request.js";
import { createEventStreamResponse } from "./stream.js";
import type { AcquiredConnection, RequestBody, TransportConfig } from "./types.js";

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

export { compactCachedOpenAIResponsesWebSocket } from "./compaction.js";
export type { CachedWebSocketCompactionResult } from "./types.js";