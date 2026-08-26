import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  complete,
  Type,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  getAgentDir,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";

const TOOL_NAME = "create_handoff_context";

function isResponsesApi(api: string): boolean {
  return api === "openai-responses" || api === "openai-responses-ws";
}

type CompactThresholdFileValue =
  | number
  | {
      percent?: number;
      tokens?: number;
    };

type HandoffConfigFile = {
  promptThreshold?: CompactThresholdFileValue;
  modelPromptThresholds?: Record<string, CompactThresholdFileValue>;
  // 非 Responses API 的压缩策略："off" 取消压缩，"pi" 放行 Pi，"handoff" 使用交接摘要
  nonResponses?: "off" | "pi" | "handoff";
};

type LoadedHandoffConfigFile = {
  config: HandoffConfigFile;
  configPath: string;
};

type CompactPromptThreshold = {
  percent?: number;
  tokens?: number;
  source: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function loadHandoffConfigFile(): LoadedHandoffConfigFile | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const settingsPath = path.join(getAgentDir(), "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (isRecord(settings) && isRecord(settings.handoff)) {
      return {
        config: settings.handoff as HandoffConfigFile,
        configPath: `${settingsPath}:handoff`,
      };
    }
    if (isRecord(settings) && isRecord(settings.oaiCompact)) {
      const legacy = settings.oaiCompact;
      if (legacy.nonResponses === "off" || legacy.nonResponses === "pi" || legacy.nonResponses === "handoff") {
        return {
          config: legacy as HandoffConfigFile,
          configPath: `${settingsPath}:oaiCompact (legacy handoff)`,
        };
      }
    }
  } catch {
    // settings.json 不可读时回退旧配置文件
  }

  const candidatePaths = [
    agentDir ? path.join(agentDir, "handoff.json") : undefined,
    path.join(os.homedir(), ".pi", "handoff.json"),
    agentDir ? path.join(agentDir, "oai-compact.json") : undefined,
    path.join(os.homedir(), ".pi", "oai-compact.json"),
  ].filter((value): value is string => Boolean(value));

  for (const configPath of candidatePaths) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      if (isRecord(parsed)) return { config: parsed as HandoffConfigFile, configPath };
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

function getPromptThreshold(configFile: LoadedHandoffConfigFile | undefined, ctx: ExtensionContext): CompactPromptThreshold {
  const modelThresholds = configFile?.config.modelPromptThresholds;
  if (ctx.model && modelThresholds) {
    const modelKeys = [`${ctx.model.provider}/${ctx.model.id}`, ctx.model.id];
    for (const modelKey of modelKeys) {
      const threshold = normalizeCompactPromptThreshold(
        modelThresholds[modelKey],
        `${configFile?.configPath}:modelPromptThresholds.${modelKey}`,
      );
      if (threshold) return threshold;
    }
    for (const [pattern, value] of Object.entries(modelThresholds)) {
      if (!pattern.includes("*") || !modelKeys.some((key) => globMatches(pattern, key))) continue;
      const threshold = normalizeCompactPromptThreshold(
        value,
        `${configFile?.configPath}:modelPromptThresholds.${pattern}`,
      );
      if (threshold) return threshold;
    }
  }

  return normalizeCompactPromptThreshold(
    configFile?.config.promptThreshold,
    `${configFile?.configPath}:promptThreshold`,
  ) ?? { percent: 80, source: "默认（80%）" };
}

