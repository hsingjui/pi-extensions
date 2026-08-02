import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  type DefaultTextStyle,
  type MarkdownTheme,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PROMPT_PREFIX, USER_MESSAGE_TOP_SPACING } from "../constants";
import { stripAnsi } from "../utils";

const BG_USER_MSG = "\x1b[48;2;55;55;55m";
const BG_RESET = "\x1b[49m";
const BG_ESCAPE_RE = /\x1b\[(?:49|4\d|10\d|48;5;\d+|48;2;\d+;\d+;\d+)m/g;

function stripBackgroundAnsi(text: string): string {
  return text.replace(BG_ESCAPE_RE, "");
}

function withUserMessageBg(text: string): string {
  return `${BG_USER_MSG}${stripBackgroundAnsi(text)}${BG_RESET}`;
}

function isMarkdownLike(
  value: unknown,
): value is {
  text: string;
  theme: MarkdownTheme;
  defaultTextStyle?: DefaultTextStyle;
  render: (width: number) => string[];
} {
  return !!value && typeof value === "object" && "text" in value && "theme" in value && "render" in value;
}

interface UserMessagePrototypeLike {
  render: (width: number) => string[];
  children?: unknown[];
  __piCcUiPatched?: boolean;
  __piCcUiOriginalRender?: (width: number) => string[];
  __piCcUiCompactMd?: Markdown;
  __piCcUiCompactMdKey?: string;
}

export function patchUserMessageComponent(): void {
  const proto = UserMessageComponent.prototype as unknown as UserMessagePrototypeLike;

  if (proto.__piCcUiPatched) {
    return;
  }

  if (!proto.__piCcUiOriginalRender) {
    proto.__piCcUiOriginalRender = proto.render;
  }

  const originalRender = proto.__piCcUiOriginalRender;

  proto.render = function (this: UserMessagePrototypeLike, width: number): string[] {
    const children = this.children;
    if (children && Array.isArray(children)) {
      for (const child of children) {
        if (child instanceof Markdown || isMarkdownLike(child)) {
          const md = child as {
            text: string;
            theme: MarkdownTheme;
            defaultTextStyle?: DefaultTextStyle;
          };

          const displayPromptPrefix = PROMPT_PREFIX.trimEnd();
          const spacerWidth = visibleWidth(displayPromptPrefix);
          const spacer = withUserMessageBg(" ".repeat(spacerWidth));
          const promptPrefix = withUserMessageBg(displayPromptPrefix);
          const contentWidth = Math.max(1, width - spacerWidth);
          const fillUserMessageLine = (text: string) => withUserMessageBg(truncateToWidth(stripBackgroundAnsi(text), contentWidth, "", true));

          // 文本/样式不变时复用同一个 Markdown 实例，避免每帧重新解析标记。
          const cacheKey = md.text;
          let compactMd = this.__piCcUiCompactMd;
          if (!compactMd || this.__piCcUiCompactMdKey !== cacheKey) {
            compactMd = new Markdown(
              md.text,
              0,
              0,
              md.theme,
              {
                ...md.defaultTextStyle,
                bgColor: (text: string) => `\x1b[48;2;55;55;55m${text}\x1b[49m`,
              },
            );
            this.__piCcUiCompactMd = compactMd;
            this.__piCcUiCompactMdKey = cacheKey;
          }

          const lines = compactMd.render(contentWidth);
          if (lines.length === 0) return lines;

          const contentLines = lines.map((line, index) => {
            const normalizedLine = line.startsWith(" ") ? line.slice(1) : line;
            const filled = fillUserMessageLine(normalizedLine);
            return index === 0 ? `${promptPrefix}${filled}` : `${spacer}${filled}`;
          });
          const topSpacing = Array.from({ length: USER_MESSAGE_TOP_SPACING }, () => "");
          return [...topSpacing, ...contentLines];
        }
      }
    }

    const lines = originalRender.call(this, width);
    let start = 0;
    let end = lines.length;

    while (start < end && stripAnsi(lines[start] ?? "").trim().length === 0) start++;
    while (end > start && stripAnsi(lines[end - 1] ?? "").trim().length === 0) end--;

    const trimmed = lines.slice(start, end);
    if (trimmed.length === 0) return trimmed;

    const displayPromptPrefix = PROMPT_PREFIX.trimEnd();
    const spacerWidth = visibleWidth(displayPromptPrefix);
    const spacer = withUserMessageBg(" ".repeat(spacerWidth));
    const promptPrefix = withUserMessageBg(displayPromptPrefix);
    const fillUserMessageLine = (text: string) => withUserMessageBg(truncateToWidth(stripBackgroundAnsi(text), Math.max(1, width - spacerWidth), "", true));
    const contentLines = trimmed.map((line, index) => {
      const normalizedLine = line.startsWith(" ") ? line.slice(1) : line;
      const filled = fillUserMessageLine(normalizedLine);
      return index === 0 ? `${promptPrefix}${filled}` : `${spacer}${filled}`;
    });

    const topSpacing = Array.from({ length: USER_MESSAGE_TOP_SPACING }, () => "");
    return [...topSpacing, ...contentLines];
  };

  proto.__piCcUiPatched = true;
}
