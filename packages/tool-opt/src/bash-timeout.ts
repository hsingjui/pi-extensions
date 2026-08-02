import {
	isToolCallEventType,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

/** Default bash timeout in seconds when the model omits `timeout`. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 30;

/**
 * Inject a default bash timeout when the model does not provide one.
 * Explicit model-provided timeouts are left unchanged.
 */
export function registerBashDefaultTimeout(
	pi: ExtensionAPI,
	timeoutSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS,
): void {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (event.input.timeout !== undefined) return;
		event.input.timeout = timeoutSeconds;
	});
}
