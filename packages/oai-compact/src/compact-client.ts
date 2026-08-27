import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { NativeCompactionRequestBody } from "./serializer.js";

const CODEX_USER_AGENT = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream";
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";
const NATIVE_COMPACTION_MAX_RETRIES = 3;
const NATIVE_COMPACTION_RETRY_BASE_DELAY_MS = 1000;

export type CompactClientConfig = {
	compactUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
};

type CompactResponseEnvelope = {
	id?: string;
	created_at?: number | string;
	output: unknown[];
	[key: string]: unknown;
};

export type NativeCompactionClientFailureReason =
	| "aborted"
	| "network-error"
	| "non-2xx"
	| "empty-body"
	| "invalid-json"
	| "upstream-error"
	| "malformed-response"
	| "empty-output";

export type NativeCompactionClientSuccess = {
	ok: true;
	status: number;
	compactedWindow: unknown[];
	compactResponseId?: string;
	createdAt?: string;
	response: CompactResponseEnvelope;
};

export type NativeCompactionClientFailure = {
	ok: false;
	reason: NativeCompactionClientFailureReason;
	status?: number;
	errorMessage?: string;
	responseText?: string;
	responseJson?: unknown;
};

export type NativeCompactionClientResult = NativeCompactionClientSuccess | NativeCompactionClientFailure;

export type PortableSummaryClientSuccess = {
	ok: true;
	status: number;
	summary: string;
	responseId?: string;
	response: Record<string, unknown>;
};

export type PortableSummaryClientFailure = {
	ok: false;
	reason: NativeCompactionClientFailureReason | "empty-summary";
	status?: number;
	errorMessage?: string;
	responseText?: string;
	responseJson?: unknown;
};

export type PortableSummaryClientResult = PortableSummaryClientSuccess | PortableSummaryClientFailure;

const PORTABLE_SUMMARY_PROMPT = `Create a portable plaintext compaction summary of the conversation state above.

This summary will be sent to other chat APIs that cannot read OpenAI encrypted compaction items. Preserve:
- user goals and explicit instructions
- important decisions and constraints
- files read, edited, or created
- tool results and current working state
- unresolved tasks and next steps

Do not continue the conversation. Do not answer the user's last request. Output only the summary.`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && (error.name === "AbortError" || error.name === "ABORT_ERR"))
	);
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

async function waitBeforeRetry(attempt: number, signal?: AbortSignal): Promise<boolean> {
	try {
		await sleep(NATIVE_COMPACTION_RETRY_BASE_DELAY_MS * 2 ** attempt, undefined, { signal });
		return true;
	} catch (error) {
		return !(signal?.aborted || isAbortError(error));
	}
}

function normalizeResponseTimestamp(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
		return new Date(milliseconds).toISOString();
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? trimmed : new Date(parsed).toISOString();
}

function isCompactOutputItem(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}

function isCompactResponseEnvelope(value: unknown): value is CompactResponseEnvelope {
	return isRecord(value) && Array.isArray(value.output) && value.output.every(isCompactOutputItem);
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
	const target = name.toLowerCase();
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === target);
}

function createJsonRequestHeaders(config: CompactClientConfig): Record<string, string> {
	const headers: Record<string, string> = {
		accept: JSON_CONTENT_TYPE,
		"content-type": JSON_CONTENT_TYPE,
		...config.headers,
	};

	if (!hasHeader(config.headers, "user-agent")) {
		headers["user-agent"] = CODEX_USER_AGENT;
	}

	if (config.apiKey && !hasHeader(config.headers, "authorization")) {
		headers.authorization = `Bearer ${config.apiKey}`;
	}

	return headers;
}

function buildResponsesUrl(compactUrl: string): string {
	return compactUrl.endsWith("/compact") ? compactUrl.slice(0, -"/compact".length) : compactUrl;
}

function setHeader(headers: Record<string, string>, name: string, value: string) {
	const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
	headers[existing ?? name] = value;
}

