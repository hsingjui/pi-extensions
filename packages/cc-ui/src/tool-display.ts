import type {
  AgentToolResult,
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  EditToolInput,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  Theme,
  ToolRenderResultOptions,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";

import { getCapabilities, getImageDimensions, imageFallback, Text, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { bashCollapsedLimit, buildPreviewText as buildReferencePreviewText, diffCollapsedLimit, diffSummaryWithMeta, dirIcon, fileIcon, getEditOperations, highlightCodeBlock, lang, lineCount, parseDiff, previewLimit, renderSplit, resolveDiffColors, summarizeEditOperations, summarizeText, withBranch } from "./tool-style";
import { isRecord } from "./utils";

interface TextBlockLike {
  type?: unknown;
  text?: unknown;
}

interface ImageBlockLike {
  type?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

interface TruncationLike {
  truncated?: unknown;
  totalLines?: unknown;
}

interface ToolResultLike {
  content?: unknown;
  details?: unknown;
  isError?: unknown;
}

interface WritePreviewCarrier {
  __piCcUiWritePreview?: {
    key: string;
    lineCount: number;
    sizeBytes: number;
  };
}

interface PendingDiffPreviewData {
  filePath: string;
  previousContent?: string;
  nextContent?: string;
  fileExistedBeforeWrite: boolean;
  headerLabel: string;
  notice?: string;
}

interface PendingDiffPreviewState {
  key?: string;
  data?: PendingDiffPreviewData;
}

type EditReplacement = {
  oldText: string;
  newText: string;
};

type FileReadResult = {
  exists: boolean;
  content?: string;
  error?: string;
};

interface ToolRenderContextLike<TArgs> {
  args: TArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: unknown;
  state: unknown;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

interface BlinkState {
  blinkPhase?: boolean;
  blinkTimer?: ReturnType<typeof setInterval>;
}

interface BlinkCarrier {
  __piCcUiBlink?: BlinkState;
}



const READ_COLLAPSED_PREVIEW_LINES = 6;
const READ_EXPANDED_PREVIEW_LINES = 32;
const BASH_COLLAPSED_PREVIEW_LINES = 4;
const BASH_EXPANDED_PREVIEW_LINES = 10;
const BASH_PREVIEW_MAX_CHARS = 4000;
const DIFF_COLLAPSED_PREVIEW_LINES = 10;
const DIFF_EXPANDED_PREVIEW_LINES = 40;

const BLINK_INTERVAL_MS = 800;
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const STYLE_RESET_PARAMS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;




function toText(lastComponent: unknown): Text {
  return lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
}

function reuseText(lastComponent: unknown, nextText: string): Text {
  const text = toText(lastComponent);
  text.setText(nextText);
  return text;
}

function shortenPath(path: string | undefined): string {
  if (!path) return "";
  const home = homedir();
  return truncateMiddle(path.startsWith(home) ? `~${path.slice(home.length)}` : path, 52, 24, 20);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\r/g, "").split("\n").map((line) => line.replace(/\t/g, "    "));
}

function truncateMiddle(text: string, maxWidth: number, headWidth: number, tailWidth: number): string {
  if (!text) return text;

  const glyphs = Array.from(text);
  if (visibleWidth(text) <= maxWidth || glyphs.length <= 3) {
    return text;
  }

  const head = glyphs.slice(0, Math.max(1, headWidth)).join("");
  const tail = glyphs.slice(Math.max(headWidth, glyphs.length - Math.max(1, tailWidth))).join("");
  return `${head}…${tail}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  const next = [...lines];
  while (next.length > 0 && next[next.length - 1]?.trim().length === 0) {
    next.pop();
  }
  return next;
}

function collapseEmptyLines(lines: string[], maxConsecutive = 1): string[] {
  const compacted: string[] = [];
  let consecutiveEmpty = 0;

  for (const line of lines) {
    if (line.trim().length === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty > maxConsecutive) continue;
    } else {
      consecutiveEmpty = 0;
    }
    compacted.push(line);
  }

  return compacted;
}

function previewLines(lines: string[], maxLines: number): { shown: string[]; remaining: number } {
  const shown = lines.slice(0, Math.max(0, maxLines));
  return { shown, remaining: Math.max(0, lines.length - shown.length) };
}

function previewTailLines(lines: string[], maxLines: number): { shown: string[]; remaining: number } {
  const limit = Math.max(0, maxLines);
  const shown = limit === 0 ? [] : lines.slice(-limit);
  return { shown, remaining: Math.max(0, lines.length - shown.length) };
}

function toSgrParams(rawParams: string): number[] {
  if (!rawParams.trim()) return [0];

  const parsed = rawParams
    .split(";")
    .map((token) => Number.parseInt(token, 10))
    .filter((value) => Number.isFinite(value));

  return parsed.length > 0 ? parsed : [];
}

function sanitizeSgrParams(params: number[]): number[] {
  const sanitized: number[] = [];

  for (let index = 0; index < params.length; index += 1) {
    const param = params[index] ?? 0;

    if (param === 0) {
      sanitized.push(...STYLE_RESET_PARAMS);
      continue;
    }

    if (param === 49) continue;

    if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
      continue;
    }

    if (param === 48) {
      const colorMode = params[index + 1];
      if (colorMode === 5) {
        index += 2;
        continue;
      }
      if (colorMode === 2) {
        index += 4;
        continue;
      }
      continue;
    }

    sanitized.push(param);
  }

  return sanitized;
}

function sanitizeAnsiForThemedOutput(text: string): string {
  if (!text || !text.includes("\x1b[")) return text;

  return text.replace(ANSI_SGR_PATTERN, (_sequence, rawParams: string) => {
    const parsed = toSgrParams(rawParams);
    if (parsed.length === 0) return "";

    const sanitized = sanitizeSgrParams(parsed);
    if (sanitized.length === 0) return "";

    return `\x1b[${sanitized.join(";")}m`;
  });
}

function extractTextOutput(result: ToolResultLike): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter((block): block is TextBlockLike => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function extractFirstTextBlock(result: ToolResultLike): string | undefined {
  const blocks = Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return undefined;
}

function getImageBlocks(result: ToolResultLike): Array<{ data?: string; mimeType?: string }> {
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter((block): block is ImageBlockLike => isRecord(block) && block.type === "image")
    .map((block) => ({
      data: typeof block.data === "string" ? block.data : undefined,
      mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
    }));
}

function hasImageOutput(result: ToolResultLike): boolean {
  return getImageBlocks(result).length > 0;
}

function isToolError(result: ToolResultLike, context: { isError: boolean }): boolean {
  return context.isError || result.isError === true;
}

function getPreviewLimit(options: ToolRenderResultOptions, collapsed: number, expanded: number): number {
  return options.expanded ? expanded : collapsed;
}

function prepareOutputLines(text: string): string[] {
  return collapseEmptyLines(trimTrailingEmptyLines(splitLines(text)), 1);
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: Theme,
): string {
  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");

  if (remaining > 0) {
    text += `${text ? "\n" : ""}${theme.fg("muted", `… ${remaining} more ${pluralize(remaining, "line")}`)}`;
  }

  return text;
}

function buildTailPreviewText(
  lines: string[],
  maxLines: number,
  theme: Theme,
): string {
  const { shown, remaining } = previewTailLines(lines, maxLines);
  let text = "";

  if (remaining > 0) {
    text = theme.fg("muted", `… ${remaining} earlier ${pluralize(remaining, "line")}`);
  }

  const preview = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");

  if (preview) {
    text += `${text ? "\n" : ""}${preview}`;
  }

  return text;
}

function countLineChars(lines: readonly string[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((total, line) => total + line.length, 0) + lines.length - 1;
}

function previewTailLinesWithinCharLimit(
  lines: string[],
  maxLines: number,
  maxChars: number,
): { shown: string[]; remainingLines: number; omittedChars: number } {
  const limit = Math.max(0, maxLines);
  const tail = limit === 0 ? [] : lines.slice(-limit);
  const remainingLines = Math.max(0, lines.length - tail.length);
  const charLimit = Math.max(0, maxChars);
  const tailChars = countLineChars(tail);

  if (tailChars <= charLimit) {
    return { shown: tail, remainingLines, omittedChars: 0 };
  }

  if (charLimit <= 1) {
    return { shown: charLimit === 1 ? ["…"] : [], remainingLines, omittedChars: tailChars };
  }

  const shown: string[] = [];
  let usedChars = 0;
  let omittedChars = 0;

  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = tail[index] ?? "";
    const separatorChars = shown.length > 0 ? 1 : 0;
    const available = charLimit - usedChars - separatorChars;

    if (available <= 1) {
      omittedChars += countLineChars(tail.slice(0, index + 1));
      break;
    }

    if (line.length <= available) {
      shown.unshift(line);
      usedChars += separatorChars + line.length;
      continue;
    }

    const suffixLength = Math.max(0, available - 1);
    shown.unshift(`…${line.slice(line.length - suffixLength)}`);
    usedChars += separatorChars + 1 + suffixLength;
    omittedChars += countLineChars(tail.slice(0, index)) + line.length - suffixLength;
    break;
  }

  return { shown, remainingLines, omittedChars };
}

function buildLimitedTailPreviewText(
  lines: string[],
  maxLines: number,
  maxChars: number,
  theme: Theme,
): string {
  let outputLineLimit = Math.max(0, maxLines);

  while (true) {
    const { shown, remainingLines, omittedChars } = previewTailLinesWithinCharLimit(lines, outputLineLimit, maxChars);
    const hintParts: string[] = [];
    if (remainingLines > 0) hintParts.push(`${remainingLines} earlier ${pluralize(remainingLines, "line")}`);
    if (omittedChars > 0) hintParts.push(`preview capped at ${maxChars} chars`);

    const nextOutputLineLimit = hintParts.length > 0 ? Math.max(0, maxLines - 1) : Math.max(0, maxLines);
    if (nextOutputLineLimit !== outputLineLimit) {
      outputLineLimit = nextOutputLineLimit;
      continue;
    }

    const rendered = shown
      .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
      .join("\n");

    if (hintParts.length === 0) return rendered;

    const hint = theme.fg("muted", `… ${hintParts.join(" • ")}`);
    return rendered ? `${hint}\n${rendered}` : hint;
  }
}

function getBlinkState(state: unknown): BlinkState | undefined {
  if (!isRecord(state)) return undefined;
  const carrier = state as BlinkCarrier;
  if (carrier.__piCcUiBlink) return carrier.__piCcUiBlink;
  carrier.__piCcUiBlink = { blinkPhase: true };
  return carrier.__piCcUiBlink;
}

function setupBlinkTimer(context: Pick<ToolRenderContextLike<unknown>, "state" | "invalidate">): void {
  const blink = getBlinkState(context.state);
  if (!blink || blink.blinkTimer) return;
  blink.blinkPhase = true;
  blink.blinkTimer = setInterval(() => {
    blink.blinkPhase = !blink.blinkPhase;
    context.invalidate();
  }, BLINK_INTERVAL_MS);
}

function clearBlinkTimer(state: unknown): void {
  const blink = getBlinkState(state);
  if (!blink?.blinkTimer) return;
  clearInterval(blink.blinkTimer);
  blink.blinkTimer = undefined;
  blink.blinkPhase = true;
}

function blinkDot(state: unknown, theme: Theme): string {
  const blink = getBlinkState(state);
  return blink?.blinkPhase ? theme.fg("success", "●") : theme.fg("muted", "○");
}

export function formatCallStatus(
  context: Pick<ToolRenderContextLike<unknown>, "executionStarted" | "isPartial" | "isError" | "state" | "invalidate">,
  theme: Theme,
): string {
  if (context.isError) {
    clearBlinkTimer(context.state);
    return `${theme.fg("error", "●")} `;
  }

  if (!context.isPartial) {
    clearBlinkTimer(context.state);
    return `${theme.fg("success", "●")} `;
  }

  setupBlinkTimer(context);
  return `${blinkDot(context.state, theme)} `;
}

function formatTruncationHint(details: unknown, theme: Theme): string {
  if (!isRecord(details)) return "";
  const truncation = isRecord(details.truncation) ? details.truncation as TruncationLike : undefined;
  if (!truncation?.truncated) return "";

  const totalLines = typeof truncation.totalLines === "number" ? truncation.totalLines : undefined;
  return theme.fg(
    "warning",
    totalLines ? ` · truncated from ${totalLines} lines` : " · truncated",
  );
}

function formatResultSummary(summary: string, preview: string, theme: Theme): string {
  return withBranch(preview ? `${summary}\n${preview}` : summary, theme);
}

function buildCollapsedHint(
  theme: Theme,
  lineCount: number,
  collapsedLimit: number,
): string {
  const remaining = Math.max(0, lineCount - collapsedLimit);
  if (remaining <= 0) {
    return "";
  }

  return theme.fg("muted", ` · ${remaining} more ${pluralize(remaining, "line")} • Ctrl+O to expand`);
}

function formatReadCall(args: ReadToolInput, theme: Theme, context: ToolRenderContextLike<ReadToolInput>): string {
  let summary = shortenPath(args.path);
  const parts: string[] = [];
  if (typeof args.offset === "number") parts.push(`offset=${args.offset}`);
  if (typeof args.limit === "number") parts.push(`limit=${args.limit}`);
  if (parts.length > 0) summary += ` ${theme.fg("muted", `(${parts.join(", ")})`)}`;
  return `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Read"))} ${theme.fg("accent", summary)}`;
}

function renderReadImageResult(
  result: AgentToolResult<ReadToolDetails | undefined>,
  theme: Theme,
  context: ToolRenderContextLike<ReadToolInput>,
): Text {
  clearBlinkTimer(context.state);

  const caps = getCapabilities();
  const images = getImageBlocks(result);
  const inlinePreviewAvailable = Boolean(caps.images && context.showImages);

  if (inlinePreviewAvailable) {
    // 保持 pi-mono 原本逻辑：图片本体由 ToolExecutionComponent 追加的 Image 组件渲染。
    return reuseText(context.lastComponent, withBranch(theme.fg("success", "Image loaded"), theme));
  }

  const reason = context.showImages
    ? "terminal image preview unsupported"
    : "terminal image preview disabled";
  const textNote = extractTextOutput(result).trim();
  const fallback = images
    .map((img) => {
      const mimeType = img.mimeType ?? "image/unknown";
      const dims = img.data && img.mimeType ? getImageDimensions(img.data, img.mimeType) ?? undefined : undefined;
      return theme.fg("toolOutput", imageFallback(mimeType, dims));
    })
    .join("\n");
  const preview = [textNote ? theme.fg("toolOutput", textNote) : "", fallback]
    .filter(Boolean)
    .join("\n");

  return reuseText(
    context.lastComponent,
    formatResultSummary(theme.fg("muted", `Image loaded · ${reason}`), preview, theme),
  );
}

function renderHighlightedReadPreview(
  summary: string,
  lines: string[],
  maxLines: number,
  theme: Theme,
  context: ToolRenderContextLike<ReadToolInput>,
): Text {
  const state = isRecord(context.state) ? (context.state as Record<string, unknown>) : null;
  const rawPath = context.args.path ?? "";
  const language = lang(rawPath);

  if (!state || !language) {
    const preview = buildPreviewText(lines, maxLines, theme);
    return reuseText(context.lastComponent, formatResultSummary(summary, preview, theme));
  }

  const { shown, remaining } = previewLines(lines, maxLines);
  const previewSource = shown.join("\n");
  const key = JSON.stringify({ path: rawPath, previewSource, remaining, maxLines });

  if (state.__readPreviewKey !== key) {
    state.__readPreviewKey = key;
    state.__readPreviewText = formatResultSummary(summary, theme.fg("muted", "rendering preview…"), theme);
    highlightCodeBlock(previewSource, language, theme)
      .then((renderedLines) => {
        const currentState = context.state as Record<string, unknown> | undefined;
        if (currentState?.__readPreviewKey !== key) return;
        let preview = renderedLines
          .map((line) => sanitizeAnsiForThemedOutput(line))
          .join("\n");
        if (remaining > 0) {
          preview += `${preview ? "\n" : ""}${theme.fg("muted", `… ${remaining} more ${pluralize(remaining, "line")}`)}`;
        }
        currentState.__readPreviewText = formatResultSummary(summary, preview, theme);
        context.invalidate();
      })
      .catch(() => {
        const currentState = context.state as Record<string, unknown> | undefined;
        if (currentState?.__readPreviewKey !== key) return;
        const preview = buildPreviewText(lines, maxLines, theme);
        currentState.__readPreviewText = formatResultSummary(summary, preview, theme);
        context.invalidate();
      });
  }

  return reuseText(
    context.lastComponent,
    String(state.__readPreviewText ?? formatResultSummary(summary, theme.fg("muted", "rendering preview…"), theme)),
  );
}

function renderReadResult(
  result: AgentToolResult<ReadToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextLike<ReadToolInput>,
): Text {
  if (hasImageOutput(result)) {
    return renderReadImageResult(result, theme, context);
  }

  if (isToolError(result, context)) {
    clearBlinkTimer(context.state);
    const lines = prepareOutputLines(extractTextOutput(result));
    const preview = options.expanded ? buildPreviewText(lines, getPreviewLimit(options, 8, 16), theme) : "";
    return reuseText(
      context.lastComponent,
      formatResultSummary(theme.fg("muted", "Read failed"), preview, theme),
    );
  }

  clearBlinkTimer(context.state);
  const lines = prepareOutputLines(extractTextOutput(result));
  const lineCount = lines.length;
  let summary = theme.fg("muted", `${lineCount} lines loaded`);
  summary += formatTruncationHint(result.details, theme);

  if (lineCount === 0) {
    return reuseText(context.lastComponent, withBranch(summary, theme));
  }

  if (!options.expanded) {
    return reuseText(context.lastComponent, withBranch(summary + buildCollapsedHint(theme, lineCount, READ_COLLAPSED_PREVIEW_LINES), theme));
  }

  return renderHighlightedReadPreview(
    summary,
    lines,
    getPreviewLimit(options, READ_COLLAPSED_PREVIEW_LINES, READ_EXPANDED_PREVIEW_LINES),
    theme,
    context,
  );
}

function flattenCommandForTitle(command: string): string {
  // 多行脚本 (python -c "...\n...\n" / node -e / heredoc) 中的换行会让卡片被
  // 撑成多行，叠加 blink 定时器 invalidate 就会疯狂重绘 → 视觉闪烁。
  // 把所有换行 / 连续空白折叠为单个空格，保证标题只占 1 行。
  return command.replace(/\s+/g, " ").trim();
}

function renderBashCall(
  args: BashToolInput,
  theme: Theme,
  context: ToolRenderContextLike<BashToolInput>,
): Text {
  // 参数流式阶段 (argsComplete=false): command 还在逐 token 增长，
  // 若每次都 truncateMiddle 整串渲染会让卡片在终端中频繁重绘 → 视觉闪烁。
  // 这里直接用占位符，等参数完整后再渲染真实命令。
  // 同时把渲染结果缓存到 state，避免 blink 定时器触发时再次对大字符串
  // 走 flatten/truncate 流程。
  if (!context.argsComplete) {
    const placeholder = truncateMiddle("…", 72, 48, 20);
    return reuseText(
      context.lastComponent,
      `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Bash"))} ${theme.fg("accent", placeholder)}`,
    );
  }

  const state = isRecord(context.state) ? (context.state as Record<string, unknown>) : null;
  const rawCommand = args.command ?? "";
  let commandDisplay: string;
  if (state && state.__bashCommandRaw === rawCommand && typeof state.__bashCommandDisplay === "string") {
    commandDisplay = state.__bashCommandDisplay as string;
  } else {
    const flattened = flattenCommandForTitle(rawCommand) || "...";
    commandDisplay = truncateMiddle(flattened, 72, 48, 20);
    if (state) {
      state.__bashCommandRaw = rawCommand;
      state.__bashCommandDisplay = commandDisplay;
    }
  }

  const timeout = typeof args.timeout === "number"
    ? theme.fg("muted", ` · timeout=${args.timeout}s`)
    : "";
  return reuseText(
    context.lastComponent,
    `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Bash"))} ${theme.fg("accent", commandDisplay)}${timeout}`,
  );
}

function formatBashNoOutput(args: BashToolInput, theme: Theme): string {
  const command = args.command.trim().toLowerCase();
  const quietPrefixes = ["cd", "mkdir", "rm", "mv", "cp", "touch", "chmod", "git add", "git checkout", "git switch"];
  const isQuiet = quietPrefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
  return theme.fg("muted", isQuiet ? "Command completed" : "(no output)");
}

function formatBashTruncation(details: BashToolDetails | undefined, theme: Theme): string {
  if (!details) return "";
  const hints: string[] = [];
  if (details.truncation?.truncated) hints.push("output truncated");
  if (details.fullOutputPath) hints.push(`full output: ${details.fullOutputPath}`);
  return hints.length > 0 ? `\n${theme.fg("warning", `(${hints.join(" • ")})`)}` : "";
}

function renderBashResult(
  result: AgentToolResult<BashToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextLike<BashToolInput>,
): Text {
  const maxLines = getPreviewLimit(options, BASH_COLLAPSED_PREVIEW_LINES, BASH_EXPANDED_PREVIEW_LINES);

  if (options.isPartial) {
    setupBlinkTimer(context);
    const rawOutput = extractTextOutput(result);
    const lines = prepareOutputLines(rawOutput);

    if (lines.length === 0) {
      return reuseText(
        context.lastComponent,
        `${blinkDot(context.state, theme)} ${theme.fg("warning", "Running…")}`,
      );
    }

    const summary = `${blinkDot(context.state, theme)} ${theme.fg("warning", "Running…")}${theme.fg("muted", ` · ${lines.length} ${pluralize(lines.length, "line")}`)}`;

    if (!options.expanded) {
      return reuseText(
        context.lastComponent,
        withBranch(summary + buildCollapsedHint(theme, lines.length, BASH_COLLAPSED_PREVIEW_LINES), theme),
      );
    }

    return reuseText(
      context.lastComponent,
      formatResultSummary(summary, buildLimitedTailPreviewText(lines, maxLines, BASH_PREVIEW_MAX_CHARS, theme), theme),
    );
  }

  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput);
  clearBlinkTimer(context.state);

  if (isToolError(result, context)) {
    let text = theme.fg("muted", "Command failed");
    if (lines.length > 0) {
      text += `\n${buildLimitedTailPreviewText(lines, maxLines, BASH_PREVIEW_MAX_CHARS, theme)}`;
    }
    text += formatBashTruncation(result.details, theme);
    return reuseText(context.lastComponent, withBranch(text, theme));
  }

  if (lines.length === 0) {
    return reuseText(
      context.lastComponent,
      withBranch(formatBashNoOutput(context.args, theme) + formatBashTruncation(result.details, theme), theme),
    );
  }

  let summary = theme.fg("muted", `${lines.length} ${pluralize(lines.length, "line")} returned`);
  summary += formatBashTruncation(result.details, theme);

  if (!options.expanded) {
    return reuseText(context.lastComponent, withBranch(summary + buildCollapsedHint(theme, lines.length, BASH_COLLAPSED_PREVIEW_LINES), theme));
  }

  const preview = buildLimitedTailPreviewText(lines, maxLines, BASH_PREVIEW_MAX_CHARS, theme);
  return reuseText(context.lastComponent, formatResultSummary(summary, preview, theme));
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : splitLines(text).length;
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[field];
  return typeof raw === "string" ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "path") ?? getStringField(value, "file_path");
}

function getWriteContentArg(value: unknown): string | undefined {
  return getStringField(value, "content");
}

function resolvePreviewPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return cwd;

  const expandedHome = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? `${homedir()}${trimmed.slice(1)}`
      : trimmed;

  return isAbsolute(expandedHome) ? expandedHome : resolve(cwd, expandedHome);
}

function readUtf8File(resolvedPath: string): FileReadResult {
  if (!existsSync(resolvedPath)) return { exists: false };

  try {
    return { exists: true, content: readFileSync(resolvedPath, "utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exists: true, error: `Unable to read '${resolvedPath}': ${message}` };
  }
}

function countSubstringMatches(haystack: string, needle: string): number {
  if (!needle) return 0;

  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) break;
    count++;
    cursor = index + 1;
  }
  return count;
}

function getPendingEditReplacements(input: unknown): EditReplacement[] {
  if (!isRecord(input)) return [];

  if (Array.isArray(input.edits)) {
    return input.edits.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const oldText = typeof entry.oldText === "string" ? entry.oldText : typeof entry.old_text === "string" ? entry.old_text : undefined;
      const newText = typeof entry.newText === "string" ? entry.newText : typeof entry.new_text === "string" ? entry.new_text : undefined;
      return typeof oldText === "string" && typeof newText === "string" ? [{ oldText, newText }] : [];
    });
  }

  const oldText = getStringField(input, "oldText") ?? getStringField(input, "old_text");
  const newText = getStringField(input, "newText") ?? getStringField(input, "new_text");
  return typeof oldText === "string" && typeof newText === "string" ? [{ oldText, newText }] : [];
}

