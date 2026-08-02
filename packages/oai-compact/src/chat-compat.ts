/**
 * Chat Completions ↔ Responses API 格式转换
 *
 * 让 pi-oai-compact 在 provider 发送 Chat Completions 格式（messages）
 * 时也能应用原生 compact replay。
 */

// ── Chat Completions 类型 ──────────────────────────────────────────────

export type ChatMessage = {
	role: "system" | "developer" | "user" | "assistant" | "tool";
	content: string | ChatContentPart[] | null;
	tool_calls?: ChatToolCall[];
	tool_call_id?: string;
	name?: string;
};

type ChatContentPart = {
	type: string;
	text?: string;
	image_url?: string | { url?: string; detail?: string };
	[key: string]: unknown;
};

type ChatToolCall = {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
};

export type ChatCompletionsPayload = {
	model: string;
	messages: ChatMessage[];
	system?: string | ChatContentPart[];
	[key: string]: unknown;
};

// ── Responses 格式中 compacted window item 的类型 ─────────────────────

type ResponsesItem = Record<string, unknown>;

// ── 工具函数 ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractTextFromOutputContent(
	content: unknown,
): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is Record<string, unknown> => isRecord(item))
		.filter((item) => item.type === "output_text")
		.map((item) => (typeof item.text === "string" ? item.text : ""))
		.join("\n");
}

function responsesInputContentToChatContent(content: unknown): string | ChatContentPart[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: ChatContentPart[] = [];
	for (const raw of content) {
		if (!isRecord(raw)) continue;
		if (raw.type === "input_text" && typeof raw.text === "string") {
			parts.push({ type: "text", text: raw.text });
			continue;
		}
		if (raw.type === "input_image" && typeof raw.image_url === "string") {
			parts.push({ type: "image_url", image_url: { url: raw.image_url, detail: "auto" } });
		}
	}

	if (parts.length === 1 && parts[0]?.type === "text") {
		return parts[0].text ?? "";
	}
	return parts;
}

// ── Responses compacted window items → Chat messages ──────────────────

/**
 * 将 compacted window（Responses API 格式 items）转换为 Chat 消息数组。
 */
export function responsesItemsToChatMessages(
	items: readonly unknown[],
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const pendingToolCalls: ChatToolCall[] = [];

	function flushToolCalls(text?: string) {
		if (pendingToolCalls.length === 0) return;
		messages.push({
			role: "assistant",
			content: text ?? null,
			tool_calls: [...pendingToolCalls],
		});
		pendingToolCalls.length = 0;
	}

	for (const rawItem of items) {
		const item = rawItem as ResponsesItem;
		if (!isRecord(item)) continue;

		const type = item.type;

		if (type === "message" && item.role === "assistant") {
			flushToolCalls();
			const text = extractTextFromOutputContent(item.content);
			if (pendingToolCalls.length > 0) {
				messages.push({
					role: "assistant",
					content: text,
					tool_calls: [...pendingToolCalls],
				});
				pendingToolCalls.length = 0;
			} else {
				messages.push({ role: "assistant", content: text });
			}
			continue;
		}

		if (type === "function_call") {
			pendingToolCalls.push({
				id: typeof item.call_id === "string" ? item.call_id : "",
				type: "function",
				function: {
					name: typeof item.name === "string" ? item.name : "",
					arguments: typeof item.arguments === "string" ? item.arguments : "{}",
				},
			});
			continue;
		}

		if (type === "function_call_output") {
			flushToolCalls();
			const output = typeof item.output === "string"
				? item.output
				: JSON.stringify(item.output);
			messages.push({
				role: "tool",
				tool_call_id: typeof item.call_id === "string" ? item.call_id : "",
				content: output,
			});
			continue;
		}

		if (type === "reasoning") {
			// reasoning 没有 Chat 等效格式，跳过
			continue;
		}

		if (item.role === "user") {
			flushToolCalls();
			messages.push({ role: "user", content: responsesInputContentToChatContent(item.content) });
			continue;
		}

		if (item.role === "developer" || item.role === "system") {
			flushToolCalls();
			messages.push({
				role: item.role === "developer" ? "developer" : "system",
				content: responsesInputContentToChatContent(item.content),
			});
			continue;
		}

		// Responses-only 内部 item（如 compaction_summary / encrypted_content）
		// 不能直接塞进 Chat Completions，否则部分 OpenAI-compatible provider 会 400。
		// Chat 格式没有等效载体，这里跳过。
	}

	flushToolCalls();
	return messages;
}

// ── 高层次的 payload 转换 ────────────────────────────────────────────

/**
 * 用 rewrite 后的 Chat messages 构建新的 Chat Completions payload。
 */
export function extractChatCurrentRequestSuffix(payload: ChatCompletionsPayload): ChatMessage[] {
	let start = -1;
	for (let index = payload.messages.length - 1; index >= 0; index--) {
		const role = payload.messages[index]?.role;
		if (role === "user" || role === "tool") {
			start = index;
			break;
		}
	}
	return start >= 0 ? payload.messages.slice(start) : [];
}

export function extractChatInstructionPrefix(payload: ChatCompletionsPayload): ChatMessage[] {
	const prefix: ChatMessage[] = [];
	for (const message of payload.messages) {
		if (message.role !== "system" && message.role !== "developer") break;
		prefix.push(message);
	}
	return prefix;
}

export function buildChatPayloadFromRewrite(
	original: ChatCompletionsPayload,
	messages: ChatMessage[],
	instructions?: string,
): ChatCompletionsPayload {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(original)) {
		if (key === "messages") continue;
		result[key] = value;
	}
	result.messages = messages;

	if (instructions !== undefined) {
		result.system = instructions;
	} else if (original.system !== undefined) {
		result.system = original.system;
	}

	return result as unknown as ChatCompletionsPayload;
}
