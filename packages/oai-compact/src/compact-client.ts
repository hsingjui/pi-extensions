import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { NativeCompactionRequestBody } from "./serializer.js";

const JSON_CONTENT_TYPE = "application/json";

export type CompactClientConfig = {
	compactUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	proxy?: string;
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

function createDispatcher(proxy: string | undefined): ProxyAgent | undefined {
	const normalized = proxy?.trim();
	return normalized ? new ProxyAgent(normalized) : undefined;
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

	if (config.apiKey && !hasHeader(config.headers, "authorization")) {
		headers.authorization = `Bearer ${config.apiKey}`;
	}

	return headers;
}

function buildResponsesUrl(compactUrl: string): string {
	return compactUrl.endsWith("/compact") ? compactUrl.slice(0, -"/compact".length) : compactUrl;
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

	const dispatcher = createDispatcher(config.proxy);

	try {
		const response = await undiciFetch(config.compactUrl, {
			dispatcher,
			method: "POST",
			headers: createJsonRequestHeaders(config),
			body: JSON.stringify(request),
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

		if (!isCompactResponseEnvelope(responseJson)) {
			return {
				ok: false,
				reason: "malformed-response",
				status: response.status,
				responseJson,
			};
		}

		if (responseJson.output.length === 0) {
			return {
				ok: false,
				reason: "empty-output",
				status: response.status,
				responseJson,
			};
		}

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
	} finally {
		dispatcher?.close();
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

	const dispatcher = createDispatcher(config.proxy);

	try {
		const response = await undiciFetch(buildResponsesUrl(config.compactUrl), {
			dispatcher,
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
	} finally {
		dispatcher?.close();
	}
}
