import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { DEFAULT_CONNECT_TIMEOUT_MS, IDLE_TTL_MS, MAX_CONNECTION_AGE_MS } from "./constants.js";
import { errorMessage } from "./errors.js";
import type { AcquiredConnection, CachedConnection, Socket, WebSocketListener } from "./types.js";

export const connectionCache = new Map<string, CachedConnection>();
export const sseFallbackSessions = new Set<string>();

export function closeSocket(socket: Socket, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

export function closeConnections(sessionId?: string): void {
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

function getWebSocketConstructor(): new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => Socket {
	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") {
		throw new Error("WebSocket transport is not available in this runtime");
	}
	return ctor as new (
		url: string,
		protocols?: string | string[] | { headers?: Record<string, string> },
	) => Socket;
}

export async function connect(
	url: string,
	headers: Record<string, string>,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<Socket> {
	if (signal?.aborted) throw new Error("Request was aborted");

	return new Promise<Socket>((resolve, reject) => {
		const WebSocketCtor = getWebSocketConstructor();
		const socket = new WebSocketCtor(url, { headers });
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
		const onError: WebSocketListener = (event) => fail(new Error(errorMessage(event, "WebSocket connection failed")));
		const onClose: WebSocketListener = (event) => fail(new Error(errorMessage(event, "WebSocket closed while connecting")));
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

export async function decodeMessage(data: unknown): Promise<string> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
	if (data && typeof data === "object" && "text" in data && typeof data.text === "function") {
		return data.text();
	}
	throw new Error("Unsupported WebSocket message type");
}

export function isOpen(socket: Socket): boolean {
	return socket.readyState === undefined || socket.readyState === 1;
}

export function isExpired(entry: CachedConnection): boolean {
	return Date.now() - entry.createdAt >= MAX_CONNECTION_AGE_MS;
}

export function connectionKey(sessionId: string, url: string): string {
	return `${sessionId}\n${url}`;
}

export async function acquireConnection(
	url: string,
	headers: Record<string, string>,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): Promise<AcquiredConnection> {
	const key = sessionId ? connectionKey(sessionId, url) : undefined;
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

export function createRelease(key: string, entry: CachedConnection): (keep: boolean) => void {
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