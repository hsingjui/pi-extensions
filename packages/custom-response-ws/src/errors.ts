export class WebSocketApiError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "WebSocketApiError";
		this.code = code;
	}
}

export function errorMessage(value: unknown, fallback: string): string {
	if (value && typeof value === "object") {
		const event = value as { error?: unknown; message?: unknown; code?: unknown; reason?: unknown };
		if (event.error instanceof Error) return event.error.message;
		if (typeof event.message === "string" && event.message) return event.message;
		if (typeof event.reason === "string" && event.reason) return event.reason;
		if (typeof event.code === "number" && event.code) return `${fallback} (${event.code})`;
	}
	return fallback;
}

export function eventError(event: Record<string, unknown>): WebSocketApiError {
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