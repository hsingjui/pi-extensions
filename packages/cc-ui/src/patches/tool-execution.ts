import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatCallStatus, getCompactToolCallRenderer, getCompactToolResultRenderer } from "../tool-display";
import { getActiveTheme } from "../theme-runtime";
import { applyToolBackgroundMode, decorateToolRender, withBranch } from "../tool-style";

interface BoxLike {
  paddingX?: number;
  paddingY?: number;
  setBgFn?: (bgFn?: (text: string) => string) => void;
}

interface TextLike {
  paddingX?: number;
  paddingY?: number;
  setCustomBgFn?: (bgFn?: (text: string) => string) => void;
}

interface ToolExecutionPrototypeLike {
  updateDisplay: () => void;
  render?: (width: number) => string[];
  getCallRenderer?: () => unknown;
  getResultRenderer?: () => unknown;
  createCallFallback?: () => unknown;
  createResultFallback?: () => unknown;
  contentBox?: BoxLike;
  contentText?: TextLike;
  selfRenderContainer?: { children?: unknown[] };
  toolName?: string;
  args?: unknown;
  result?: { content?: unknown; details?: unknown; isError?: boolean };
  isPartial?: boolean;
  expanded?: boolean;
  executionStarted?: boolean;
  getTextOutput?: () => string;
  formatToolExecution?: () => string;
  invalidate?: () => void;
  setExpanded?: (expanded: boolean) => void;
  state?: { __piCcUiBlinkPhase?: boolean; __piCcUiBlinkTimer?: ReturnType<typeof setInterval> };
  __piCcUiToolExecutionPatched?: boolean | string;
  __piCcUiOriginalUpdateDisplay?: () => void;
  __piCcUiOriginalGetCallRenderer?: () => unknown;
  __piCcUiOriginalGetResultRenderer?: () => unknown;
  __piCcUiOriginalCreateCallFallback?: () => unknown;
  __piCcUiOriginalCreateResultFallback?: () => unknown;
  __piCcUiOriginalSetExpanded?: (expanded: boolean) => void;
  __piCcUiOriginalRender?: (width: number) => string[];
  __piCcUiParent?: { children?: unknown[] };
}