function createRemoteCompactionHeaders(config: CompactClientConfig): Record<string, string> {
	const headers = createJsonRequestHeaders(config);
	setHeader(headers, "accept", SSE_CONTENT_TYPE);

	const existing = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-codex-beta-features");
	const features = existing?.[1].split(",").map((value) => value.trim()).filter(Boolean) ?? [];
	if (!features.includes(REMOTE_COMPACTION_V2_FEATURE)) {
		features.push(REMOTE_COMPACTION_V2_FEATURE);
	}
	setHeader(headers, "x-codex-beta-features", features.join(","));
	return headers;
}

type ParsedCompactionResponse =
	| { ok: true; response: CompactResponseEnvelope }
	| {
		ok: false;
		reason: "invalid-json" | "upstream-error" | "malformed-response" | "empty-output";
		errorMessage?: string;
		responseJson?: unknown;
	};

function extractErrorMessage(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const candidate of [value.error, value.response]) {
		if (isRecord(candidate)) {
			const nested = extractErrorMessage(candidate);
			if (nested) return nested;
		}
	}
	return typeof value.message === "string" && value.message.trim() ? value.message.trim() : undefined;
}

function parseSseEvents(responseText: string): unknown[] | undefined {
	const events: unknown[] = [];
	for (const frame of responseText.replace(/\r\n/g, "\n").split(/\n\n+/)) {
		const data = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice("data:".length).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") continue;
		try {
			events.push(JSON.parse(data));
		} catch {
			return undefined;
		}
	}
	return events.length > 0 ? events : undefined;
}

function parseCompactionResponse(responseText: string): ParsedCompactionResponse {
	try {
		const responseJson: unknown = JSON.parse(responseText);
		if (!isCompactResponseEnvelope(responseJson)) {
			return { ok: false, reason: "malformed-response", responseJson };
		}
		if (responseJson.output.length === 0) {
			return { ok: false, reason: "empty-output", responseJson };
		}
		return { ok: true, response: responseJson };
	} catch {
		// Remote compaction v2 returns Responses SSE rather than one JSON document.
	}

	const events = parseSseEvents(responseText);
	if (!events) return { ok: false, reason: "invalid-json" };

	const failed = events.find((event) => isRecord(event) && event.type === "response.failed");
	if (failed) {
		return {
			ok: false,
			reason: "upstream-error",
			errorMessage: extractErrorMessage(failed),
			responseJson: failed,
		};
	}

	const completed = [...events].reverse().find((event) => isRecord(event) && event.type === "response.completed");
	const finalResponse = isRecord(completed) && isRecord(completed.response) ? completed.response : undefined;
	const doneItems = events
		.filter((event) => isRecord(event) && event.type === "response.output_item.done" && isRecord(event.item))
		.map((event) => (event as Record<string, unknown>).item);
	const addedItems = events
		.filter((event) => isRecord(event) && event.type === "response.output_item.added" && isRecord(event.item))
		.map((event) => (event as Record<string, unknown>).item);
	const output = doneItems.length > 0
		? doneItems
		: addedItems.length > 0
			? addedItems
			: finalResponse?.output;
	if (!Array.isArray(output) || !output.every(isCompactOutputItem)) {
		return { ok: false, reason: "malformed-response", responseJson: finalResponse ?? events };
	}
	if (output.length === 0) {
		return { ok: false, reason: "empty-output", responseJson: finalResponse ?? events };
	}

	return {
		ok: true,
		response: {
			...(finalResponse ?? {}),
			output,
		},
	};
}

function extractResponseOutputText(responseJson: unknown): string | undefined {
	if (!isRecord(responseJson)) return undefined;
	if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
		return responseJson.output_text.trim();
	}

	const output = responseJson.output;
	if (!Array.isArray(output)) return undefined;

	const texts: string[] = [];
	for (const item of output) {
		if (!isRecord(item) || !Array.isArray(item.content)) continue;
		for (const content of item.content) {
			if (!isRecord(content)) continue;
			if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") {
				texts.push(content.text);
			}
		}
	}

	const summary = texts.join("\n").trim();
	return summary || undefined;
}

