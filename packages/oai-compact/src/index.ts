import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { compactCachedOpenAIResponsesWebSocket } from "pi-custom-response-ws";
import {
	type BeforeProviderRequestEvent,
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./compact-client.js";
import { resolveLatestNativeCompactionEntry } from "./details-store.js";
import { rewriteResponsesPayloadWithNativeReplay } from "./payload-rewrite.js";
import { buildCompactUrl, isResponsesCompatiblePayload, type ResponsesCompatibleRequestPayload } from "./runtime.js";
import { serializeMessagesToResponsesInput, type NativeCompactionRequestBody } from "./serializer.js";
import { createNativeCompactionDetails, createNativeCompactionShimResult } from "./types.js";

type CompactThresholdFileValue =
	| number
	| {
		percent?: number;
		tokens?: number;
	};

type CompactConfigFile = {
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
	compactUrl: string;
	identityUrl: string;
};

type WsRequestTemplateData = {
	version: 1;
	sessionId: string;
	provider: string;
	model: string;
	body: Record<string, unknown>;
};

const WS_REQUEST_TEMPLATE_ENTRY = "pi-oai-compact-ws-request-template";

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

// 非 Responses 的压缩由 pi-handoff 负责；Responses 的压缩由本插件协调
async function resolveCurrentModelCompactConfig(ctx: ExtensionContext): Promise<CompactConfig | undefined> {
	if (!ctx.model) return undefined;
	if (ctx.model.api === "openai-responses-ws") {
		return {
			compactUrl: buildCompactUrl(ctx.model.baseUrl),
			identityUrl: ctx.model.baseUrl,
		};
	}

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
let pendingManualWsResumeSessionId: string | undefined;

function createWsRequestTemplate(payload: ResponsesCompatibleRequestPayload): Record<string, unknown> {
	const {
		input: _input,
		previous_response_id: _previousResponseId,
		context_management: _contextManagement,
		...body
	} = payload;
	return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

function resolveWsRequestTemplate(
	entries: readonly SessionEntry[],
	ctx: ExtensionContext,
): Record<string, unknown> | undefined {
	if (!ctx.model) return undefined;
	const sessionId = ctx.sessionManager.getSessionId();

	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== WS_REQUEST_TEMPLATE_ENTRY || !isRecord(entry.data)) {
			continue;
		}
		const data = entry.data;
		if (
			data.version === 1 &&
			data.sessionId === sessionId &&
			data.provider === ctx.model.provider &&
			data.model === ctx.model.id &&
			isRecord(data.body)
		) {
			return structuredClone(data.body);
		}
	}
	return undefined;
}

function persistWsRequestTemplate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	payload: ResponsesCompatibleRequestPayload,
): void {
	if (!ctx.model || ctx.model.api !== "openai-responses-ws") return;

	const branchEntries = ctx.sessionManager.getBranch();
	const body = createWsRequestTemplate(payload);
	if (isDeepStrictEqual(resolveWsRequestTemplate(branchEntries, ctx), body)) return;

	pi.appendEntry<WsRequestTemplateData>(WS_REQUEST_TEMPLATE_ENTRY, {
		version: 1,
		sessionId: ctx.sessionManager.getSessionId(),
		provider: ctx.model.provider,
		model: ctx.model.id,
		body,
	});
}

function buildSessionCompactionRequest(ctx: ExtensionContext): NativeCompactionRequestBody | undefined {
	if (!ctx.model) return undefined;

	const branchEntries = ctx.sessionManager.getBranch();
	const template = resolveWsRequestTemplate(branchEntries, ctx);
	const sessionId = Array.from(ctx.sessionManager.getSessionId()).slice(0, 64).join("");
	let payload: ResponsesCompatibleRequestPayload = {
		...(template ?? { prompt_cache_key: sessionId }),
		model: ctx.model.id,
		input: serializeMessagesToResponsesInput(ctx.model, buildSessionContext(branchEntries).messages, {
			instructions: ctx.getSystemPrompt(),
			includeInstructionsInInput: true,
		}),
	};
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries);
	if (!latestNativeCompaction.ok) {
		return latestNativeCompaction.reason === "no-compaction" ? payload : undefined;
	}

	const rewrite = rewriteResponsesPayloadWithNativeReplay({
		model: ctx.model,
		payload,
		branchEntries,
		compactionEntry: latestNativeCompaction.entry,
	});
	if (!rewrite.ok) return undefined;
	payload = rewrite.rewrittenPayload;
	return payload;
}

