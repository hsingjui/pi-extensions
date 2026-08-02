import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildSessionContext,
	type AgentEndEvent,
	type BeforeProviderRequestEvent,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./compact-client.js";
import { resolveLatestNativeCompactionEntry } from "./details-store.js";
import {
	rewriteResponsesPayloadWithNativeReplay,
	serializeLiveTailToResponsesInput,
} from "./payload-rewrite.js";
import {
	buildCompactUrl,
	isResponsesCompatiblePayload,
} from "./runtime.js";
import { serializeInstructionsToResponsesInput, serializeMessagesToResponsesInput, type NativeCompactionRequestBody } from "./serializer.js";
import { createNativeCompactionDetails, createNativeCompactionShimResult } from "./types.js";

type CompactThresholdFileValue =
	| number
	| {
		percent?: number;
		tokens?: number;
	};

type CompactConfigFile = {
	model?: string;
	promptThreshold?: CompactThresholdFileValue;
	modelPromptThresholds?: Record<string, CompactThresholdFileValue>;
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
	model: string;
	compactUrl: string;
	identityUrl: string;
	modelConfigPath?: string;
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

async function resolveCurrentModelCompactConfig(ctx: ExtensionContext): Promise<CompactConfig | undefined> {
	if (!ctx.model) return undefined;

	const configFile = loadCompactConfigFile();
	const model = configFile?.config.model?.trim();
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		notify(ctx, `读取当前模型认证失败：${auth.error}，回退默认 compact`, "warning");
		return undefined;
	}

	return {
		apiKey: auth.apiKey,
		headers: auth.headers,
		model: model || ctx.model.id,
		compactUrl: buildCompactUrl(ctx.model.baseUrl),
		identityUrl: ctx.model.baseUrl,
		modelConfigPath: model ? configFile?.configPath : undefined,
	};
}