function buildProjectedEditContent(originalContent: string, replacements: readonly EditReplacement[]): { ok: true; content: string } | { ok: false; reason: string } {
  if (replacements.length === 0) {
    return { ok: false, reason: "Preview unavailable because the edit request did not include exact replacement blocks." };
  }

  const ranges: Array<{ start: number; end: number; replacement: string }> = [];
  for (const [index, replacement] of replacements.entries()) {
    const matchCount = countSubstringMatches(originalContent, replacement.oldText);
    if (matchCount !== 1) {
      return {
        ok: false,
        reason: matchCount === 0
          ? `Preview unavailable because edit #${index + 1} did not match the current file contents.`
          : `Preview unavailable because edit #${index + 1} matched ${matchCount} regions instead of exactly one.`,
      };
    }

    const start = originalContent.indexOf(replacement.oldText);
    ranges.push({ start, end: start + replacement.oldText.length, replacement: replacement.newText });
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous && current && current.start < previous.end) {
      return { ok: false, reason: "Preview unavailable because the requested edits overlap in the original file." };
    }
  }

  let cursor = 0;
  let output = "";
  for (const range of ranges) {
    output += originalContent.slice(cursor, range.start);
    output += range.replacement;
    cursor = range.end;
  }
  output += originalContent.slice(cursor);
  return { ok: true, content: output };
}

