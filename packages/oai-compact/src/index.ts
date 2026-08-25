import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type BeforeProviderRequestEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import handoffExtension, {
	generateHandoffContext,
	registerHandoffTool,
} from "pi-handoff";
import { executeNativeCompaction } from "./compact-client.js";
import { resolveLatestNativeCompactionEntry } from "./details-store.js";
import { rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite.js";
import { buildCompactUrl, isResponsesCompatiblePayload, type ResponsesCompatibleRequestPayload } from "./runtime.js";
import type { NativeCompactionRequestBody } from "./serializer.js";
import { createHandoffCompactionDetails, createHandoffCompactionShimResult, createNativeCompactionDetails, createNativeCompactionShimResult } from "./types.js";

type CompactThresholdFileValue =
	| number
	| {
		percent?: number;
		tokens?: number;
	};

type CompactConfigFile = {
	promptThreshold?: CompactThresholdFileValue;
	modelPromptThresholds?: Record<string, CompactThresholdFileValue>;
	// 非 openai-responses API 的压缩策略："off" 取消压缩，"pi" 用 Pi 内置压缩，"handoff" 用 handoff 摘要代替内置压缩
	nonResponses?: "off" | "pi" | "handoff";
};

type LoadedCompactConfigFile = {
	config: CompactConfigFile;
	configPath: string;
};

type CompactPromptThreshold = {
	percent?: number;
	tokens?: number;
	source: string;
};

type CompactConfig = {
	apiKey?: string;
	headers?: Record<string, string>;
	compactUrl: string;
	identityUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function loadCompactConfigFile(): LoadedCompactConfigFile | undefined {
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();

	// 优先从 pi settings.json 的 oaiCompact 键读取
	const settingsPath = path.join(getAgentDir(), "settings.json");
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
		if (isRecord(settings) && isRecord(settings.oaiCompact)) {
			return {
				config: settings.oaiCompact as CompactConfigFile,
				configPath: `${settingsPath}:oaiCompact`,
			};
		}
	} catch {
		// settings.json 不可读时回退旧配置文件
	}

	const candidatePaths = [
		agentDir ? path.join(agentDir, "oai-compact.json") : undefined,
		path.join(os.homedir(), ".pi", "oai-compact.json"),
	].filter((value): value is string => Boolean(value));

	for (const configPath of candidatePaths) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
			if (isRecord(parsed)) {
				return { config: parsed as CompactConfigFile, configPath };
			}
		} catch {
			continue;
		}
	}

	return undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeCompactPromptThreshold(
	value: CompactThresholdFileValue | undefined,
	source: string,
): CompactPromptThreshold | undefined {
	if (value === undefined) return undefined;

	if (typeof value === "number") {
		const percent = normalizePositiveNumber(value);
		return percent !== undefined && percent <= 100 ? { percent, source } : undefined;
	}

	if (!isRecord(value)) return undefined;

	const percent = normalizePositiveNumber(value.percent);
	const tokens = normalizePositiveNumber(value.tokens);
	const threshold: CompactPromptThreshold = { source };
	if (percent !== undefined && percent <= 100) threshold.percent = percent;
	if (tokens !== undefined) threshold.tokens = tokens;

	return threshold.percent !== undefined || threshold.tokens !== undefined ? threshold : undefined;
}

function globMatches(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

function getModelPromptThreshold(
	configFile: LoadedCompactConfigFile | undefined,
	ctx: ExtensionContext,
): CompactPromptThreshold {
	const model = ctx.model;
	const modelThresholds = configFile?.config.modelPromptThresholds;
	if (model && modelThresholds) {
		const modelKeys = [
			`${model.provider}/${model.id}`,
			model.id,
		];

		for (const modelKey of modelKeys) {
			const threshold = normalizeCompactPromptThreshold(
				modelThresholds[modelKey],
				`${configFile?.configPath}:modelPromptThresholds.${modelKey}`,
			);
			if (threshold) return threshold;
		}

		for (const [pattern, value] of Object.entries(modelThresholds)) {
			if (!pattern.includes("*")) continue;
			if (!modelKeys.some((modelKey) => globMatches(pattern, modelKey))) continue;

			const threshold = normalizeCompactPromptThreshold(
				value,
				`${configFile?.configPath}:modelPromptThresholds.${pattern}`,
			);
			if (threshold) return threshold;
		}
	}

	return (
		normalizeCompactPromptThreshold(configFile?.config.promptThreshold, `${configFile?.configPath}:promptThreshold`) ?? {
			percent: 80,
			source: "默认（80%）",
		}
	);
}

function getNonResponsesMode(configFile: LoadedCompactConfigFile | undefined): "off" | "pi" | "handoff" {
	const value = configFile?.config.nonResponses;
	return value === "pi" || value === "handoff" ? value : "off";
}

// 取最近一条用户消息文本作为 handoff 提取的请求上下文
function extractLatestUserRequest(branchEntries: readonly SessionEntry[]): string {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type !== "message" || entry.message.role !== "user") continue;

		const content = entry.message.content;
		if (!Array.isArray(content)) continue;

		const text = content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		if (text) return text.slice(0, 2000);
	}
	return "";
}

