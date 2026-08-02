export type ResponsesCompatibleRequestPayload = {
	model: string;
	input: unknown[];
	instructions?: unknown;
	[key: string]: unknown;
};

export function isResponsesCompatiblePayload(payload: unknown): payload is ResponsesCompatibleRequestPayload {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return false;
	}

	const candidate = payload as Record<string, unknown>;
	return typeof candidate.model === "string" && Array.isArray(candidate.input);
}

export type ChatCompatiblePayload = {
	model: string;
	messages: unknown[];
	[key: string]: unknown;
};

export function isChatCompatiblePayload(payload: unknown): payload is ChatCompatiblePayload {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return false;
	}

	const candidate = payload as Record<string, unknown>;
	return typeof candidate.model === "string" && Array.isArray(candidate.messages);
}

export type AnthropicCompatiblePayload = {
	model: string;
	messages: unknown[];
	system?: unknown;
	[key: string]: unknown;
};

function hasAnthropicContentBlock(messages: unknown[]): boolean {
	return messages.some((message) => {
		if (!message || typeof message !== "object" || Array.isArray(message)) return false;
		const content = (message as Record<string, unknown>).content;
		if (!Array.isArray(content)) return false;
		return content.some((block) => {
			if (!block || typeof block !== "object" || Array.isArray(block)) return false;
			const type = (block as Record<string, unknown>).type;
			return type === "tool_use" || type === "tool_result" || type === "image" || type === "thinking" || type === "redacted_thinking";
		});
	});
}

export function isAnthropicCompatiblePayload(payload: unknown): payload is AnthropicCompatiblePayload {
	if (!isChatCompatiblePayload(payload)) return false;
	const candidate = payload as ChatCompatiblePayload;
	return (
		Object.prototype.hasOwnProperty.call(candidate, "system") ||
		Object.prototype.hasOwnProperty.call(candidate, "anthropic_version") ||
		hasAnthropicContentBlock(candidate.messages)
	);
}

export function normalizeBaseUrl(baseUrl: string | undefined | null): string | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	return normalized ? normalized : undefined;
}

export function buildCompactUrl(url: string): string {
	const normalized = normalizeBaseUrl(url) ?? url;
	if (normalized.endsWith("/responses/compact")) {
		return normalized;
	}
	if (normalized.endsWith("/responses")) {
		return `${normalized}/compact`;
	}
	if (normalized.endsWith("/v1")) {
		return `${normalized}/responses/compact`;
	}
	return `${normalized}/v1/responses/compact`;
}