function buildPendingWritePreviewData(input: unknown, cwd: string): PendingDiffPreviewData | undefined {
  const filePath = getToolPathArg(input);
  const nextContent = getWriteContentArg(input);
  if (!filePath || typeof nextContent !== "string") return undefined;

  const existing = readUtf8File(resolvePreviewPath(cwd, filePath));
  return {
    filePath,
    previousContent: existing.content,
    nextContent,
    fileExistedBeforeWrite: existing.exists,
    headerLabel: existing.exists ? "pending overwrite" : "pending create",
    notice: existing.error,
  };
}

function buildPendingEditPreviewData(input: unknown, cwd: string): PendingDiffPreviewData | undefined {
  const filePath = getToolPathArg(input);
  if (!filePath) return undefined;

  const existing = readUtf8File(resolvePreviewPath(cwd, filePath));
  if (existing.error) {
    return { filePath, fileExistedBeforeWrite: false, headerLabel: "pending edit", notice: existing.error };
  }
  if (!existing.exists || typeof existing.content !== "string") {
    return { filePath, fileExistedBeforeWrite: false, headerLabel: "pending edit", notice: "Preview unavailable because the target file does not exist yet." };
  }

  const projected = buildProjectedEditContent(existing.content, getPendingEditReplacements(input));
  if (!projected.ok) {
    return {
      filePath,
      previousContent: existing.content,
      fileExistedBeforeWrite: true,
      headerLabel: "pending edit",
      notice: projected.reason,
    };
  }

  return {
    filePath,
    previousContent: existing.content,
    nextContent: projected.content,
    fileExistedBeforeWrite: true,
    headerLabel: "pending edit",
  };
}

