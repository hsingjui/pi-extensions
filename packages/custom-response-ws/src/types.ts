export type WebSocketEventType = "open" | "message" | "error" | "close";
export type WebSocketListener = (event: unknown) => void;

export interface Socket {
	readonly readyState?: number;
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

export type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => Socket;
export type RequestBody = Record<string, unknown> & {
	input?: unknown[];
	previous_response_id?: string;
};

export interface ContinuationState {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: unknown[];
}

export interface CachedConnection {
	socket: Socket;
	sessionId: string;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: ContinuationState;
}

export interface AcquiredConnection {
	socket: Socket;
	entry?: CachedConnection;
	release(keep: boolean): void;
}

export interface TransportConfig {
	beta: string;
}

export interface CachedWebSocketCompactionResult {
	compactedWindow: Record<string, unknown>[];
	compactResponseId: string;
	createdAt: string;
}