function getNonResponsesMode(configFile: LoadedHandoffConfigFile | undefined): "off" | "pi" | "handoff" {
  const value = configFile?.config.nonResponses;
  return value === "pi" || value === "handoff" ? value : "off";
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

const handoffTool = {
  name: TOOL_NAME,
  description:
    "A tool to extract relevant information from the thread and select relevant files for another agent to continue the conversation.\nUse this tool to identify the most important context and files needed.",
  eager_input_streaming: true,
  parameters: Type.Object({
    relevantInformation: Type.String({
      description:
        "Extract relevant context from the conversation. Write from first person perspective (\"I did...\", \"I told you...\").\n\nConsider what's useful based on the user's request. Questions that might be relevant: What did I just do or implement? What instructions did I already give you which are still relevant (e.g. follow patterns in the codebase)? Did I provide a plan or spec that should be included? What did I already tell you that's important (certain libraries, patterns, constraints, preferences)? What important technical details did I discover (APIs, methods, patterns)? What caveats, limitations, or open questions did I find? What files did I tell you to edit that I should continue working on?\n\nExtract what matters for the specific request. Don't answer questions that aren't relevant. Pick an appropriate length based on the complexity of the request.\n\nFocus on capabilities and behavior, not file-by-file changes. Avoid excessive implementation details (variable names, storage keys, constants) unless critical.\n\nFormat: Plain text with bullets. No markdown headers, no bold/italic, no code fences. Use workspace-relative paths.",
    }),
    relevantFiles: Type.Array(Type.String(), {
      description:
        'An array of file or directory paths (workspace-relative) that are relevant to accomplishing the goal.\n\nIMPORTANT: Return as a JSON array of strings, e.g., ["lib/services/web_filtering_service.dart", "ios/Runner/AppDelegate.swift"]\n\nRules:\n- Maximum 10 files. Only include the most critical files needed for the task.\n- You can include directories if multiple files from that directory are needed\n- Prioritize by importance and relevance. PUT THE MOST IMPORTANT FILES FIRST.\n- Return workspace-relative paths (e.g., "core/src/threads/thread.ts")\n- Do not use absolute paths or invent files',
    }),
  }),
};

type HandoffContext = {
  relevantInformation: string;
  relevantFiles: string[];
};

function buildExtractionPrompt(request: string): string {
  const lines = [
    'Extract relevant context from the conversation above for continuing this work. Write from my perspective (first person: "I did...", "I told you...").',
    "",
    "Consider what would be useful to know based on my request below. Questions that might be relevant:",
    "- What did I just do or implement?",
    "- What instructions did I already give you which are still relevant (e.g. follow patterns in the codebase)?",
    "- What files did I already tell you that's important or that I am working on (and should continue working on)?",
    "- Did I provide a plan or spec that should be included?",
    "- What did I already tell you that's important (certain libraries, patterns, constraints, preferences)?",
    "- What important technical details did I discover (APIs, methods, patterns)?",
    "- What caveats, limitations, or open questions did I find?",
    "",
    "Extract what matters for the specific request below. Don't answer questions that aren't relevant. Pick an appropriate length based on the complexity of the request.",
    "",
    "Focus on capabilities and behavior, not file-by-file changes. Avoid excessive implementation details (variable names, storage keys, constants) unless critical.",
    "",
    "Format: Plain text with bullets. No markdown headers, no bold/italic, no code fences. Use workspace-relative paths for files.",
  ];

  if (request.trim()) {
    lines.push("", "My request:", "", request.trim());
  }

  lines.push(
    "",
    `Use the ${TOOL_NAME} tool to extract relevant information and files.`,
  );
  return lines.join("\n");
}

function normalizeHandoffContext(value: unknown): HandoffContext | null {
  if (!value || typeof value !== "object") return null;

  const data = value as {
    relevantInformation?: unknown;
    relevantFiles?: unknown;
  };
  if (typeof data.relevantInformation !== "string") return null;

  const relevantFiles = Array.isArray(data.relevantFiles)
    ? data.relevantFiles
        .filter(
          (file): file is string =>
            typeof file === "string" && file.trim().length > 0,
        )
        .slice(0, 10)
    : [];

  return {
    relevantInformation: data.relevantInformation.trim(),
    relevantFiles,
  };
}

function extractText(response: AssistantMessage): string {
  return response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractHandoffContext(
  response: AssistantMessage,
): HandoffContext | null {
  for (const part of response.content) {
    if (part.type !== "toolCall") continue;

    const toolCall = part as ToolCall;
    if (toolCall.name !== TOOL_NAME) continue;

    const handoff = normalizeHandoffContext(toolCall.arguments);
    if (handoff) return handoff;
  }

  const text = extractText(response);
  if (!text) return null;

  return {
    relevantInformation: text,
    relevantFiles: [],
  };
}

function formatHandoffContext(handoff: HandoffContext): string {
  const parts = [handoff.relevantInformation.trim()].filter(Boolean);

  if (handoff.relevantFiles.length > 0) {
    parts.push(
      [
        "Relevant files:",
        ...handoff.relevantFiles.map((file) => `- ${file}`),
      ].join("\n"),
    );
  }

  return parts.join("\n\n").trim();
}

function getToolChoice(model: { api: string }): unknown {
  switch (model.api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
      return { type: "tool", name: TOOL_NAME };
    case "openai-completions":
    case "mistral-conversations":
      return { type: "function", function: { name: TOOL_NAME } };
    case "google-generative-ai":
    case "google-gemini-cli":
    case "google-vertex":
      return "any";
    default:
      return undefined;
  }
}

export async function generateHandoffContext(
  args: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<string | null> {
  const sessionContext = buildSessionContext(
    ctx.sessionManager.getEntries(),
    ctx.sessionManager.getLeafId(),
  );
  const llmMessages = convertToLlm(sessionContext.messages);

  if (llmMessages.length === 0) {
    ctx.ui.notify("当前 session 没有可交接的上下文", "warning");
    return null;
  }

  const request = args.trim();
  const extractionMessage: Message = {
    role: "user",
    content: [{ type: "text", text: buildExtractionPrompt(request) }],
    timestamp: Date.now(),
  };

  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("当前对话没有选中模型", "error");
    return null;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    ctx.ui.notify(auth.error, "error");
    return null;
  }
  if (!auth.apiKey) {
    ctx.ui.notify(`没有 ${model.provider}/${model.id} 的 API key`, "error");
    return null;
  }

  const toolChoice = getToolChoice(model);
  const response = await complete(
    model,
    {
      systemPrompt: "",
      messages: [...llmMessages, extractionMessage],
      tools: [handoffTool],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 4096,
      signal,
      ...(toolChoice === undefined ? {} : { toolChoice }),
    },
  );

  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || "生成 handoff 失败");
  }
  if (response.stopReason === "aborted") {
    ctx.ui.notify("已取消生成 handoff", "info");
    return null;
  }

  const handoff = extractHandoffContext(response);
  if (!handoff || !handoff.relevantInformation.trim()) {
    throw new Error("模型没有返回可用的 handoff 内容");
  }

  return formatHandoffContext(handoff);
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatTokenCount(tokens: number): string {
  return Math.round(tokens).toLocaleString("en-US");
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

async function checkAndCompact(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (
    !ctx.model ||
    isResponsesApi(ctx.model.api) ||
    getNonResponsesMode(loadHandoffConfigFile()) !== "handoff"
  ) {
    return;
  }

  const threshold = getPromptThreshold(loadHandoffConfigFile(), ctx);
  const hit = getPromptThresholdHit({ threshold, usage: ctx.getContextUsage() });
  if (!hit.reached) return;

  // 复用 /handoff 命令：自动生成摘要 → 用户确认 → 新开 session 并发送
  notify(ctx, `上下文已达到 Handoff 阈值（${hit.reasons.join("；")}），自动生成交接摘要…`, "info");
  pi.sendUserMessage("/handoff", { expandPromptTemplates: true, deliverAs: "followUp" });
}

function handleSessionBeforeCompact(_event: SessionBeforeCompactEvent, ctx: ExtensionContext) {
  if (!ctx.model || isResponsesApi(ctx.model.api)) return undefined;

  switch (getNonResponsesMode(loadHandoffConfigFile())) {
    case "pi":
      return undefined;
    case "handoff":
      // 阈值触发走 /handoff 交接（生成 → 确认 → 新开 session），取消 Pi 内置压缩
      notify(ctx, "Handoff 模式：Pi 内置压缩已取消，达到阈值时将自动 /handoff", "info");
      return { cancel: true };
    default:
      notify(ctx, "当前供应商的 Pi 内置压缩已禁用", "warning");
      return { cancel: true };
  }
}

// 常驻注册 create_handoff_context 工具：工具定义稳定出现在每个请求的工具列表中，保证提示词缓存命中
export function registerHandoffTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Create handoff context",
		description: handoffTool.description,
		parameters: handoffTool.parameters,
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: formatHandoffContext(params) }],
			details: params,
		}),
	});
}