function getPendingDiffPreviewState(context: ToolRenderContextLike<unknown>, stateKey: string): PendingDiffPreviewState | undefined {
  if (!isRecord(context.state)) return undefined;
  const carrier = context.state as Record<string, unknown>;
  const current = carrier[stateKey];
  if (isRecord(current)) return current as PendingDiffPreviewState;

  const next: PendingDiffPreviewState = {};
  carrier[stateKey] = next;
  return next;
}

function resolvePendingDiffPreview(
  context: ToolRenderContextLike<unknown>,
  stateKey: string,
  previewKey: string | undefined,
  compute: () => PendingDiffPreviewData | undefined,
): PendingDiffPreviewData | undefined {
  const previewState = getPendingDiffPreviewState(context, stateKey);
  if (!previewState) return compute();

  if (previewState.key !== previewKey) {
    previewState.key = previewKey;
    previewState.data = previewKey ? compute() : undefined;
  }

  return previewState.data;
}

function renderPendingDiffCall(
  header: string,
  previewData: PendingDiffPreviewData | undefined,
  theme: Theme,
  context: ToolRenderContextLike<unknown>,
  renderStateKey: string,
): Text {
  if (!context.isPartial || !previewData) return reuseText(context.lastComponent, header);

  const state = isRecord(context.state) ? (context.state as Record<string, unknown>) : null;
  if (previewData.notice || typeof previewData.nextContent !== "string" || !state) {
    return reuseText(context.lastComponent, `${header}\n${theme.fg("warning", previewData.notice || "Preview unavailable.")}`);
  }

  const previousContent = previewData.previousContent ?? "";
  const key = JSON.stringify({ filePath: previewData.filePath, previousContent, nextContent: previewData.nextContent, label: previewData.headerLabel, expanded: context.expanded });
  const keyField = `${renderStateKey}Key`;
  const textField = `${renderStateKey}Text`;
  if (state[keyField] !== key) {
    state[keyField] = key;
    const diff = parseDiff(previousContent, previewData.nextContent);
    const hunks = diff.lines.filter((line) => line.type === "sep").length + (diff.lines.length ? 1 : 0);
    const modeLabel = previewData.fileExistedBeforeWrite ? "split" : "new file";
    const summary = `${theme.fg("warning", previewData.headerLabel)} ${diffSummaryWithMeta(diff.added, diff.removed, hunks, modeLabel)}`;
    state[textField] = `${header}\n${summary}\n${theme.fg("muted", "rendering diff…")}`;
    renderSplit(diff, lang(previewData.filePath), context.expanded ? 150 : diffCollapsedLimit(), resolveDiffColors(theme))
      .then((rendered) => {
        const currentState = context.state as Record<string, unknown> | undefined;
        if (currentState?.[keyField] !== key) return;
        currentState[textField] = `${header}\n${summary}\n${rendered}`;
        context.invalidate();
      })
      .catch(() => {});
  }

  return reuseText(context.lastComponent, String(state[textField] ?? header));
}

