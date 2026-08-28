import os from "node:os";

export const API = "openai-responses-ws";
export const PI_USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
export const DEFAULT_BETA = "responses_websockets=2026-02-06";
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const MAX_AUTO_WEBSOCKET_RETRIES = 3;
export const IDLE_TTL_MS = 5 * 60 * 1000;
export const MAX_CONNECTION_AGE_MS = 55 * 60 * 1000;
export const PREVIOUS_RESPONSE_NOT_FOUND = "previous_response_not_found";
export const CONNECTION_LIMIT_REACHED = "websocket_connection_limit_reached";
export const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);