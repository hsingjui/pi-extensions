import {
  complete,
  Type,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionContext,
  convertToLlm,
} from "@earendil-works/pi-coding-agent";

const TOOL_NAME = "create_handoff_context";

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

async function generateHandoffContext(
  args: string,
  ctx: ExtensionCommandContext,
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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "总结当前上下文，确认内容后直接创建新 session 并发送给 agent",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/handoff 需要交互模式以便确认", "error");
        return;
      }

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
