// Responses API compacted window → Anthropic Messages API payload

export type AnthropicContentBlock = {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	source?: unknown;
	[key: string]: unknown;
};

export type AnthropicMessage = {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
};

export type AnthropicPayload = {
	model: string;
	messages: AnthropicMessage[];
	system?: string | AnthropicContentBlock[];
	[key: string]: unknown;
};

type ResponsesItem = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function textBlock(text: string): AnthropicContentBlock {
	return { type: "text", text };
}

function parseJsonObject(value: unknown): unknown {
	if (typeof value !== "string") return value ?? {};
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function dataUrlToAnthropicSource(url: string): unknown {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	if (match) {
		return {
			type: "base64",
			media_type: match[1],
			data: match[2],
		};
	}
	return { type: "url", url };
}

function responsesInputContentToAnthropicBlocks(content: unknown): AnthropicContentBlock[] {
	if (typeof content === "string") return [textBlock(content)];
	if (!Array.isArray(content)) return [];

	const blocks: AnthropicContentBlock[] = [];
	for (const raw of content) {
		if (!isRecord(raw)) continue;
		if (raw.type === "input_text" && typeof raw.text === "string") {
			blocks.push(textBlock(raw.text));
			continue;
		}
		if (raw.type === "input_image" && typeof raw.image_url === "string") {
			blocks.push({ type: "image", source: dataUrlToAnthropicSource(raw.image_url) });
		}
	}
	return blocks;
}

function responsesOutputContentToText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is Record<string, unknown> => isRecord(item))
		.filter((item) => item.type === "output_text")
		.map((item) => (typeof item.text === "string" ? item.text : ""))
		.join("\n");
}

function pushMessage(messages: AnthropicMessage[], role: "user" | "assistant", blocks: AnthropicContentBlock[]) {
	if (blocks.length === 0) return;
	const previous = messages[messages.length - 1];
	if (previous?.role === role && Array.isArray(previous.content)) {
		previous.content.push(...blocks);
		return;
	}
	messages.push({ role, content: blocks });
}

export function responsesItemsToAnthropicMessages(items: readonly unknown[]): AnthropicMessage[] {
	const messages: AnthropicMessage[] = [];
	let assistantBlocks: AnthropicContentBlock[] = [];

	function flushAssistant() {
		if (assistantBlocks.length === 0) return;
		pushMessage(messages, "assistant", assistantBlocks);
		assistantBlocks = [];
	}

	for (const rawItem of items) {
		const item = rawItem as ResponsesItem;
		if (!isRecord(item)) continue;

		if (item.type === "message" && item.role === "assistant") {
			const text = responsesOutputContentToText(item.content);
			if (text) assistantBlocks.push(textBlock(text));
			continue;
		}

		if (item.type === "function_call") {
			assistantBlocks.push({
				type: "tool_use",
				id: typeof item.call_id === "string" ? item.call_id : "",
				name: typeof item.name === "string" ? item.name : "",
				input: parseJsonObject(item.arguments),
			});
			continue;
		}

		if (item.type === "function_call_output") {
			flushAssistant();
			pushMessage(messages, "user", [{
				type: "tool_result",
				tool_use_id: typeof item.call_id === "string" ? item.call_id : "",
				content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
			}]);
			continue;
		}

		if (item.type === "reasoning") continue;

		if (item.role === "user") {
			flushAssistant();
			pushMessage(messages, "user", responsesInputContentToAnthropicBlocks(item.content));
			continue;
		}

		if (item.role === "developer" || item.role === "system") {
			// Anthropic Messages carries prompt-level instructions in the top-level
			// `system` field, which buildAnthropicPayloadFromRewrite preserves from
			// the fresh provider payload. Do not replay them as user transcript text.
			flushAssistant();
			continue;
		}
	}

	flushAssistant();
	return messages;
}

export function extractAnthropicCurrentRequestSuffix(payload: AnthropicPayload): AnthropicMessage[] {
	let start = -1;
	for (let index = payload.messages.length - 1; index >= 0; index--) {
		if (payload.messages[index]?.role === "user") {
			start = index;
			break;
		}
	}
	return start >= 0 ? payload.messages.slice(start) : [];
}

export function buildAnthropicPayloadFromRewrite(
	original: AnthropicPayload,
	messages: AnthropicMessage[],
): AnthropicPayload {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(original)) {
		if (key === "messages") continue;
		result[key] = value;
	}
	result.messages = messages;
	return result as unknown as AnthropicPayload;
}