export async function executeNativeCompaction(args: {
	config: CompactClientConfig;
	request: NativeCompactionRequestBody;
	signal?: AbortSignal;
}): Promise<NativeCompactionClientResult> {
	const { config, request, signal } = args;

	if (signal?.aborted) {
		return {
			ok: false,
			reason: "aborted",
		};
	}

	for (let attempt = 0; ; attempt++) {
		try {
			const response = await globalThis.fetch(buildResponsesUrl(config.compactUrl), {
					method: "POST",
					headers: createRemoteCompactionHeaders(config),
					body: JSON.stringify({
						...request,
						input: [...request.input, { type: "compaction_trigger" }],
						stream: true,
					}),
					signal,
				});

				const responseText = await response.text();
				if (!response.ok) {
					if (attempt < NATIVE_COMPACTION_MAX_RETRIES && isRetryableStatus(response.status)) {
						if (!(await waitBeforeRetry(attempt, signal))) {
							return { ok: false, reason: "aborted" };
						}
						continue;
					}

					return {
						ok: false,
						reason: "non-2xx",
						status: response.status,
						errorMessage: response.statusText || `HTTP ${response.status}`,
						responseText,
					};
				}

				if (!responseText.trim()) {
					return {
						ok: false,
						reason: "empty-body",
						status: response.status,
					};
				}

				const parsed = parseCompactionResponse(responseText);
				if (!parsed.ok) {
					return {
						ok: false,
						reason: parsed.reason,
						status: response.status,
						errorMessage: parsed.errorMessage,
						responseText,
						responseJson: parsed.responseJson,
					};
				}

				const responseJson = parsed.response;
				return {
					ok: true,
					status: response.status,
					compactedWindow: [...responseJson.output],
					compactResponseId: typeof responseJson.id === "string" && responseJson.id.trim()
						? responseJson.id.trim()
						: undefined,
					createdAt: normalizeResponseTimestamp(responseJson.created_at),
					response: responseJson,
				};
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) {
				return { ok: false, reason: "aborted" };
			}

			if (attempt < NATIVE_COMPACTION_MAX_RETRIES) {
				if (!(await waitBeforeRetry(attempt, signal))) {
					return { ok: false, reason: "aborted" };
				}
				continue;
			}

			return {
				ok: false,
				reason: "network-error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

export async function executePortableCompactionSummary(args: {
	config: CompactClientConfig;
	model: string;
	compactedWindow: readonly unknown[];
	signal?: AbortSignal;
}): Promise<PortableSummaryClientResult> {
	const { config, model, compactedWindow, signal } = args;

	if (signal?.aborted) {
		return {
			ok: false,
			reason: "aborted",
		};
	}

	try {
		const response = await globalThis.fetch(buildResponsesUrl(config.compactUrl), {
			method: "POST",
			headers: createJsonRequestHeaders(config),
			body: JSON.stringify({
				model,
				input: [
					...compactedWindow,
					{
						role: "user",
						content: [{ type: "input_text", text: PORTABLE_SUMMARY_PROMPT }],
					},
				],
				store: false,
			}),
			signal,
		});

		const responseText = await response.text();
		if (!response.ok) {
			return {
				ok: false,
				reason: "non-2xx",
				status: response.status,
				errorMessage: response.statusText || `HTTP ${response.status}`,
				responseText,
			};
		}

		if (!responseText.trim()) {
			return {
				ok: false,
				reason: "empty-body",
				status: response.status,
			};
		}

		let responseJson: unknown;
		try {
			responseJson = JSON.parse(responseText);
		} catch (error) {
			return {
				ok: false,
				reason: "invalid-json",
				status: response.status,
				errorMessage: error instanceof Error ? error.message : String(error),
				responseText,
			};
		}

		const summary = extractResponseOutputText(responseJson);
		if (!summary) {
			return {
				ok: false,
				reason: "empty-summary",
				status: response.status,
				responseJson,
			};
		}

		return {
			ok: true,
			status: response.status,
			summary,
			responseId: isRecord(responseJson) && typeof responseJson.id === "string" && responseJson.id.trim()
				? responseJson.id.trim()
				: undefined,
			response: responseJson as Record<string, unknown>,
		};
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) {
			return {
				ok: false,
				reason: "aborted",
			};
		}

		return {
			ok: false,
			reason: "network-error",
			errorMessage: error instanceof Error ? error.message : String(error),
		};
	}
}
