import { AssistantMessageComponent, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../utils";
import { getActiveTheme, getActiveThemeVersion } from "../theme-runtime";

const PATCH_FLAG = Symbol.for("pi-cc-ui:patched-assistant-message");
const PARENT_TRACK_FLAG = Symbol.for("pi-cc-ui:container-parent-tracking");

/**
 * 在 Container.addChild 时记录 child 的 parent 引用。pi-tui 的组件
 * 没有 parent 指针，而判断“消息上方是否是工具执行组件”需要它。
 */
function patchContainerParentTracking(): void {
  const proto = Container.prototype as unknown as {
    addChild: (component: unknown) => void;
    [PARENT_TRACK_FLAG]?: boolean;
  };
  if (proto[PARENT_TRACK_FLAG]) return;
  const originalAddChild = proto.addChild;
  proto.addChild = function addChildWithParent(this: Container, component: unknown) {
    originalAddChild.call(this, component);
    if (component && typeof component === "object") {
      (component as { __piCcUiParent?: unknown }).__piCcUiParent = this;
      // 恢复会话时消息只 updateContent 一次（发生在 addChild 之前，parent 未知），
      // 这里补一次去顶部 Spacer 的判断。
      if (component instanceof AssistantMessageComponent) {
        maybeRemoveLeadingSpacer(component as unknown as AssistantMessagePrototypeLike);
      }
    }
  };
  proto[PARENT_TRACK_FLAG] = true;
}

/** 判断一个组件是否是工具执行组件（ToolExecutionComponent）。 */
function isToolExecutionComponent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { toolName?: unknown; toolCallId?: unknown };
  return typeof candidate.toolName === "string" && typeof candidate.toolCallId === "string";
}

/**
 * 消息上方是工具执行组件时，去掉 pi 加的顶部 Spacer：
 * 工具的底边框已经提供了分隔，边框+空行叠在一起会多出一行间距。
 */
function maybeRemoveLeadingSpacer(instance: AssistantMessagePrototypeLike): void {
  const children = instance.contentContainer?.children;
  if (!Array.isArray(children) || children.length === 0) return;

  const parent = instance.__piCcUiParent;
  const siblings = parent?.children;
  const index = siblings ? siblings.indexOf(instance as never) : -1;
  const prev = index > 0 && siblings ? siblings[index - 1] : undefined;
  if (isToolExecutionComponent(prev) && children[0]?.constructor.name === "Spacer") {
    children.shift();
  }
}

const BULLET_PREFIX = " ● ";
const THINKING_PREFIX = " * ";

const ITALIC_ON = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";
const COLOR_RESET = "\x1b[39m";

const THINKING_LABEL_PREFIX_PATTERN = /^(?:thinking:\s*)+/i;

function repeatSpaces(n: number): string {
  return " ".repeat(Math.max(0, n));
}

/**
 * 压缩无用的空行:去掉首尾空行,连续空行折叠为 1 个(保留段落分隔)。
 * 不用 trim(),避免破坏行首 4 空格缩进的代码块。
 */
function collapseBlankLines(text: string): string {
  return text
    .replace(/^\s*\n/, "")
    .replace(/\n\s*$/, "")
    .replace(/\n(?:[ \t]*\n)+/g, "\n\n");
}

/**
 * Extract the opening ANSI prefix from a theme-fg call.
 * `theme.fg("thinkingText", sentinel)` produces something like
 * `\x1b[38;5;XXXmSENTINEL\x1b[0m`; we return everything before the sentinel.
 */
function extractFgPrefix(theme: Theme | { fg: (color: ThemeColor, text: string) => string }, colorName: ThemeColor): string {
  const sentinel = "\x00";
  const full = theme.fg(colorName, sentinel);
  const idx = full.indexOf(sentinel);
  return idx >= 0 ? full.slice(0, idx) : "";
}

class BulletParagraph {
  private markdown: Markdown;

  constructor(text: string, markdownTheme: ConstructorParameters<typeof Markdown>[3]) {
    this.markdown = new Markdown(collapseBlankLines(text), 0, 0, markdownTheme);
  }

  invalidate(): void {
    this.markdown.invalidate();
  }

  render(width: number): string[] {
    const prefixWidth = visibleWidth(BULLET_PREFIX);
    if (width <= prefixWidth) return [BULLET_PREFIX];

    const lines = this.markdown.render(width - prefixWidth);
    const indent = repeatSpaces(prefixWidth);
    let placed = false;

    // 防御: 裁剪渲染输出的首尾空行,避免与上下相邻块叠加成多余空行。
    while (lines.length > 0 && stripAnsi(lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }

    return lines.map((line) => {
      if (!placed && stripAnsi(line).trim()) {
        placed = true;
        return `${BULLET_PREFIX}${line}`;
      }
      return `${indent}${line}`;
    });
  }
}

class ThinkingParagraph {
  private markdown: Markdown;
  private markdownKey = "";

