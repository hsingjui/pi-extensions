import { randomUUID } from "node:crypto";
import {
	getApiProvider,
	registerApiProvider,
	registerBuiltInApiProviders,
} from "@earendil-works/pi-ai/compat";
import type { Model, OpenAIResponsesOptions, StreamFunction, StreamOptions } from "@earendil-works/pi-ai";
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
	// pi 0.85.x 打包运行时的扩展加载器虚拟模块表不再包含 pi-ai 的 api/* 子路径，
	// 不能直接 import "@earendil-works/pi-ai/api/openai-responses"；
	// 改从 compat 入口取内置 openai-responses 实现后包一层 WS fetch。
	registerBuiltInApiProviders();
	const builtin = getApiProvider("openai-responses");
	if (!builtin) {
		throw new Error("built-in openai-responses api provider not registered");
	}
	// builtin.stream/streamSimple 的 options 是基类 StreamOptions，这里需要 Responses 专属的 fetch/onPayload 字段
	const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = builtin.stream;
	const streamSimpleOpenAIResponses = builtin.streamSimple as StreamFunction<"openai-responses", OpenAIResponsesOptions>;
	// 0.85.x compat 的 getApiProvider 返回 wrapStream 包装版，会校验 model.api === "openai-responses"；
	// 本插件的 model.api 是 "openai-responses-ws"，直接透传会抛 Mismatched api，改写后再交给内置实现
	const rewriteApi = (model: Model<typeof API>): Model<"openai-responses"> =>
		({ ...model, api: "openai-responses" }) as unknown as Model<"openai-responses">;
	registerApiProvider<typeof API, OpenAIResponsesOptions>({
		api: API,
		stream: (model, context, options) => {
			return streamOpenAIResponses(rewriteApi(model), context, {
				...options,
				onPayload: undefined,
				fetch: createWebSocketFetch(config, model, options as StreamOptions | undefined),
			});
		},
		streamSimple: (model, context, options) => {
			return streamSimpleOpenAIResponses(rewriteApi(model), context, {
				...options,
				onPayload: undefined,
				fetch: createWebSocketFetch(config, model, options as StreamOptions | undefined),
			});
		},
	});
}

export { compactCachedOpenAIResponsesWebSocket } from "./compaction.js";
export type { CachedWebSocketCompactionResult } from "./types.js";