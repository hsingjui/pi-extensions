import { CONNECTION_LIMIT_REACHED, PREVIOUS_RESPONSE_NOT_FOUND, TERMINAL_EVENTS } from "./constants.js";
import { decodeMessage } from "./connection.js";
import { errorMessage, eventError } from "./errors.js";
import { normalizeResponseItem } from "./request.js";
import type { AcquiredConnection, RequestBody, WebSocketListener } from "./types.js";

export async function createEventStreamResponse(
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
			const onMessage: WebSocketListener = (event) => {
				processing = processing
					.then(async () => {
						if (settled) return;
						if (!event || typeof event !== "object" || !("data" in event)) return;
						const text = await decodeMessage((event as { data?: unknown }).data);
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
			const onError: WebSocketListener = (event) => failAfterMessages(new Error(errorMessage(event, "WebSocket error")));
			const onClose: WebSocketListener = (event) =>
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