function countDiffChangesFromLines(lines: string[]): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    const first = line.charCodeAt(0);
    if (first === 43 /* + */) additions += 1;
    else if (first === 45 /* - */) removals += 1;
  }
  return { additions, removals };
}

function colorDiffLine(line: string, theme: Theme): string {
  if (line.startsWith("+++") || line.startsWith("@@")) return theme.fg("warning", line);
  if (line.startsWith("+")) return theme.fg("success", line);
  if (line.startsWith("---")) return theme.fg("warning", line);
  if (line.startsWith("-")) return theme.fg("error", line);
  return theme.fg("toolOutput", line);
}

function renderEditResult(
  result: AgentToolResult<EditToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextLike<EditToolInput>,
): Text {
  const errorText = extractFirstTextBlock(result);
  if (isToolError(result, context) || (typeof errorText === "string" && errorText.startsWith("Error"))) {
    const lines = prepareOutputLines(errorText ?? extractTextOutput(result));
    clearBlinkTimer(context.state);
    const preview = options.expanded ? buildPreviewText(lines, getPreviewLimit(options, 10, 20), theme) : "";
    return reuseText(context.lastComponent, formatResultSummary(theme.fg("muted", "Edit failed"), preview, theme));
  }

  clearBlinkTimer(context.state);
  const diff = result.details?.diff ?? "";
  if (!diff) {
    return reuseText(context.lastComponent, withBranch(theme.fg("success", "Applied"), theme));
  }

  const diffLines = splitLines(diff);
  const counts = countDiffChangesFromLines(diffLines);
  const summary = `${theme.fg("success", `+${counts.additions}`)}${theme.fg("muted", " / ")}${theme.fg("error", `-${counts.removals}`)}`;

  // call 阶段已渲染过红绿 split diff 预览，折叠时不再重复渲染 unified diff（与核心行为一致）。
  if (!options.expanded) {
    return reuseText(context.lastComponent, withBranch(summary + buildCollapsedHint(theme, diffLines.length, DIFF_COLLAPSED_PREVIEW_LINES), theme));
  }

  const { shown, remaining } = previewLines(
    diffLines,
    getPreviewLimit(options, DIFF_COLLAPSED_PREVIEW_LINES, DIFF_EXPANDED_PREVIEW_LINES),
  );

  const preview = shown.map((line) => colorDiffLine(line, theme)).join("\n");
  const tail =
    remaining > 0
      ? `${preview ? "\n" : ""}${theme.fg("muted", `… ${remaining} more ${pluralize(remaining, "line")}${options.expanded ? "" : " • Ctrl+O to expand"}`)}`
      : "";
  return reuseText(context.lastComponent, withBranch(`${summary}${preview ? `\n${preview}` : ""}${tail}`, theme));
}