function cloneOpaqueWindow(window: readonly unknown[]): unknown[] {
	return window.map((item) => structuredClone(item));
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

function describePromptThreshold(threshold: CompactPromptThreshold): string {
	const parts: string[] = [];
	if (threshold.percent !== undefined) parts.push(formatPercent(threshold.percent));
	if (threshold.tokens !== undefined) parts.push(`${formatTokenCount(threshold.tokens)} tokens`);
	return parts.join(" 或 ");
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

function schedulePromptedCompaction(ctx: ExtensionContext, usage: ReturnType<ExtensionContext["getContextUsage"]>) {
	const maxAttempts = 40;
	let attempt = 0;

	const runWhenIdle = () => {
		attempt += 1;
		if (!ctx.isIdle() && attempt < maxAttempts) {
			setTimeout(runWhenIdle, 250);
			return;
		}

		if (!ctx.isIdle()) {
			notify(ctx, "已确认压缩，但 agent 仍未空闲，请稍后手动运行 /compact。", "warning");
			return;
		}

		if (ctx.hasPendingMessages()) {
			notify(ctx, "已确认压缩，但当前还有排队消息，请稍后手动运行 /compact。", "warning");
			return;
		}

		notify(ctx, "开始自动压缩上下文…", "info");
		ctx.compact({
			onComplete: (result) => {
				notify(ctx, `压缩完成：压缩前 ${formatTokenCount(result.tokensBefore)} tokens`, "info");
			},
			onError: (error) => {
				notify(ctx, `压缩失败：${error.message}`, "error");
			},
		});
	};

	setTimeout(runWhenIdle, 0);
}

async function handleAgentEnd(event: AgentEndEvent, ctx: ExtensionContext) {
	if (!ctx.model) {
		return;
	}

	const configFile = loadCompactConfigFile();

	const threshold = getModelPromptThreshold(configFile, ctx);

	const usage = ctx.getContextUsage();
	const hit = getPromptThresholdHit({ threshold, usage });

	if (!hit.reached) {
		return;
	}

	if (!ctx.hasUI) {
		return;
	}

	if (ctx.hasPendingMessages()) {
		notify(ctx, `上下文已达到压缩阈值（${hit.reasons.join("；")}），当前还有排队消息，建议稍后运行 /compact。`, "warning");
		return;
	}

	const usageText = usage
		? `${usage.tokens === null ? "未知" : formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} tokens${usage.percent === null ? "" : `（${formatPercent(usage.percent)}）`}`
		: "未知";
	const accepted = await ctx.ui.confirm(
		"上下文压缩建议",
		`当前上下文：${usageText}\n触发阈值：${describePromptThreshold(threshold)}\n原因：${hit.reasons.join("；")}\n\n是否现在执行 /compact？`,
	);


	if (!accepted) {
		return;
	}

	notify(ctx, "已确认压缩，将在本轮完全结束后自动执行…", "info");
	schedulePromptedCompaction(ctx, usage);
}

async function handleSessionBeforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
	if (!ctx.model) {
		return undefined;
	}

	if (ctx.model.api !== "openai-responses") {
		return undefined;
	}

	const config = await resolveCurrentModelCompactConfig(ctx);
	if (!config) {
		return undefined;
	}

	if (event.signal.aborted) {
		return { cancel: true };
	}

	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries);

	// 与 Pi 正常请求共用同一 prompt_cache_key（Pi 用 sessionId，见 pi-ai openai-responses）,
	// 这样 compact 请求能命中正常请求写入的缓存；后续 replay 请求保留 Pi payload 自带的同 key，命中 compact 写入的缓存。
	const promptCacheKey = Array.from(ctx.sessionManager.getSessionId()).slice(0, 64).join("");
	const systemPromptItem = serializeInstructionsToResponsesInput(ctx.model, ctx.getSystemPrompt());

	let request: NativeCompactionRequestBody;
	if (latestNativeCompaction.ok) {
		const liveTailEntries = branchEntries.slice(latestNativeCompaction.index + 1);
		request = {
			model: config.model,
			input: [
				...systemPromptItem,
				...cloneOpaqueWindow(latestNativeCompaction.entry.details!.compactedWindow),
				...serializeLiveTailToResponsesInput({ model: ctx.model, entries: liveTailEntries }),
			],
		};
	} else if (latestNativeCompaction.reason === "no-compaction") {
		const preparationMessages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
		const sessionContextMessages = buildSessionContext(branchEntries, ctx.sessionManager.getLeafId()).messages;
		const sourceMessages = preparationMessages.length > 0 ? preparationMessages : sessionContextMessages;
		request = {
			model: config.model,
			input: [
				...systemPromptItem,
				...serializeMessagesToResponsesInput(ctx.model, sourceMessages),
			],
		};
	} else {
		return undefined;
	}

	request.prompt_cache_key = promptCacheKey;
	// 镜像 Pi：仅在 PI_CACHE_RETENTION=long 时延长缓存保留，compact 写入的窗口缓存可跨会话恢复命中
	if (process.env.PI_CACHE_RETENTION?.trim() === "long") {
		request.prompt_cache_retention = "24h";
	}

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
		notify(ctx, `Native compact 失败：${result.reason}${detail}`, "warning");
		return undefined;
	}

	const compaction = createNativeCompactionShimResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: createNativeCompactionDetails({
			provider: ctx.model.provider,
			api: ctx.model.api,
			model: config.model,
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
		if (!latestNativeCompaction.ok) {
			return undefined;
		}

		const rewrite = rewriteResponsesPayloadWithNativeReplay({
			model: ctx.model,
			payload: event.payload,
			branchEntries,
			compactionEntry: latestNativeCompaction.entry,
		});

		if (!rewrite.ok) {
			return undefined;
		}

		notify(ctx, `Native compact replay 生效：${rewrite.rewrittenPayload.input.length} items`, "info");
		return rewrite.rewrittenPayload;
	}

	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", handleAgentEnd);
	pi.on("session_before_compact", handleSessionBeforeCompact);
	pi.on("before_provider_request", handleBeforeProviderRequest);
}
