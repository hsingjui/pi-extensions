import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { contentText, type Model } from "@earendil-works/pi-ai";

const MAX_FINAL_LEN = 40;
const NAMING_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_TOKENS = 300;

const TITLE_PROMPT_TEMPLATE = `Generate a short title for this conversation based primarily on the user's message.

Requirements:

* Use the same language as the user's message.
* Capture the main task or intent.
* Keep it concise and specific.
* Prefer 4–10 Chinese characters for Chinese, or 2–6 words for other languages.
* Avoid generic titles such as "Question", "Help", "Discussion", or "New Session".
* Do not include quotes, prefixes, explanations, or ending punctuation.
* Output only the title.

User message:
{{user_message}}`;

/** 读取 Herdr 环境：HERDR_ENV=1 时返回当前 tab id，否则 undefined。 */
export function resolveHerdrTabId(env: Record<string, string | undefined> = process.env): string | undefined {
	if (env.HERDR_ENV?.trim() !== "1") return undefined;
	const tabId = env.HERDR_TAB_ID?.trim();
	return tabId || undefined;
}

// ponytail: 模块级状态，跨事件共享；session_start 时重置。
let naming = false; // 一次命名请求进行中，防止并发
let pendingUserText: string | undefined; // 首条用户消息失败后暂存，等待 agent 回复后重试
let retryPending = false; // 初始命名失败，等待下一条 assistant 回复触发重试

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 读取配置：优先 pi settings.json 的 sessionName 键，回退独立文件 session-name.json。 */
export function loadSessionNameConfig(): { model?: string; configPath: string } | undefined {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	const settingsPath = path.join(getAgentDir(), "settings.json");
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
		if (isRecord(settings) && isRecord(settings.sessionName)) {
			return {
				model: typeof settings.sessionName.model === "string" ? settings.sessionName.model.trim() || undefined : undefined,
				configPath: `${settingsPath}:sessionName`,
			};
		}
	} catch {
		// 忽略，回退独立配置文件
	}

	const candidates = [
		agentDir ? path.join(agentDir, "session-name.json") : undefined,
		path.join(getAgentDir(), "session-name.json"),
	].filter((p): p is string => Boolean(p));
	for (const configPath of candidates) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
			if (isRecord(parsed)) {
				return {
					model: typeof parsed.model === "string" ? parsed.model.trim() || undefined : undefined,
					configPath,
				};
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

/** 按配置解析命名模型：支持 "provider/id" 或纯 id；解析失败回退 undefined。 */
export function resolveConfiguredModel(ctx: ExtensionContext, config: { model?: string } | undefined): Model<any> | undefined {
	const spec = config?.model?.trim();
	if (!spec) return undefined;
	const slash = spec.indexOf("/");
	if (slash > 0) {
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		const found = ctx.modelRegistry.find(provider, id);
		if (found) return found;
	}
	const all = ctx.modelRegistry.getAll();
	return all.find((m) => m.id === spec);
}

/** 提取用户消息的纯文本（可能是 string 或内容块数组）。 */
export function extractUserText(message: MessageEndEvent["message"]): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	return contentText(content).trim();
}

/** 提取 assistant 回复的纯文本。 */
export function extractAssistantText(message: MessageEndEvent["message"]): string {
	return message.role === "assistant" ? contentText(message.content).trim() : "";
}