async function checkAndCompact(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (
		compactionScheduled ||
		!ctx.model ||
		(ctx.model.api !== "openai-responses" && ctx.model.api !== "openai-responses-ws")
	) {
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

async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
) {
	if (
		!ctx.model ||
		(ctx.model.api !== "openai-responses" && ctx.model.api !== "openai-responses-ws")
	) {
		return undefined;
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
	let request: NativeCompactionRequestBody | undefined;
	if (ctx.model.api === "openai-responses-ws") {
		request = buildSessionCompactionRequest(ctx);
		if (!request) {
			notify(ctx, "无法从当前会话重建 Responses input，已取消压缩", "warning");
			return { cancel: true };
		}
	} else {
		if (latestNormalPayload?.sessionId !== sessionId) {
			notify(ctx, "未找到当前会话最近一次完整 Responses payload，已取消压缩", "warning");
			return { cancel: true };
		}
		request = latestNormalPayload.payload;
	}
	let compactedWindow: unknown[];
	let compactResponseId: string | undefined;
	let createdAt: string | undefined;

	if (ctx.model.api === "openai-responses-ws") {
		try {
			const result = await compactCachedOpenAIResponsesWebSocket({
				sessionId,
				baseUrl: ctx.model.baseUrl,
				request,
				signal: event.signal,
			});
			compactedWindow = result.compactedWindow;
			compactResponseId = result.compactResponseId;
			createdAt = result.createdAt;
		} catch (error) {
			if (event.signal.aborted) return { cancel: true };
			notify(ctx, `WS native compact 失败：${error instanceof Error ? error.message : String(error)}`, "warning");
			return { cancel: true };
		}
	} else {
		if (!request) return { cancel: true };
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
		compactedWindow = result.compactedWindow;
		compactResponseId = result.compactResponseId;
		createdAt = result.createdAt;
	}

	const compaction = createNativeCompactionShimResult({
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		details: createNativeCompactionDetails({
			provider: ctx.model.provider,
			api: ctx.model.api,
			model: request?.model ?? ctx.model.id,
			baseUrl: config.identityUrl,
			compactedWindow,
			compactResponseId,
			createdAt,
			requestMeta: {
				tokensBefore: event.preparation.tokensBefore,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
			},
		}),
	});

	if (ctx.model.api === "openai-responses-ws" && event.reason === "manual" && !compactionScheduled) {
		pendingManualWsResumeSessionId = sessionId;
	}
	notify(ctx, `Native compact 成功：${compactedWindow.length} items`, "info");

	return { compaction };
}

async function handleBeforeProviderRequest(
	pi: ExtensionAPI,
	event: BeforeProviderRequestEvent,
	ctx: ExtensionContext,
) {
	if (!ctx.model || !isResponsesCompatiblePayload(event.payload)) {
		return undefined;
	}

	if (ctx.model.api !== "openai-responses" && ctx.model.api !== "openai-responses-ws") {
		return undefined;
	}

	let outgoingPayload = event.payload;
	if (ctx.model.api === "openai-responses-ws" && event.payload.context_management !== undefined) {
		const { context_management: _contextManagement, ...payload } = event.payload;
		outgoingPayload = payload;
	}

	const branchEntries = ctx.sessionManager.getBranch();
	const latestNativeCompaction = resolveLatestNativeCompactionEntry(branchEntries);

	if (latestNativeCompaction.ok) {
		const rewrite = rewriteResponsesPayloadWithNativeReplay({
			model: ctx.model,
			payload: outgoingPayload,
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
	persistWsRequestTemplate(pi, ctx, outgoingPayload);

	return outgoingPayload === event.payload ? undefined : outgoingPayload;
}

export default function (pi: ExtensionAPI) {
	// 一次模型响应及其工具结果全部落盘后检查，命中时在下一次模型请求前压缩
	pi.on("turn_end", (_event, ctx) => checkAndCompact(pi, ctx));
	pi.on("session_before_compact", handleSessionBeforeCompact);
	pi.on("session_compact", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (
			event.reason === "manual" &&
			ctx.model?.api === "openai-responses-ws" &&
			pendingManualWsResumeSessionId === sessionId
		) {
			pendingManualWsResumeSessionId = undefined;
			setTimeout(() => {
				if (ctx.sessionManager.getSessionId() === sessionId) {
					pi.sendUserMessage("continue", { deliverAs: "followUp" });
				}
			}, 0);
		}
	});
	pi.on("before_provider_request", (event, ctx) => handleBeforeProviderRequest(pi, event, ctx));
}