export default function (pi: ExtensionAPI) {
  pi.on("turn_end", (_event, ctx) => checkAndCompact(pi, ctx));
  pi.on("session_before_compact", handleSessionBeforeCompact);
  registerHandoffTool(pi);
  pi.registerCommand("handoff", {
    description: "总结当前上下文，确认内容后直接创建新 session 并发送给 agent",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff 需要交互模式以便确认", "error");
        return;
      }

      // handoff 要接管当前上下文，先停止正在运行的 agent 再等待收尾
      if (!ctx.isIdle()) ctx.abort();
      await ctx.waitForIdle();

      let summary: string | null;
      const abortController = new AbortController();
      const frames = [
        ctx.ui.theme.fg("dim", "·"),
        ctx.ui.theme.fg("muted", "•"),
        ctx.ui.theme.fg("accent", "●"),
        ctx.ui.theme.fg("muted", "•"),
      ];
      let frameIndex = 0;
      const renderLoader = () => {
        const line = ` ${frames[frameIndex]} ${ctx.ui.theme.fg("muted", "正在生成 handoff 上下文...")} ${ctx.ui.theme.fg("dim", "Esc 取消")}`;
        ctx.ui.setWidget(
          "handoff-loader",
          () => ({
            render: (width: number) => [line, " ".repeat(Math.max(1, width))],
            invalidate: () => {},
          }),
          { placement: "aboveEditor" },
        );
      };

      renderLoader();
      const interval = setInterval(() => {
        frameIndex = (frameIndex + 1) % frames.length;
        renderLoader();
      }, 180);
      const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
        if (data === "\x1b") {
          abortController.abort();
          return { consume: true };
        }
      });

      try {
        try {
          summary = await generateHandoffContext(
            args,
            ctx,
            abortController.signal,
          );
        } catch (error) {
          if (abortController.signal.aborted) {
            summary = null;
          } else {
            throw error;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      } finally {
        clearInterval(interval);
        unsubscribeInput();
        ctx.ui.setWidget("handoff-loader", undefined);
      }

      if (!summary) {
        ctx.ui.notify("已取消生成 handoff", "info");
        return;
      }

      const editedSummary = await ctx.ui.editor(
        "确认 /handoff 上下文（可编辑）",
        summary,
      );
      if (editedSummary === undefined) {
        ctx.ui.notify("已取消 handoff", "info");
        return;
      }

      const finalSummary = editedSummary.trim();
      if (!finalSummary) {
        ctx.ui.notify("handoff 内容为空，已取消", "warning");
        return;
      }

      const parentSession = ctx.sessionManager.getSessionFile();
      const result = await ctx.newSession({
        parentSession,
        withSession: async (newCtx) => {
          await newCtx.sendUserMessage(finalSummary);
        },
      });

      if (result.cancelled) {
        ctx.ui.notify("创建新 session 已取消", "info");
      }
    },
  });
}