/** 组装标题生成提示词：模板 + 首条用户消息（重试时追加 assistant 回复）。 */
export function buildTitlePrompt(messages: { role: "user" | "assistant"; text: string }[]): string {
	const user = messages.find((m) => m.role === "user")?.text ?? "";
	const assistant = messages
		.filter((m) => m.role === "assistant")
		.map((m) => m.text)
		.join("\n");
	let prompt = TITLE_PROMPT_TEMPLATE.replace("{{user_message}}", user);
	if (assistant) {
		prompt += `\n\nAssistant reply:\n${assistant}`;
	}
	return prompt;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

/** 构建非流式请求的 URL 与 body（复用 Pi 模型的 baseUrl/api）。 */
export function buildTitleRequest(model: Model<any>, prompt: string): { url: string; body: Record<string, unknown> } {
	const base = normalizeBaseUrl(model.baseUrl);
	if (model.api === "openai-responses" || model.api === "openai-codex-responses" || model.api === "azure-openai-responses") {
		return {
			url: base.endsWith("/responses") ? base : base.endsWith("/v1") ? `${base}/responses` : `${base}/v1/responses`,
			body: {
				model: model.id,
				input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
				max_output_tokens: MAX_RESPONSE_TOKENS,
			},
		};
	}
	if (model.api === "anthropic-messages") {
		return {
			url: `${base}/messages`,
			body: { model: model.id, max_tokens: MAX_RESPONSE_TOKENS, messages: [{ role: "user", content: prompt }] },
		};
	}
	// openai-completions 及默认
	return {
		url: base.endsWith("/chat/completions") ? base : base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`,
		body: {
			model: model.id,
			messages: [{ role: "user", content: prompt }],
			max_tokens: MAX_RESPONSE_TOKENS,
		},
	};
}

/** 从非流式响应中提取文本。 */
export function extractTitleFromResponse(model: Model<any>, json: unknown): string {
	const record = json as Record<string, unknown>;
	if (model.api === "anthropic-messages") {
		const content = record?.content;
		if (Array.isArray(content)) {
			const text = content
				.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
				.map((block) => (block.type === "text" ? block.text ?? "" : ""))
				.join("");
			if (text) return text;
		}
	}
	if (model.api === "openai-responses" || model.api === "openai-codex-responses" || model.api === "azure-openai-responses") {
		if (typeof record?.output_text === "string" && record.output_text) return record.output_text;
		const output = record?.output;
		if (Array.isArray(output)) {
			const text = output
				.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
				.map((item) => {
					if (typeof item.text === "string") return item.text;
					const content = item.content;
					if (!Array.isArray(content)) return "";
					return content
						.filter((b): b is { type: string; text?: string } => !!b && typeof b === "object")
						.map((b) => (b.type === "output_text" || b.type === "text" ? b.text ?? "" : ""))
						.join("");
				})
				.join("");
			if (text) return text;
		}
	}
	// OpenAI chat completions 及兜底（兼容网关的 {data:{choices}} 外层包装）
	const dataWrapper = record?.data;
	const choices = Array.isArray(record?.choices)
		? record.choices
		: isRecord(dataWrapper) && Array.isArray(dataWrapper.choices)
			? (dataWrapper as Record<string, unknown>).choices
			: undefined;
	if (Array.isArray(choices)) {
		const first = choices[0] as Record<string, unknown> | undefined;
		const message = first?.message as Record<string, unknown> | undefined;
		if (typeof message?.content === "string") return message.content;
		if (typeof first?.text === "string") return first.text;
	}
	return "";
}

/** 用配置模型，通过非流式请求生成会话标题。 */
async function generateTitle(ctx: ExtensionContext, messages: { role: "user" | "assistant"; text: string }[]): Promise<string> {
	const config = loadSessionNameConfig();
	const model = resolveConfiguredModel(ctx, config) ?? ctx.model;
	if (!model) {
		throw new Error("无法获取当前模型");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(`读取模型认证失败：${auth.error}`);
	}

	const { url, body } = buildTitleRequest(model, buildTitlePrompt(messages));
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json",
		...(auth.headers ?? {}),
	};
	if (auth.apiKey && !headers.authorization) {
		headers.authorization = `Bearer ${auth.apiKey}`;
	}
	if (model.api === "anthropic-messages") {
		headers["anthropic-version"] = "2023-06-01";
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), NAMING_TIMEOUT_MS);
	try {
		const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
		const responseText = await response.text();
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${responseText.slice(0, 200)}`);
		}
		let json: unknown;
		try {
			json = JSON.parse(responseText);
		} catch {
			throw new Error(`响应不是合法 JSON：${responseText.slice(0, 200)}`);
		}
		return sanitizeTitle(extractTitleFromResponse(model, json));
	} finally {
		clearTimeout(timeout);
	}
}

/** 清理模型输出：去引号/控制字符/换行，限制长度。 */
export function sanitizeTitle(raw: string): string {
	let title = raw.trim();
	title = title.replace(/^["'`\s]+|["'`\s]+$/g, "");
	title = title.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
	title = title.replace(/^标题[:：]|^title[:：]/i, "").trim();
	if (title.length > MAX_FINAL_LEN) title = title.slice(0, MAX_FINAL_LEN).trim();
	return title;
}

/** 执行一次命名；成功设名并清理待重试状态，失败则登记待重试。 */
async function attemptName(pi: ExtensionAPI, ctx: ExtensionContext, messages: { role: "user" | "assistant"; text: string }[]) {
	if (naming || !ctx.model) return;
	naming = true;
	try {
		const title = await generateTitle(ctx, messages);
		retryPending = false;
		pendingUserText = undefined;
		if (!title) return;
		pi.setSessionName(title);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") return;
		// 失败：若首条用户消息尚未登记过，则登记待重试上下文
		if (!retryPending && messages.every((m) => m.role === "user")) {
			pendingUserText = messages[0]?.text;
			retryPending = true;
		} else {
			retryPending = false;
			pendingUserText = undefined;
		}
		const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
		notify(ctx, `会话命名失败：${error instanceof Error ? error.message : String(error)}${firstUser ? "，agent 回复后将重试" : ""}`, "warning");
	} finally {
		naming = false;
	}
}

/** 若处于 Herdr 环境，把会话名同步为 Herdr tab 标签。空白名不处理（不覆盖已有标签）。 */
async function syncHerdrTabLabel(pi: ExtensionAPI, name: string | undefined) {
	const tabId = resolveHerdrTabId();
	if (!tabId) return;
	const label = name?.trim();
	if (!label) return;
	await pi.exec("herdr", ["tab", "rename", tabId, label], { timeout: 5000 });
}

export default function (pi: ExtensionAPI) {

	pi.on("session_start", () => {
		naming = false;
		pendingUserText = undefined;
		retryPending = false;
		// 启动/恢复已有名称的会话时同步给 Herdr
		void syncHerdrTabLabel(pi, pi.getSessionName());
	});

	// 自动命名 / 手动 /name 修改 / 清除时同步给 Herdr
	pi.on("session_info_changed", (event) => {
		void syncHerdrTabLabel(pi, event.name);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role === "user") {
			if (pi.getSessionName()) return;
			if (naming || retryPending) return;
			const text = extractUserText(message);
			if (!text) return;
			void attemptName(pi, ctx, [{ role: "user", text }]);
			return;
		}

		if (message.role === "assistant" && retryPending && pendingUserText) {
			const reply = extractAssistantText(message);
			if (!reply) return;
			void attemptName(pi, ctx, [
				{ role: "user", text: pendingUserText },
				{ role: "assistant", text: reply },
			]);
		}
	});
}