function followsVisibleAssistantText(instance: ToolExecutionPrototypeLike): boolean {
  const siblings = instance.__piCcUiParent?.children;
  const index = siblings?.indexOf(instance as never) ?? -1;
  const previous = index > 0 ? siblings?.[index - 1] : undefined;
  if (!(previous instanceof AssistantMessageComponent)) return false;

  const content = (previous as unknown as { lastMessage?: { content?: unknown } }).lastMessage?.content;
  return Array.isArray(content) && content.some((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getString(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function getNumber(value: unknown, field: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function splitLines(text: string): string[] {
  return text.replace(/\r/g, "").split("\n");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatCompactArgs(args: unknown): string {
  if (!isRecord(args)) return "";
  const entries = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 5);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => {
    const val = typeof v === "string" ? truncateStr(v, 40) : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
    return val !== undefined ? `${k}: ${val}` : k;
  });
  return getActiveTheme().fg("muted", ` · ${parts.join(", ")}`);
}

function setupBlinkTimer(instance: ToolExecutionPrototypeLike): void {
  instance.state ??= {};
  if (instance.state.__piCcUiBlinkTimer) return;
  instance.state.__piCcUiBlinkPhase = true;
  instance.state.__piCcUiBlinkTimer = setInterval(() => {
    if (!instance.state) return;
    instance.state.__piCcUiBlinkPhase = !instance.state.__piCcUiBlinkPhase;
    instance.invalidate?.();
  }, 500);
}

function clearBlinkTimer(instance: ToolExecutionPrototypeLike): void {
  const timer = instance.state?.__piCcUiBlinkTimer;
  if (!timer) return;
  clearInterval(timer);
  if (instance.state) {
    instance.state.__piCcUiBlinkTimer = undefined;
    instance.state.__piCcUiBlinkPhase = true;
  }
}

function formatStatusBadge(instance: ToolExecutionPrototypeLike): string {
  const theme = getActiveTheme();

  if (instance.result?.isError) {
    clearBlinkTimer(instance);
    return `${theme.fg("error", "●")} `;
  }

  if (instance.isPartial) {
    setupBlinkTimer(instance);
    return `${instance.state?.__piCcUiBlinkPhase ? theme.fg("success", "●") : theme.fg("muted", "○")} `;
  }

  clearBlinkTimer(instance);
  return `${theme.fg("success", "●")} `;
}

function formatMcpCallTarget(args: unknown): string {
  const tool = getString(args, "tool");
  const connect = getString(args, "connect");
  const describe = getString(args, "describe");
  const search = getString(args, "search");
  const server = getString(args, "server");
  const action = getString(args, "action");

  if (tool) {
    return server ? `call ${tool} @${server}` : `call ${tool}`;
  }
  if (connect) {
    return `connect ${connect}`;
  }
  if (describe) {
    return server ? `describe ${describe} @${server}` : `describe ${describe}`;
  }
  if (search) {
    return server ? `search "${search}" @${server}` : `search "${search}"`;
  }
  if (server) {
    return `list ${server}`;
  }
  if (action) {
    return action === "ui-messages" ? "ui messages" : action;
  }
  return "status";
}

function formatMcpCollapsedHint(text: string): string {
  const lines = splitLines(text).filter((line) => line.trim().length > 0);
  if (lines.length <= 0) return "";
  return getActiveTheme().fg("muted", ` · ${lines.length} ${pluralize(lines.length, "line")}`);
}

function formatMcpSummary(instance: ToolExecutionPrototypeLike): string {
  const theme = getActiveTheme();
  const details = instance.result?.details;
  const text = instance.getTextOutput?.() ?? "";
  const mode = getString(details, "mode");

  if (instance.result?.isError) {
    return theme.fg("muted", "mcp request failed");
  }

  switch (mode) {
    case "search": {
      const count = getNumber(details, "count") ?? 0;
      const query = getString(details, "query");
      return theme.fg("muted", `${count} ${pluralize(count, "tool")} matched${query ? ` "${query}"` : ""}`);
    }
    case "status": {
      const totalTools = getNumber(details, "totalTools") ?? 0;
      const connectedCount = getNumber(details, "connectedCount") ?? 0;
      const servers = isRecord(details) && Array.isArray(details.servers) ? details.servers.length : 0;
      return theme.fg("muted", `${connectedCount}/${servers} servers connected · ${totalTools} tools`);
    }
    case "list": {
      const server = getString(details, "server") ?? "server";
      const count = getNumber(details, "count") ?? 0;
      return theme.fg("muted", `${server} · ${count} ${pluralize(count, "tool")}`);
    }
    case "describe": {
      const server = getString(details, "server");
      const tool = isRecord(details) && isRecord(details.tool) ? getString(details.tool, "name") : undefined;
      return theme.fg("muted", `describe ${tool ?? "tool"}${server ? ` @${server}` : ""}`);
    }
    case "connect": {
      const server = getString(details, "server") ?? "server";
      return theme.fg("muted", `connected ${server}`);
    }
    case "call": {
      const server = getString(details, "server");
      const tool = getString(details, "tool") ?? getString(instance.args, "tool") ?? "tool";
      const uiOpen = isRecord(details) && details.uiOpen === true;
      const suffix = text ? formatMcpCollapsedHint(text) : "";
      return theme.fg("muted", `called ${tool}${server ? ` @${server}` : ""}${uiOpen ? " · ui opened" : ""}`) + suffix;
    }
    default: {
      if (!text.trim()) {
        return theme.fg("muted", "no output");
      }
      const lineCount = splitLines(text).filter((line) => line.trim().length > 0).length;
      return theme.fg("muted", `${lineCount} ${pluralize(lineCount, "line")} returned`);
    }
  }
}

function renderMcpExpandedText(text: string): string {
  const lines = splitLines(text);
  const shown = lines.slice(0, 16);
  const remaining = Math.max(0, lines.length - shown.length);
  let rendered = shown.join("\n");
  if (remaining > 0) {
    rendered += `\n${getActiveTheme().fg("muted", `… ${remaining} more ${pluralize(remaining, "line")}`)}`;
  }
  return rendered;
}

function getNeutralToolBackground(): ((text: string) => string) | undefined {
  try {
    return (text: string) => getActiveTheme().bg("toolPendingBg", text);
  } catch {
    return undefined;
  }
}

const TOOL_EXECUTION_PATCH_VERSION = "assistant-tool-spacing-v2";

export function patchToolExecutionComponent(): void {
  const proto = ToolExecutionComponent.prototype as unknown as ToolExecutionPrototypeLike;

  if (proto.__piCcUiToolExecutionPatched === TOOL_EXECUTION_PATCH_VERSION) {
    return;
  }

  if (!proto.__piCcUiOriginalUpdateDisplay) {
    proto.__piCcUiOriginalUpdateDisplay = proto.updateDisplay;
  }
  if (!proto.__piCcUiOriginalGetCallRenderer) {
    proto.__piCcUiOriginalGetCallRenderer = proto.getCallRenderer;
  }
  if (!proto.__piCcUiOriginalGetResultRenderer) {
    proto.__piCcUiOriginalGetResultRenderer = proto.getResultRenderer;
  }
  if (!proto.__piCcUiOriginalCreateCallFallback) {
    proto.__piCcUiOriginalCreateCallFallback = proto.createCallFallback;
  }
  if (!proto.__piCcUiOriginalCreateResultFallback) {
    proto.__piCcUiOriginalCreateResultFallback = proto.createResultFallback;
  }
  if (!proto.__piCcUiOriginalSetExpanded) {
    proto.__piCcUiOriginalSetExpanded = proto.setExpanded;
  }
  if (!proto.__piCcUiOriginalRender) {
    proto.__piCcUiOriginalRender = proto.render;
  }

  const originalGetCallRenderer = proto.__piCcUiOriginalGetCallRenderer;
  const originalGetResultRenderer = proto.__piCcUiOriginalGetResultRenderer;
  const originalCreateCallFallback = proto.__piCcUiOriginalCreateCallFallback;
  const originalCreateResultFallback = proto.__piCcUiOriginalCreateResultFallback;
  const originalUpdateDisplay = proto.__piCcUiOriginalUpdateDisplay;
  const originalSetExpanded = proto.__piCcUiOriginalSetExpanded;
  const originalRender = proto.__piCcUiOriginalRender;

  proto.formatToolExecution = function formatToolExecutionPatched(this: ToolExecutionPrototypeLike): string {
    const badge = formatStatusBadge(this);
    const rawName = String(this.toolName ?? "tool");
    const displayName = rawName.length > 0 ? rawName.slice(0, 1).toUpperCase() + rawName.slice(1) : "Tool";
    const theme = getActiveTheme();
    const name = theme.fg("toolTitle", theme.bold(displayName));
    const args = formatCompactArgs(this.args);
    let text = `${badge}${name}${args}`;
    if (!this.isPartial) {
      const output = this.getTextOutput?.() ?? "";
      if (output.trim()) text += `\n${output}`;
    }
    return text;
  };

  proto.getCallRenderer = function getCallRendererPatched(this: ToolExecutionPrototypeLike): unknown {
    const compactRenderer = this.toolName ? getCompactToolCallRenderer(this.toolName) : undefined;
    if (compactRenderer) return compactRenderer;

    const original = originalGetCallRenderer?.call(this);
    if (!original) return undefined;

    // 第三方/扩展工具自带 renderCall(如 fff、pi-mcp-adapter)时不带状态圆点,
    // 与内置工具不一致。这里包一层,在渲染结果前补上与内置工具相同的 ●/○ 状态点。
    return (args: unknown, theme: unknown, context: unknown) => {
      const rendered = (original as (args: unknown, theme: unknown, context: unknown) => unknown)(args, theme, context);
      if (!(rendered instanceof Text)) return rendered;
      const content = String((rendered as unknown as { text?: unknown }).text ?? "");
      if (content.startsWith("●") || content.startsWith("○")) return rendered;
      rendered.setText(`${formatCallStatus(context as Parameters<typeof formatCallStatus>[0], theme as never)}${content}`);
      return rendered;
    };
  };

  proto.getResultRenderer = function getResultRendererPatched(this: ToolExecutionPrototypeLike): unknown {
    if (this.toolName === "mcp") {
      // mcp 结果强制走 createResultFallback 的摘要格式(带 └─ 分支),
      // 与内置工具一致;pi-mcp-adapter 自带的 renderResult 没有分支线。
      return undefined;
    }
    const compactRenderer = this.toolName ? getCompactToolResultRenderer(this.toolName) : undefined;
    return compactRenderer ?? originalGetResultRenderer?.call(this);
  };

  proto.createCallFallback = function createCallFallbackPatched(this: ToolExecutionPrototypeLike): unknown {
    if (this.toolName === "mcp") {
      const theme = getActiveTheme();
      const line = `${formatStatusBadge(this)}${theme.fg("toolTitle", theme.bold("MCP"))} ${theme.fg("accent", formatMcpCallTarget(this.args))}`;
      return new Text(line, 0, 0);
    }

    return originalCreateCallFallback?.call(this);
  };

  proto.createResultFallback = function createResultFallbackPatched(this: ToolExecutionPrototypeLike): unknown {
    if (this.toolName === "mcp") {
      const summary = formatMcpSummary(this);
      const text = this.getTextOutput?.() ?? "";

      if (!this.expanded || !text.trim()) {
        return new Text(withBranch(summary, getActiveTheme()), 0, 0);
      }

      return new Text(withBranch(`${summary}\n${renderMcpExpandedText(text)}`, getActiveTheme()), 0, 0);
    }

    return originalCreateResultFallback?.call(this);
  };

  proto.render = function renderPatched(this: ToolExecutionPrototypeLike, width: number): string[] {
    const lines = originalRender?.call(this, width) ?? [];
    // self shell（如 edit）的核心 render 直接返回 selfRenderContainer 的行，
    // 绕过 Container.prototype.render 的边框装饰，这里补上。
    const decorated = decorateToolRender(lines, width);
    return followsVisibleAssistantText(this) && decorated[0]?.trim() ? ["", ...decorated] : decorated;
  };

  proto.setExpanded = function setExpandedPatched(this: ToolExecutionPrototypeLike, expanded: boolean): void {
    const nextExpanded = this.toolName === "bash" ? true : expanded;
    if (originalSetExpanded) {
      originalSetExpanded.call(this, nextExpanded);
      return;
    }
    this.expanded = nextExpanded;
    this.updateDisplay();
  };

  proto.updateDisplay = function updateDisplayPatched(this: ToolExecutionPrototypeLike): void {
    applyToolBackgroundMode(getActiveTheme());
    originalUpdateDisplay.call(this);

    const neutralBgFn = getNeutralToolBackground();

    if (this.contentBox) {
      this.contentBox.paddingX = 1;
      this.contentBox.paddingY = 0;
      this.contentBox.setBgFn?.(neutralBgFn);
    }

    if (this.contentText) {
      this.contentText.paddingX = 1;
      this.contentText.paddingY = 0;
      this.contentText.setCustomBgFn?.(neutralBgFn);
    }

    // self shell（如 edit）的内容容器是 Container，没有 Box 的左内边距；
    // 扩展的 compact renderer 返回的是 paddingX=0 的 Text，不补缩进会紧贴屏幕左侧。
    for (const child of this.selfRenderContainer?.children ?? []) {
      const candidate = child as { paddingX?: unknown } | null | undefined;
      if (candidate && typeof candidate.paddingX === "number") {
        candidate.paddingX = 1;
      }
    }
  };

  proto.__piCcUiToolExecutionPatched = TOOL_EXECUTION_PATCH_VERSION;
}