function renderSearchPreviewLines(lines: string[], expanded: boolean, theme: Theme): string {
  return buildReferencePreviewText(lines.map((line) => theme.fg("dim", line)), expanded, theme, previewLimit());
}

function renderGrepResult(
  result: AgentToolResult<GrepToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextLike<GrepToolInput>,
): Text {
  clearBlinkTimer(context.state);
  if (options.isPartial) {
    setupBlinkTimer(context);
    return reuseText(context.lastComponent, theme.fg("dim", "Searching..."));
  }
  const matches = extractTextOutput(result).split("\n").filter((line) => line.trim().length > 0);
  if (matches.length === 0) return reuseText(context.lastComponent, withBranch(theme.fg("muted", "no matches"), theme));
  let text = theme.fg("muted", `${matches.length} matches`);
  if (result.details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
  if (!options.expanded) return reuseText(context.lastComponent, withBranch(`${text}${theme.fg("muted", " • Ctrl+O to expand")}`, theme));
  text += `\n${renderSearchPreviewLines(matches, options.expanded, theme)}`;
  return reuseText(context.lastComponent, withBranch(text, theme));
}

function renderFindResult(
  result: AgentToolResult<FindToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextLike<FindToolInput>,
): Text {
  clearBlinkTimer(context.state);
  if (options.isPartial) {
    setupBlinkTimer(context);
    return reuseText(context.lastComponent, theme.fg("dim", "Finding..."));
  }
  const items = extractTextOutput(result).split("\n").filter((line) => line.trim().length > 0);
  if (items.length === 0) return reuseText(context.lastComponent, withBranch(theme.fg("muted", "no files found"), theme));
  let text = theme.fg("muted", `${items.length} files`);
  if (!options.expanded) return reuseText(context.lastComponent, withBranch(`${text}${theme.fg("muted", " • Ctrl+O to expand")}`, theme));
  const shown = items.slice(0, previewLimit());
  const lines = shown.map((item) => `  ${fileIcon(item)}${theme.fg("dim", item.trim())}`);
  if (items.length > shown.length) lines.push(`  ${theme.fg("muted", `… ${items.length - shown.length} more files`)}`);
  text += `\n${lines.join("\n")}`;
  return reuseText(context.lastComponent, withBranch(text, theme));
}

function renderLsResult(
  result: AgentToolResult<LsToolDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextLike<LsToolInput>,
): Text {
  clearBlinkTimer(context.state);
  if (options.isPartial) {
    setupBlinkTimer(context);
    return reuseText(context.lastComponent, theme.fg("dim", "Listing..."));
  }
  const items = extractTextOutput(result).split("\n").filter((line) => line.trim().length > 0);
  if (items.length === 0) return reuseText(context.lastComponent, withBranch(theme.fg("muted", "empty directory"), theme));
  let text = theme.fg("muted", `${items.length} entries`);
  if (!options.expanded) return reuseText(context.lastComponent, withBranch(`${text}${theme.fg("muted", " • Ctrl+O to expand")}`, theme));
  const shown = items.slice(0, previewLimit());
  const treeLines: string[] = [];
  for (let index = 0; index < shown.length; index += 1) {
    const item = shown[index] ?? "";
    const isDir = item.endsWith("/");
    const isLast = index === shown.length - 1 && items.length <= shown.length;
    const prefix = `${theme.fg("muted", isLast ? "└──" : "├──")} `;
    const icon = isDir ? dirIcon() : fileIcon(item);
    const name = isDir ? theme.fg("accent", theme.bold(item)) : theme.fg("dim", item);
    treeLines.push(`${prefix}${icon}${name}`);
  }
  if (items.length > shown.length) {
    treeLines.push(`${theme.fg("muted", "└──")} ${theme.fg("muted", `… ${items.length - shown.length} more entries`)}`);
  }
  text += `\n${treeLines.join("\n")}`;
  return reuseText(context.lastComponent, withBranch(text, theme));
}

function getWritePreviewState(context: ToolRenderContextLike<WriteToolInput>): WritePreviewCarrier["__piCcUiWritePreview"] {
  const content = getWriteContentArg(context.args);
  if (typeof content !== "string") return undefined;

  const key = content;
  if (!isRecord(context.state)) {
    return {
      key,
      lineCount: countLines(content),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
  }

  const carrier = context.state as WritePreviewCarrier;
  if (!carrier.__piCcUiWritePreview || carrier.__piCcUiWritePreview.key !== key) {
    carrier.__piCcUiWritePreview = {
      key,
      lineCount: countLines(content),
      sizeBytes: Buffer.byteLength(content, "utf8"),
    };
  }
  return carrier.__piCcUiWritePreview;
}

function renderEditCall(args: EditToolInput, theme: Theme, context: ToolRenderContextLike<EditToolInput>): Text {
  const operations = getEditOperations(args as any);
  const rawPath = getToolPathArg(args) ?? args.path;
  const summary = operations.length > 1 ? `${shortenPath(rawPath)} ${theme.fg("muted", `(${operations.length} edits)`)}` : shortenPath(rawPath);
  const header = `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Edit"))} ${theme.fg("accent", summary)}`;

  if (context.isPartial && context.argsComplete) {
    const previewKey = JSON.stringify({ path: rawPath ?? null, edits: isRecord(args) ? (args as Record<string, unknown>).edits ?? null : null, oldText: getStringField(args, "oldText") ?? getStringField(args, "old_text") ?? null, newText: getStringField(args, "newText") ?? getStringField(args, "new_text") ?? null });
    const previewData = resolvePendingDiffPreview(
      context,
      "__piCcUiEditPendingPreview",
      previewKey,
      () => buildPendingEditPreviewData(args, context.cwd),
    );
    return renderPendingDiffCall(header, previewData, theme, context, "__piCcUiEditPendingRender");
  }

  if (!(context.argsComplete && operations.length > 0 && isRecord(context.state))) {
    return reuseText(context.lastComponent, header);
  }
  const state = context.state as Record<string, unknown>;
  const key = JSON.stringify({ path: args.path, operations, expanded: context.expanded });
  if (state.__editPreviewKey !== key) {
    state.__editPreviewKey = key;
    state.__editPreviewText = `${header}\n${theme.fg("muted", "(rendering…)")}`;
    const language = lang(args.path);
    const diffColors = resolveDiffColors(theme);
    if (operations.length === 1) {
      const diff = parseDiff(operations[0]!.oldText, operations[0]!.newText);
      renderSplit(diff, language, context.expanded ? 150 : 32, diffColors)
        .then((rendered) => {
          if ((context.state as Record<string, unknown> | undefined)?.__editPreviewKey !== key) return;
          (context.state as Record<string, unknown>).__editPreviewText = `${header}\n${diffSummaryWithMeta(diff.added, diff.removed, diff.lines.filter((line) => line.type === "sep").length + (diff.lines.length ? 1 : 0), "split")}\n${rendered}`;
          context.invalidate();
        })
        .catch(() => {});
    } else {
      const { diffs, summary: editSummary } = summarizeEditOperations(operations);
      const maxShown = context.expanded ? operations.length : Math.min(operations.length, 3);
      const linesPerBlock = context.expanded ? 60 : 20;
      Promise.all(
        diffs.slice(0, maxShown).map((diff, index) => renderSplit(diff, language, linesPerBlock, diffColors).then((rendered) => `Edit ${index + 1}/${operations.length}\n${rendered}`)),
      ).then((sections) => {
        if ((context.state as Record<string, unknown> | undefined)?.__editPreviewKey !== key) return;
        const suffix = operations.length > maxShown ? `\n${theme.fg("muted", `… ${operations.length - maxShown} more edit blocks${context.expanded ? "" : " • Ctrl+O to expand"}`)}` : "";
        (context.state as Record<string, unknown>).__editPreviewText = `${header}\n${operations.length} edits ${editSummary}\n\n${sections.join("\n\n")}${suffix}`;
        context.invalidate();
      }).catch(() => {});
    }
  }
  return reuseText(context.lastComponent, String(state.__editPreviewText ?? header));
}

function getCachedOldContent(state: Record<string, unknown>, cwd: string, fp: string | undefined): string | null {
  // 流式参数更新阶段会多次进入渲染，对同一文件不重复读盘。
  if (!fp) return null;
  const resolvedPath = resolvePreviewPath(cwd, fp);
  const cacheKey = "__writeOldContentKey";
  const contentKey = "__writeOldContent";
  if (state[cacheKey] === resolvedPath && contentKey in state) {
    return state[contentKey] as string | null;
  }
  const existing = readUtf8File(resolvedPath);
  const content = existing.exists && typeof existing.content === "string" ? existing.content : null;
  state[cacheKey] = resolvedPath;
  state[contentKey] = content;
  return content;
}

function renderWriteCall(args: WriteToolInput, theme: Theme, context: ToolRenderContextLike<WriteToolInput>): Text {
  const preview = getWritePreviewState(context);
  const content = getWriteContentArg(args);
  const rawPath = getToolPathArg(args) ?? args.path;
  const state = isRecord(context.state) ? (context.state as Record<string, unknown>) : null;
  const oldContent = state ? getCachedOldContent(state, context.cwd, rawPath) : null;
  const isNew = !rawPath || oldContent === null;
  const label = isNew ? "Create" : "Write";
  const header = `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", shortenPath(rawPath))}${preview ? ` ${theme.fg("muted", `(${preview.lineCount} lines)`)}` : ""}`;

  if (context.isPartial && context.argsComplete) {
    const previewKey = JSON.stringify({ path: rawPath ?? null, content: content ?? null });
    const previewData = resolvePendingDiffPreview(
      context,
      "__piCcUiWritePendingPreview",
      previewKey,
      () => buildPendingWritePreviewData(args, context.cwd),
    );
    return renderPendingDiffCall(header, previewData, theme, context, "__piCcUiWritePendingRender");
  }

  if (!context.argsComplete || !state || typeof content !== "string") return reuseText(context.lastComponent, header);
  const key = JSON.stringify({ path: rawPath ?? null, content, expanded: context.expanded });
  if (state.__writePreviewKey !== key) {
    state.__writePreviewKey = key;
    state.__writePreviewText = header;
    const language = lang(rawPath ?? "");
    const diffColors = resolveDiffColors(theme);
    if (oldContent !== null && oldContent !== content) {
      const diff = parseDiff(oldContent, content);
      const hunks = diff.lines.filter((line) => line.type === "sep").length + (diff.lines.length ? 1 : 0);
      const richSummary = diffSummaryWithMeta(diff.added, diff.removed, hunks, "split");
      state.__writePreviewText = `${header}\n${richSummary}\n${theme.fg("muted", "rendering diff…")}`;
      renderSplit(diff, language, context.expanded ? 150 : diffCollapsedLimit(), diffColors)
        .then((rendered) => {
          if ((context.state as Record<string, unknown> | undefined)?.__writePreviewKey !== key) return;
          (context.state as Record<string, unknown>).__writePreviewText = `${header}\n${richSummary}\n${rendered}`;
          context.invalidate();
        })
        .catch(() => {});
    } else if (oldContent === null) {
      const syntheticDiff = parseDiff("", content);
      const richSummary = diffSummaryWithMeta(syntheticDiff.added, 0, 1, "new file");
      state.__writePreviewText = `${header}\n${theme.fg("success", "✓ new file")} ${richSummary}\n${theme.fg("muted", "rendering diff…")}`;
      renderSplit(syntheticDiff, language, context.expanded ? 150 : diffCollapsedLimit(), diffColors)
        .then((rendered) => {
          if ((context.state as Record<string, unknown> | undefined)?.__writePreviewKey !== key) return;
          (context.state as Record<string, unknown>).__writePreviewText = `${header}\n${theme.fg("success", "✓ new file")} ${richSummary}\n${rendered}`;
          context.invalidate();
        })
        .catch(() => {});
    }
  }
  return reuseText(context.lastComponent, String(state.__writePreviewText ?? header));
}

export function getCompactToolCallRenderer(toolName: string) {
  switch (toolName) {
    case "read":
      return (args: ReadToolInput, theme: Theme, context: ToolRenderContextLike<ReadToolInput>) =>
        reuseText(context.lastComponent, formatReadCall(args, theme, context));
    case "bash":
      return (args: BashToolInput, theme: Theme, context: ToolRenderContextLike<BashToolInput>) =>
        renderBashCall(args, theme, context);
    case "grep":
      return (args: GrepToolInput, theme: Theme, context: ToolRenderContextLike<GrepToolInput>) => {
        let summary = `"${summarizeText(args.pattern, 40)}"`;
        if (args.path) summary += ` in ${args.path}`;
        return reuseText(context.lastComponent, `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Grep"))} ${theme.fg("accent", summary)}`);
      };
    case "find":
      return (args: FindToolInput, theme: Theme, context: ToolRenderContextLike<FindToolInput>) => {
        let summary = `"${summarizeText(args.pattern, 40)}"`;
        if (args.path) summary += ` in ${args.path}`;
        return reuseText(context.lastComponent, `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Find"))} ${theme.fg("accent", summary)}`);
      };
    case "ffgrep":
      return (args: GrepToolInput, theme: Theme, context: ToolRenderContextLike<GrepToolInput>) => {
        let summary = `"${summarizeText(args.pattern, 40)}"`;
        if (args.path) summary += ` in ${args.path}`;
        return reuseText(context.lastComponent, `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Ffgrep"))} ${theme.fg("accent", summary)}`);
      };
    case "fffind":
      return (args: FindToolInput, theme: Theme, context: ToolRenderContextLike<FindToolInput>) => {
        let summary = `"${summarizeText(args.pattern, 40)}"`;
        if (args.path) summary += ` in ${args.path}`;
        return reuseText(context.lastComponent, `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("Fffind"))} ${theme.fg("accent", summary)}`);
      };
    case "ls":
      return (args: LsToolInput, theme: Theme, context: ToolRenderContextLike<LsToolInput>) =>
        reuseText(context.lastComponent, `${formatCallStatus(context, theme)}${theme.fg("toolTitle", theme.bold("List"))} ${theme.fg("accent", shortenPath(args.path ?? "."))}`);
    case "edit":
      return (args: EditToolInput, theme: Theme, context: ToolRenderContextLike<EditToolInput>) => renderEditCall(args, theme, context);
    case "write":
      return (args: WriteToolInput, theme: Theme, context: ToolRenderContextLike<WriteToolInput>) => renderWriteCall(args, theme, context);
    default:
      return undefined;
  }
}

export function getCompactToolResultRenderer(toolName: string) {
  switch (toolName) {
    case "read":
      return (
        result: AgentToolResult<ReadToolDetails | undefined>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<ReadToolInput>,
      ) => renderReadResult(result, options, theme, context);
    case "bash":
      return (
        result: AgentToolResult<BashToolDetails | undefined>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<BashToolInput>,
      ) => renderBashResult(result, options, theme, context);
    case "grep":
      return (
        result: AgentToolResult<GrepToolDetails | undefined>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<GrepToolInput>,
      ) => renderGrepResult(result, options, theme, context);
    case "find":
      return (
        result: AgentToolResult<FindToolDetails | undefined>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<FindToolInput>,
      ) => renderFindResult(result, options, theme, context);
    case "ffgrep":
      return (
        result: AgentToolResult<unknown>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<GrepToolInput>,
      ) => renderGrepResult(result as AgentToolResult<GrepToolDetails | undefined>, options, theme, context);
    case "fffind":
      return (
        result: AgentToolResult<unknown>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<FindToolInput>,
      ) => renderFindResult(result as AgentToolResult<FindToolDetails | undefined>, options, theme, context);
    case "ls":
      return (
        result: AgentToolResult<LsToolDetails | undefined>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<LsToolInput>,
      ) => renderLsResult(result, options, theme, context);
    case "edit":
      return (
        result: AgentToolResult<EditToolDetails | undefined>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<EditToolInput>,
      ) => renderEditResult(result, options, theme, context);
    case "write":
      return (
        result: AgentToolResult<unknown>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContextLike<WriteToolInput>,
      ) => {
        const errorText = extractFirstTextBlock(result);
        if (isToolError(result, context) || (typeof errorText === "string" && errorText.startsWith("Error"))) {
          clearBlinkTimer(context.state);
          const lines = prepareOutputLines(errorText ?? extractTextOutput(result));
          return reuseText(
            context.lastComponent,
            formatResultSummary(theme.fg("muted", "Write failed"), options.expanded ? buildPreviewText(lines, 8, theme) : "", theme),
          );
        }

        clearBlinkTimer(context.state);
        const preview = getWritePreviewState(context);
        const lineCount = preview?.lineCount ?? countLines(context.args.content);
        const sizeBytes = preview?.sizeBytes ?? Buffer.byteLength(context.args.content, "utf8");
        return reuseText(
          context.lastComponent,
          withBranch(`${theme.fg("success", "Written")}${theme.fg("muted", ` · ${lineCount} ${pluralize(lineCount, "line")} · ${formatSize(sizeBytes)}`)}`, theme),
        );
      };
    default:
      return undefined;
  }
}