// 非 openai-responses：用 handoff 提取逻辑生成交接摘要作为压缩内容；生成失败则取消压缩
async function handleHandoffCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
	if (!ctx.model) return { cancel: true };

	const request = extractLatestUserRequest(event.branchEntries);
	let summary: string | null = null;
	try {
		summary = await generateHandoffContext(request, ctx, event.signal);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Handoff 压缩失败：${message}，已取消压缩`, "warning");
		return { cancel: true };
	}

	if (!summary) {
		notify(ctx, "Handoff 压缩失败，已取消压缩", "warning");
		return { cancel: true };
	}

	notify(ctx, "Handoff 压缩成功：已用交接摘要压缩上下文", "info");
	return {
		compaction: createHandoffCompactionShimResult({
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			summary,
			details: createHandoffCompactionDetails({
				provider: ctx.model.provider,
				api: ctx.model.api,
				model: ctx.model.id,
			}),
		}),
	};
}

async function resolveCurrentModelCompactConfig(ctx: ExtensionContext): Promise<CompactConfig | undefined> {
	if (!ctx.model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		notify(ctx, `读取当前模型认证失败：${auth.error}，已取消压缩`, "warning");
		return undefined;
	}

	return {
		apiKey: auth.apiKey,
		headers:
			auth.headers &&
			(Object.fromEntries(
				Object.entries(auth.headers).filter(([, value]) => value !== null),
			) as Record<string, string>),
		compactUrl: buildCompactUrl(ctx.model.baseUrl),
		identityUrl: ctx.model.baseUrl,
	};
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function formatTokenCount(tokens: number): string {
	return Math.round(tokens).toLocaleString("en-US");
}

function formatPercent(percent: number): string {
	return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

function getPromptThresholdHit(input: {
	threshold: CompactPromptThreshold;
	usage: ReturnType<ExtensionContext["getContextUsage"]>;
}): { reached: boolean; reasons: string[] } {
	const reasons: string[] = [];
	const { threshold, usage } = input;
	if (!usage) return { reached: false, reasons };

	if (threshold.percent !== undefined && usage.percent !== null && usage.percent >= threshold.percent) {
		reasons.push(`上下文占用 ${formatPercent(usage.percent)} ≥ ${formatPercent(threshold.percent)}`);
	}

	if (threshold.tokens !== undefined && usage.tokens !== null && usage.tokens >= threshold.tokens) {
		reasons.push(`上下文 ${formatTokenCount(usage.tokens)} tokens ≥ ${formatTokenCount(threshold.tokens)} tokens`);
	}

	return { reached: reasons.length > 0, reasons };
}

// ponytail: Pi 同一进程只有一个活动 session；记录 sessionId 可避免切会话后复用旧 payload
let latestNormalPayload: { sessionId: string; payload: ResponsesCompatibleRequestPayload } | undefined;

// ponytail: 模块级防重入标志；压缩在途时忽略相邻 turn_end 或手动触发
let compactionScheduled = false;

async function checkAndCompact(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (compactionScheduled || !ctx.model || ctx.model.api !== "openai-responses") {
		return;
	}

	const configFile = loadCompactConfigFile();
	const threshold = getModelPromptThreshold(configFile, ctx);
	const hit = getPromptThresholdHit({ threshold, usage: ctx.getContextUsage() });
	if (!hit.reached) {
		return;
	}

	const lastEntry = ctx.sessionManager.getBranch().at(-1);
	if (lastEntry?.type === "compaction") {
		return;
	}

	notify(ctx, `上下文已达到压缩阈值（${hit.reasons.join("；")}），开始自动压缩…`, "info");
	runCompaction(pi, ctx);
}

function runCompaction(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (compactionScheduled) {
		return;
	}
	compactionScheduled = true;

	ctx.compact({
		onComplete: (result) => {
			compactionScheduled = false;
			notify(ctx, `压缩完成：压缩前 ${formatTokenCount(result.tokensBefore)} tokens`, "info");
			pi.sendUserMessage("continue", { deliverAs: "followUp" });
		},
		onError: (error) => {
			compactionScheduled = false;
			if (
				error.message.includes("Already compacted") ||
				error.message.includes("Nothing to compact") ||
				error.message.includes("Compaction cancelled")
			) {
				return;
			}
			notify(ctx, `压缩失败：${error.message}`, "error");
		},
	});
}

async function handleSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
	if (!ctx.model || ctx.model.api !== "openai-responses") {
		switch (getNonResponsesMode(loadCompactConfigFile())) {
			case "pi":
				// 放行 Pi 内置 compact
				return undefined;
			case "handoff":
				return handleHandoffCompaction(event, ctx);
			default:
				return { cancel: true };
		}
	}

	const config = await resolveCurrentModelCompactConfig(ctx);
	if (!config) {
		return { cancel: true };
	}

	if (event.signal.aborted) {
		return { cancel: true };
	}

	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries);
	if (!latestNativeCompaction.ok && latestNativeCompaction.reason !== "no-compaction") {
		notify(ctx, "最近一次压缩不是 Native compact，已取消压缩", "warning");
		return { cancel: true };
	}

	const sessionId = ctx.sessionManager.getSessionId();
	if (latestNormalPayload?.sessionId !== sessionId) {
		notify(ctx, "未找到当前会话最近一次完整 Responses payload，已取消压缩", "warning");
		return { cancel: true };
	}

	const request: NativeCompactionRequestBody = latestNormalPayload.payload;

	const result = await executeNativeCompaction({
		config: {
			compactUrl: config.compactUrl,
			apiKey: config.apiKey,
			headers: config.headers,
		},
		request,
		signal: event.signal,
	});

	if (!result.ok) {
		if (result.reason === "aborted") {
			return { cancel: true };
		}

		const detail = result.errorMessage ? `：${result.errorMessage}` : "";
		notify(ctx, `Native compact 失败：${result.reason}${detail}，已取消压缩`, "warning");
		return { cancel: true };
	}

	const compaction = createNativeCompactionShimResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: createNativeCompactionDetails({
			provider: ctx.model.provider,
			api: ctx.model.api,
			model: request.model,
			baseUrl: config.identityUrl,
			compactedWindow: result.compactedWindow,
			compactResponseId: result.compactResponseId,
			createdAt: result.createdAt,
			requestMeta: {
				tokensBefore: event.preparation.tokensBefore,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
			},
		}),
	});

	notify(ctx, `Native compact 成功：${result.compactedWindow.length} items`, "info");

	return { compaction };
}

async function handleBeforeProviderRequest(event: BeforeProviderRequestEvent, ctx: ExtensionContext) {
	if (!ctx.model) {
		return undefined;
	}

	if (ctx.model.api !== "openai-responses") {
		return undefined;
	}

	// Responses API 格式
	if (isResponsesCompatiblePayload(event.payload)) {
		const branchEntries = ctx.sessionManager.getBranch();
		const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries);
		let outgoingPayload = event.payload;

		if (latestNativeCompaction.ok) {
			const rewrite = rewriteResponsesPayloadWithNativeReplay({
				model: ctx.model,
				payload: event.payload,
				branchEntries,
				compactionEntry: latestNativeCompaction.entry,
			});

			if (rewrite.ok) {
				outgoingPayload = rewrite.rewrittenPayload;
			}
		}

		latestNormalPayload = {
			sessionId: ctx.sessionManager.getSessionId(),
			payload: structuredClone(outgoingPayload),
		};

		return outgoingPayload === event.payload ? undefined : outgoingPayload;
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	// 合并 pi-handoff：注册 /handoff 命令（生成交接摘要并新建 session）
	handoffExtension(pi);
	// 常驻注册交接工具，稳定工具列表以命中提示词缓存
	registerHandoffTool(pi);

	// 一次模型响应及其工具结果全部落盘后检查，命中时在下一次模型请求前压缩
	pi.on("turn_end", (_event, ctx) => checkAndCompact(pi, ctx));
	pi.on("session_before_compact", handleSessionBeforeCompact);
	pi.on("before_provider_request", handleBeforeProviderRequest);
}