  constructor(text: string) {
    // The Markdown is created lazily in render() because we need the
    // active theme colours which aren't available at construction time.
    this.markdown = null as unknown as Markdown;
    // Stash text for lazy Markdown creation.
    (this as any).__thinkingText = text;
  }

  invalidate(): void {
    this.markdown?.invalidate();
  }

  private ensureMarkdown(): void {
    const text = (this as any).__thinkingText as string;
    const key = `${text}\0${getActiveThemeVersion()}`;
    if (this.markdown && this.markdownKey === key) return;
    this.markdownKey = key;

    // Strip ANSI codes, then also strip the "Thinking: " text label that
    // handleThinkingMessageUpdateEvent injected so it doesn't eat into the
    // available content width and throw off wrapping relative to BulletParagraph.
    let plainText = stripAnsi(text);
    plainText = collapseBlankLines(plainText.replace(THINKING_LABEL_PREFIX_PATTERN, ""));

    const theme = getActiveTheme();
    const colorPrefix = extractFgPrefix(theme, "thinkingText");
    const wrapStyle = (value: string) => `${colorPrefix}${ITALIC_ON}${value}${ITALIC_OFF}${COLOR_RESET}`;

    // Flatten all markdown constructs to themed dim+italic so the output
    // stays monochrome, but route through Markdown.render so line wrapping
    // and padding match BulletParagraph exactly.
    const plainTheme: ConstructorParameters<typeof Markdown>[3] = {
      heading: wrapStyle,
      link: wrapStyle,
      linkUrl: wrapStyle,
      code: wrapStyle,
      codeBlock: wrapStyle,
      codeBlockBorder: wrapStyle,
      quote: wrapStyle,
      quoteBorder: wrapStyle,
      hr: wrapStyle,
      listBullet: wrapStyle,
      bold: wrapStyle,
      italic: wrapStyle,
      strikethrough: wrapStyle,
      underline: wrapStyle,
      highlightCode: (code: string) => code.split("\n").map(wrapStyle),
    };

    this.markdown = new Markdown(plainText, 0, 0, plainTheme, {
      italic: true,
      color: wrapStyle,
    });
  }

  render(width: number): string[] {
    const prefixWidth = visibleWidth(THINKING_PREFIX);
    if (width <= prefixWidth) return [THINKING_PREFIX];

    this.ensureMarkdown();
    const lines = this.markdown.render(width - prefixWidth);
    const indent = repeatSpaces(prefixWidth);
    let placed = false;

    // 防御: 裁剪渲染输出的首尾空行。尾部空行会与后续块的 Spacer 叠加成两个空行。
    while (lines.length > 0 && stripAnsi(lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }

    return lines.map((line) => {
      if (!placed && stripAnsi(line).trim()) {
        placed = true;
        return `${THINKING_PREFIX}${line}`;
      }
      return `${indent}${line}`;
    });
  }
}

interface AssistantMessagePrototypeLike {
  updateContent: (message: unknown) => void;
  markdownTheme?: ConstructorParameters<typeof Markdown>[3];
  contentContainer?: { children?: unknown[] };
  __piCcUiOriginalUpdateContent?: (message: unknown) => void;
  __piCcUiAssistantPatched?: boolean;
  __piCcUiParent?: { children?: unknown[] };
}

export function patchAssistantMessageComponent(): void {
  patchContainerParentTracking();

  const proto = AssistantMessageComponent.prototype as unknown as AssistantMessagePrototypeLike;

  if (proto.__piCcUiAssistantPatched || (proto as { [PATCH_FLAG]?: boolean })[PATCH_FLAG]) {
    return;
  }

  if (!proto.__piCcUiOriginalUpdateContent) {
    proto.__piCcUiOriginalUpdateContent = proto.updateContent;
  }

  const originalUpdateContent = proto.__piCcUiOriginalUpdateContent;

  proto.updateContent = function updateContentPatched(this: AssistantMessagePrototypeLike, message: unknown): void {
    originalUpdateContent?.call(this, message);

    const children = this.contentContainer?.children;
    if (!Array.isArray(children)) return;

    maybeRemoveLeadingSpacer(this);

    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (!(child instanceof Markdown)) continue;

      const markdownChild = child as any;
      const text = markdownChild.text;
      if (typeof text !== "string" || !text.trim()) continue;

      const isThinking = Boolean(markdownChild.defaultTextStyle?.italic);
      if (!isThinking && !this.markdownTheme) continue;
      children[index] = isThinking
        ? new ThinkingParagraph(text)
        : new BulletParagraph(text, this.markdownTheme!);
    }
  };

  proto.__piCcUiAssistantPatched = true;
  (proto as { [PATCH_FLAG]?: boolean })[PATCH_FLAG] = true;
}