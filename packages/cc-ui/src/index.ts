import { VERSION as PI_VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  countTextLength,
  extractAssistantMessage,
  getAssistantOutputTokens,
  handleThinkingContextEvent,
  handleThinkingMessageEndEvent,
  handleThinkingMessageUpdateEvent,
  hasThinking,
  hasToolCall,
} from "./agent-message";
import { patchAssistantMessageComponent } from "./patches/assistant-message";
import { patchToolExecutionComponent } from "./patches/tool-execution";
import { patchUserMessageComponent } from "./patches/user-message";
import { applyToolBackgroundMode, patchGlobalToolBorders, registerMcpToolOverrides } from "./tool-style";
import { setActiveTheme } from "./theme-runtime";
import { PromptPrefixEditor } from "./ui/prompt-prefix-editor";
import {
  getActiveSpinner,
  patchLoaderPrototype,
  stopActiveSpinner,
} from "./ui/spinner";
import { createStartupHeader } from "./ui/startup-header";

// 模块加载时就打补丁，确保消息组件首次渲染前已生效。
patchAssistantMessageComponent();
patchToolExecutionComponent();
patchUserMessageComponent();
patchLoaderPrototype();
patchGlobalToolBorders();

const EXTENSION_VERSION = "0.1.0";

export default function (pi: ExtensionAPI) {
  registerMcpToolOverrides(pi);

  pi.on("session_start", async (_event, ctx) => {
    setActiveTheme(ctx.ui.theme);
    ctx.ui.setHeader((_tui, theme) => createStartupHeader(theme, {
      cwd: process.cwd(),
      version: EXTENSION_VERSION,
      piVersion: PI_VERSION,
    }));
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new PromptPrefixEditor(tui, theme, keybindings, ctx.ui.theme),
    );
    applyToolBackgroundMode(ctx.ui.theme);
  });

  pi.on("turn_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      setActiveTheme(ctx.ui.theme);
      applyToolBackgroundMode(ctx.ui.theme);
    }
  });

  pi.on("agent_end", async () => {
    stopActiveSpinner();
  });

  pi.on("message_update", async (event, ctx) => {
    handleThinkingMessageUpdateEvent(event, ctx);

    const message = extractAssistantMessage(event);
    if (!message || !Array.isArray(message.content)) return;

    const activeSpinner = getActiveSpinner();
    if (!activeSpinner) return;

    const thinking = hasThinking(message.content);

    if (hasToolCall(message.content)) {
      activeSpinner.setMode("tool_use");
    } else if (thinking) {
      const textLen = countTextLength(message.content);
      activeSpinner.setMode(textLen > 0 ? "responding" : "thinking");
    } else {
      activeSpinner.setMode("responding");
    }

    activeSpinner.updateEstimatedTokensFromText(countTextLength(message.content));
  });

  pi.on("message_end", async (event, ctx) => {
    handleThinkingMessageEndEvent(event, ctx);

    const activeSpinner = getActiveSpinner();
    if (!activeSpinner) return;

    const message = extractAssistantMessage(event);
    const outputTokens = getAssistantOutputTokens(message);
    if (outputTokens !== null) {
      activeSpinner.setExactOutputTokens(outputTokens);
    }
  });

  pi.on("context", async (event, ctx) => {
    handleThinkingContextEvent(event, ctx);
  });

}
