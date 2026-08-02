import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { codeToANSI } from "@shikijs/cli";
import * as Diff from "diff";
import type { BundledLanguage, BundledTheme } from "shiki";
import { formatCallStatus } from "./tool-display";

const RESET = "\x1b[0m";
const BORDER_COLOR = "\x1b[38;5;238m";
const TRANSPARENT_BG = "\x1b[49m";
const TRANSPARENT_RESET = `${RESET}${TRANSPARENT_BG}`;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const PATCH_FLAG = Symbol.for("pi-cc-ui:patched-container-render");
const ORIGINAL_RENDER = Symbol.for("pi-cc-ui:original-container-render");
const CONTAINER_RENDER_PATCH_VERSION = "decorate-text-before-image-v5";

export type ToolBackgroundMode = "default" | "transparent" | "outlines";

interface SettingsFile {
  toolBackground?: ToolBackgroundMode | "border";
  readOutputMode?: "hidden" | "summary" | "preview";
  searchOutputMode?: "hidden" | "count" | "preview";
  mcpOutputMode?: "hidden" | "summary" | "preview";
  previewLines?: number;
  expandedPreviewMaxLines?: number;
  bashOutputMode?: "opencode" | "summary" | "preview";
  bashCollapsedLines?: number;
  diffCollapsedLines?: number;
  showTruncationHints?: boolean;
  diffTheme?: string;
  diffColors?: Record<string, string>;
}

const DEFAULT_SETTINGS: Required<SettingsFile> = {
  toolBackground: "transparent",
  readOutputMode: "preview",
  searchOutputMode: "preview",
  mcpOutputMode: "preview",
  previewLines: 8,
  expandedPreviewMaxLines: 4000,
  bashOutputMode: "opencode",
  bashCollapsedLines: 10,
  diffCollapsedLines: 24,
  showTruncationHints: true,
  diffTheme: "github-dark",
  diffColors: {},
};

let toolBackgroundMode: ToolBackgroundMode = "transparent";
let toolBackgroundOverride: ToolBackgroundMode | null = null;

// settings.json 的内容在会话期间变化不频繁，但渲染路径会高频读取
// （每帧 diff / bash / mcp 都会拿 previewLimit 等）。这里做一个
// TTL 缓存，避免每次渲染都触发 existsSync + readFileSync + JSON.parse。
const SETTINGS_TTL_MS = 1000;
let cachedSettings: Required<SettingsFile> | null = null;
let cachedSettingsAt = 0;

function loadSettings(): Required<SettingsFile> {
  const paths = [
    `${process.cwd()}/.pi/settings.json`,
    `${process.env.HOME ?? ""}/.pi/settings.json`,
  ];
  for (const path of paths) {
    try {
      if (!path || !existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8"));
      if (raw && typeof raw === "object") {
        return { ...DEFAULT_SETTINGS, ...(raw as SettingsFile) };
      }
    } catch {
      // noop
    }
  }
  return { ...DEFAULT_SETTINGS };
}

export function readSettings(): Required<SettingsFile> {
  const now = Date.now();
  if (cachedSettings && now - cachedSettingsAt < SETTINGS_TTL_MS) {
    return cachedSettings;
  }
  cachedSettings = loadSettings();
  cachedSettingsAt = now;
  return cachedSettings;
}

function syncToolBackgroundMode(): void {
  if (toolBackgroundOverride) {
    toolBackgroundMode = toolBackgroundOverride;
    return;
  }
  const settings = readSettings();
  const raw = settings.toolBackground === "border" ? "outlines" : settings.toolBackground;
  toolBackgroundMode = raw ?? "transparent";
}

export function getToolBackgroundMode(): ToolBackgroundMode {
  syncToolBackgroundMode();
  return toolBackgroundMode;
}

export function setToolBackgroundMode(mode: ToolBackgroundMode): void {
  toolBackgroundOverride = mode;
  toolBackgroundMode = mode;
}

function isImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function applyBackgroundValue(targetTheme: unknown, mode: ToolBackgroundMode): void {
  if (!targetTheme) return;
  const value = mode === "transparent" ? TRANSPARENT_BG : undefined;
  const themeAny = targetTheme as any;
  if (themeAny.bgColors instanceof Map) {
    if (value === undefined) return;
    themeAny.bgColors.set("toolPendingBg", value);
    themeAny.bgColors.set("toolSuccessBg", value);
    themeAny.bgColors.set("toolErrorBg", value);
  } else if (themeAny.bgColors && typeof themeAny.bgColors === "object") {
    if (value === undefined) return;
    themeAny.bgColors.toolPendingBg = value;
    themeAny.bgColors.toolSuccessBg = value;
    themeAny.bgColors.toolErrorBg = value;
  }
}

export function applyToolBackgroundMode(theme: unknown): void {
  syncToolBackgroundMode();
  applyBackgroundValue(theme, toolBackgroundMode);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function isBlankLine(text: string): boolean {
  return stripAnsi(text).trim().length === 0;
}

function borderLine(width: number): string {
  return `${BORDER_COLOR}${"─".repeat(Math.max(1, width))}${TRANSPARENT_RESET}`;
}

function isBorderLine(line: string, width: number): boolean {
  return line.includes(BORDER_COLOR) && stripAnsi(line).trim() === "─".repeat(Math.max(1, width));
}

function alreadyHasToolBorder(rendered: readonly string[], width: number): boolean {
  let start = 0;
  while (start < rendered.length && isBlankLine(rendered[start] ?? "")) start++;
  return start < rendered.length && isBorderLine(rendered[start] ?? "", width);
}

function clampLineWidth(line: string, width: number): string {
  if (width <= 0) return "";
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

function imageRowsForLine(line: string): number {
  if (!isImageLine(line)) return 0;
  const moveUpRows = line.match(/\x1b\[(\d+)A/)?.[1];
  if (moveUpRows) return Number.parseInt(moveUpRows, 10) + 1;
  const kittyRows = line.match(/\x1b_G[^;]*\br=(\d+)/)?.[1];
  if (kittyRows) return Number.parseInt(kittyRows, 10);
  return 1;
}

function decorateToolWithImageLines(rendered: string[], width: number): string[] {
  const imageIndex = rendered.findIndex((line) => isImageLine(line));
  if (imageIndex < 0) return rendered;

  const imageRows = Math.max(1, imageRowsForLine(rendered[imageIndex] ?? ""));
  let imageStart = Math.max(0, imageIndex - imageRows + 1);
  // ToolExecutionComponent 会在 Image 组件前插入一个 Spacer；保留这个空行作为文本和图片的间距。
  if (imageStart > 0 && isBlankLine(rendered[imageStart - 1] ?? "")) {
    imageStart--;
  }

  let start = 0;
  while (start < imageStart && isBlankLine(rendered[start] ?? "")) start++;
  let end = imageStart - 1;
  while (end >= start && isBlankLine(rendered[end] ?? "")) end--;

  if (start > end) return rendered;

  const core = rendered
    .slice(start, end + 1)
    .map((line) => clampLineWidth(line, width));
  const rule = borderLine(Math.max(1, width));
  return [rule, ...core, rule, ...rendered.slice(imageStart)];
}

function isToolExecutionLike(
  value: unknown,
): value is { toolName: string; toolCallId: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.toolName === "string" &&
    typeof candidate.toolCallId === "string"
  );
}

export function decorateToolRender(rendered: string[], width: number): string[] {
  if (!Array.isArray(rendered) || rendered.length === 0) return rendered;
  const mode = getToolBackgroundMode();
  if (mode === "default") return rendered;
  // 开发/热加载时可能已经被旧版本 patch 过；避免再次套一层边框。
  if (alreadyHasToolBorder(rendered, width)) return rendered;
  // 图片行包含大段 Kitty/iTerm2 escape sequence，不能被 truncateToWidth
  // 或追加背景/边框字符。遇到图片时只装饰图片前面的文本区域。
  if (rendered.some((line) => isImageLine(line))) {
    return decorateToolWithImageLines(rendered, width);
  }

  let start = 0;
  while (start < rendered.length && isBlankLine(rendered[start] ?? ""))
    start++;
  let end = rendered.length - 1;
  while (end >= start && isBlankLine(rendered[end] ?? "")) end--;
  if (start > end) return rendered;

  const core = rendered
    .slice(start, end + 1)
    .map((line) => clampLineWidth(line, width));
  const rule = borderLine(Math.max(1, width));
  return [rule, ...core, rule];
}

export function patchGlobalToolBorders(): void {
  const proto = Container.prototype as any;
  if (proto[PATCH_FLAG] === CONTAINER_RENDER_PATCH_VERSION) return;

  if (!proto[ORIGINAL_RENDER]) {
    proto[ORIGINAL_RENDER] = proto.render;
  }
  const originalRender = proto[ORIGINAL_RENDER];
  proto.render = function patchedContainerRender(width: number): string[] {
    const rendered = originalRender.call(this, width);
    if (!Array.isArray(rendered) || rendered.length === 0) return rendered;

    if (!isToolExecutionLike(this)) return rendered;
    return decorateToolRender(rendered, width);
  };

  proto[PATCH_FLAG] = CONTAINER_RENDER_PATCH_VERSION;
}

export function previewLimit(): number {
  const value = readSettings().previewLines;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 8;
}

export function expandedPreviewLimit(): number {
  const value = readSettings().expandedPreviewMaxLines;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 4000;
}

export function bashCollapsedLimit(): number {
  const value = readSettings().bashCollapsedLines;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 10;
}

export function diffCollapsedLimit(): number {
  const value = readSettings().diffCollapsedLines;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 24;
}

export function buildPreviewText(
  lines: string[],
  expanded: boolean,
  theme: Theme,
  fallbackCollapsed = 8,
): string {
  if (lines.length === 0) return theme.fg("muted", "(no output)");
  const maxLines = expanded ? expandedPreviewLimit() : fallbackCollapsed;
  const shown = lines.slice(0, maxLines);
  let text = shown.join("\n");
  const remaining = lines.length - shown.length;
  if (remaining > 0) {
    text += `\n${theme.fg("muted", `... (${remaining} more lines${expanded ? "" : " • Ctrl+O to expand"})`)}`;
  }
  if (expanded && lines.length > maxLines) {
    text += `\n${theme.fg("warning", `(display capped at ${maxLines} lines)`)}`;
  }
  return text;
}

export function branchIndent(text: string): string {
  return `   ${text}`;
}

export function branchLead(text: string, theme: Pick<Theme, "fg">): string {
  return `${theme.fg("muted", "└─")} ${text}`;
}

export function withBranch(content: string, theme: Pick<Theme, "fg">): string {
  if (!content || !content.trim()) return "";
  const lines = content.split("\n");
  const first = lines[0] ?? "";
  if (lines.length === 1) return branchLead(first, theme);
  return `${branchLead(first, theme)}\n${lines
    .slice(1)
    .map((line) => branchIndent(line))
    .join("\n")}`;
}

const NF_DIR = `\x1b[38;2;100;140;220m\ue5ff\x1b[0m`;
const NF_DEFAULT = `\x1b[38;2;80;80;80m\uf15b\x1b[0m`;
const EXT_ICON: Record<string, string> = {
  ts: `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
  tsx: `\x1b[38;2;49;120;198m\ue7ba\x1b[0m`,
  js: `\x1b[38;2;241;224;90m\ue74e\x1b[0m`,
  jsx: `\x1b[38;2;97;218;251m\ue7ba\x1b[0m`,
  py: `\x1b[38;2;55;118;171m\ue73c\x1b[0m`,
  md: `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
  json: `\x1b[38;2;241;224;90m\ue60b\x1b[0m`,
  yml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
  yaml: `\x1b[38;2;160;116;196m\ue6a8\x1b[0m`,
  sh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
  bash: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
  zsh: `\x1b[38;2;137;180;130m\ue795\x1b[0m`,
  html: `\x1b[38;2;228;77;38m\ue736\x1b[0m`,
  css: `\x1b[38;2;66;165;245m\ue749\x1b[0m`,
  vue: `\x1b[38;2;65;184;131m\ue6a0\x1b[0m`,
  svelte: `\x1b[38;2;255;62;0m\ue697\x1b[0m`,
  png: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
  jpg: `\x1b[38;2;160;116;196m\uf1c5\x1b[0m`,
  svg: `\x1b[38;2;255;180;50m\uf1c5\x1b[0m`,
};
const NAME_ICON: Record<string, string> = {
  "package.json": `\x1b[38;2;137;180;130m\ue71e\x1b[0m`,
  "tsconfig.json": `\x1b[38;2;49;120;198m\ue628\x1b[0m`,
  ".gitignore": `\x1b[38;2;222;165;132m\ue702\x1b[0m`,
  dockerfile: `\x1b[38;2;56;152;236m\ue7b0\x1b[0m`,
  makefile: `\x1b[38;2;130;130;130m\ue615\x1b[0m`,
  "readme.md": `\x1b[38;2;66;165;245m\ue73e\x1b[0m`,
};

export function fileIcon(fp: string): string {
  const base = fp.split("/").pop()?.toLowerCase() ?? "";
  if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
  const ext = base.includes(".") ? (base.split(".").pop() ?? "") : "";
  return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

export function dirIcon(): string {
  return `${NF_DIR} `;
}

export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function summarizeText(text: string, max = 60): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}

const EXT_LANG: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  html: "html",
  css: "css",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  lua: "lua",
  php: "php",
  xml: "xml",
  graphql: "graphql",
  svelte: "svelte",
  vue: "vue",
};

export function lang(filePath: string): BundledLanguage | undefined {
  return EXT_LANG[extname(filePath).slice(1).toLowerCase()];
}

let DIFF_THEME: BundledTheme = "github-dark";
const MAX_TERM_WIDTH = 210;
const DEFAULT_TERM_WIDTH = 200;
const MAX_PREVIEW_LINES = 60;
const MAX_RENDER_LINES = 150;
const MAX_HL_CHARS = 80_000;
const CACHE_LIMIT = 192;
const WORD_DIFF_MIN_SIM = 0.15;

let D_RST = "\x1b[0m";
const D_BOLD = "\x1b[1m";
const D_DIM = "\x1b[2m";
let BG_ADD = "\x1b[48;2;36;60;42m";
let BG_DEL = "\x1b[48;2;60;36;36m";
let BG_ADD_W = "\x1b[48;2;48;92;58m";
let BG_DEL_W = "\x1b[48;2;92;48;48m";
let BG_GUTTER_ADD = "\x1b[48;2;28;44;31m";
let BG_GUTTER_DEL = "\x1b[48;2;44;28;28m";
let BG_EMPTY = TRANSPARENT_BG;
let BG_BASE = TRANSPARENT_BG;
let FG_ADD = "\x1b[38;2;110;210;130m";
let FG_DEL = "\x1b[38;2;225;110;110m";
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
let FG_STRIPE = "\x1b[38;2;40;40;40m";
let DIVIDER = `${FG_RULE}│${D_RST}`;

export interface DiffColors {
  fgAdd: string;
  fgDel: string;
  fgCtx: string;
}
let DEFAULT_DIFF_COLORS: DiffColors = {
  fgAdd: FG_ADD,
  fgDel: FG_DEL,
  fgCtx: FG_DIM,
};

export function resolveDiffColors(_theme?: unknown): DiffColors {
  return DEFAULT_DIFF_COLORS;
}

function diffStrip(value: string): string {
  return value.replace(ANSI_RE, "");
}
function tabs(text: string): string {
  return text.replace(/\t/g, "  ");
}
function termW(): number {
  const raw =
    process.stdout.columns ||
    (process.stderr as any).columns ||
    Number.parseInt(process.env.COLUMNS ?? "", 10) ||
    DEFAULT_TERM_WIDTH;
  return Math.max(80, Math.min(raw - 4, MAX_TERM_WIDTH));
}
function fit(value: string, width: number): string {
  if (width <= 0) return "";
  const plain = diffStrip(value);
  if (plain.length <= width) return value + " ".repeat(width - plain.length);
  return `${truncateToWidth(value, width > 2 ? width - 1 : width)}${width > 2 ? `${D_RST}${FG_DIM}›${D_RST}` : D_RST}`;
}
function ansiState(text: string): string {
  const matches = text.match(/\x1b\[[0-9;]*m/g) ?? [];
  let fg = "";
  let bg = "";
  for (const seq of matches) {
    const params = seq.slice(2, -1);
    if (params === "0") {
      fg = "";
      bg = "";
    } else if (params === "39") fg = "";
    else if (params.startsWith("38;")) fg = seq;
    else if (params.startsWith("48;")) bg = seq;
  }
  return bg + fg;
}
function sgrParams(seq: string): number[] {
  const raw = seq.slice(2, -1);
  if (!raw.trim()) return [0];
  return raw
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}
function sgrResetsBackground(seq: string): boolean {
  const params = sgrParams(seq);
  return params.length === 0 || params.includes(0) || params.includes(49);
}
function keepBackgroundAcrossResets(text: string, background: string): string {
  if (!background || !text.includes("\x1b[")) return text;
  return text.replace(/\x1b\[[0-9;]*m/g, (seq) => sgrResetsBackground(seq) ? `${seq}${background}` : seq);
}
function normalizeShikiContrast(ansi: string): string {
  return ansi.replace(/\x1b\[([0-9;]*)m/g, (seq, params: string) => {
    if (
      params === "30" ||
      params === "90" ||
      params === "38;5;0" ||
      params === "38;5;8"
    )
      return FG_SAFE_MUTED;
    if (!params.startsWith("38;2;")) return seq;
    const parts = params.split(";").map(Number);
    if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n)))
      return seq;
    const [, , r, g, b] = parts;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 72 ? FG_SAFE_MUTED : seq;
  });
}
function wrapAnsi(text: string, width: number, fillBg = ""): string[] {
  if (width <= 0) return [""];
  const stableText = fillBg ? keepBackgroundAcrossResets(text, fillBg) : text;
  const plain = diffStrip(stableText);
  if (plain.length <= width) {
    const pad = width - plain.length;
    const body = pad > 0 ? `${stableText}${fillBg}${" ".repeat(pad)}` : stableText;
    return [fillBg ? `${body}${D_RST}` : body];
  }
  const rows: string[] = [];
  let row = "";
  let vis = 0;
  let i = 0;
  while (i < stableText.length) {
    if (stableText[i] === "\x1b") {
      const end = stableText.indexOf("m", i);
      if (end !== -1) {
        row += stableText.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (vis >= width) {
      const state = ansiState(row);
      rows.push(row + D_RST);
      row = state + fillBg;
      vis = 0;
    }
    row += stableText[i];
    vis++;
    i++;
  }
  rows.push(row + fillBg + " ".repeat(Math.max(0, width - vis)) + D_RST);
  return rows;
}
function lnum(n: number | null, width: number, fg = FG_LNUM): string {
  if (n === null) return " ".repeat(width);
  const value = String(n);
  return `${fg}${" ".repeat(Math.max(0, width - value.length))}${value}${D_RST}`;
}
function stripes(width: number): string {
  return BG_BASE + FG_STRIPE + "╱".repeat(width) + D_RST;
}
function diffRule(width: number): string {
  return `${BG_BASE}${FG_RULE}${"─".repeat(width)}${D_RST}`;
}
function collapsedDiffHint(remainingLines: number): string {
  return `… (${remainingLines} more diff lines • Ctrl+O to expand)`;
}

export interface DiffLine {
  type: "add" | "del" | "ctx" | "sep";
  oldNum: number | null;
  newNum: number | null;
  content: string;
}
export interface ParsedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  chars: number;
}

export function parseDiff(
  oldContent: string,
  newContent: string,
  ctxLines = 3,
): ParsedDiff {
  const patch = Diff.structuredPatch("", "", oldContent, newContent, "", "", {
    context: ctxLines,
  });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (let hi = 0; hi < patch.hunks.length; hi++) {
    if (hi > 0) {
      const prev = patch.hunks[hi - 1]!;
      const gap = patch.hunks[hi]!.oldStart - (prev.oldStart + prev.oldLines);
      lines.push({
        type: "sep",
        oldNum: null,
        newNum: gap > 0 ? gap : null,
        content: "",
      });
    }
    const hunk = patch.hunks[hi]!;
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const raw of hunk.lines) {
      if (raw === "\\ No newline at end of file") continue;
      const ch = raw[0];
      const text = raw.slice(1);
      if (ch === "+") {
        lines.push({
          type: "add",
          oldNum: null,
          newNum: newLine++,
          content: text,
        });
        added++;
      } else if (ch === "-") {
        lines.push({
          type: "del",
          oldNum: oldLine++,
          newNum: null,
          content: text,
        });
        removed++;
      } else {
        lines.push({
          type: "ctx",
          oldNum: oldLine++,
          newNum: newLine++,
          content: text,
        });
      }
    }
  }
  return {
    lines,
    added,
    removed,
    chars: oldContent.length + newContent.length,
  };
}

function summarizeDiff(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${FG_ADD}+${added}${D_RST}`);
  if (removed > 0) parts.push(`${FG_DEL}-${removed}${D_RST}`);
  if (!parts.length) return `${FG_DIM}no changes${D_RST}`;
  return parts.join(" ");
}

export function diffSummaryWithMeta(
  added: number,
  removed: number,
  hunks: number,
  mode: string,
): string {
  const base = summarizeDiff(added, removed);
  const extras: string[] = [];
  if (hunks > 0)
    extras.push(`${FG_DIM}${hunks} hunk${hunks === 1 ? "" : "s"}${D_RST}`);
  if (mode) extras.push(`${FG_DIM}${mode}${D_RST}`);
  return extras.length
    ? `${base} ${FG_DIM}•${D_RST} ${extras.join(` ${FG_DIM}•${D_RST} `)}`
    : base;
}

const hlCache = new Map<string, string[]>();
function touchCache(key: string, value: string[]): string[] {
  hlCache.delete(key);
  hlCache.set(key, value);
  while (hlCache.size > CACHE_LIMIT) {
    const first = hlCache.keys().next().value;
    if (first === undefined) break;
    hlCache.delete(first);
  }
  return value;
}
async function hlBlock(
  code: string,
  language: BundledLanguage | undefined,
): Promise<string[]> {
  if (!code) return [""];
  if (!language || code.length > MAX_HL_CHARS) return code.split("\n");
  const key = `${DIFF_THEME}\0${language}\0${code}`;
  const hit = hlCache.get(key);
  if (hit) return touchCache(key, hit);
  try {
    const ansi = normalizeShikiContrast(
      await codeToANSI(code, language, DIFF_THEME),
    );
    const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
    return touchCache(key, out);
  } catch {
    return code.split("\n");
  }
}

export async function highlightCodeBlock(
  code: string,
  language: BundledLanguage | undefined,
): Promise<string[]> {
  return hlBlock(code, language);
}

function wordDiffAnalysis(
  oldText: string,
  newText: string,
): {
  similarity: number;
  oldRanges: Array<[number, number]>;
  newRanges: Array<[number, number]>;
} {
  if (!oldText && !newText)
    return { similarity: 1, oldRanges: [], newRanges: [] };
  const parts = Diff.diffWords(oldText, newText);
  const oldRanges: Array<[number, number]> = [];
  const newRanges: Array<[number, number]> = [];
  let oldPos = 0,
    newPos = 0,
    same = 0;
  for (const part of parts) {
    if (part.removed) {
      oldRanges.push([oldPos, oldPos + part.value.length]);
      oldPos += part.value.length;
    } else if (part.added) {
      newRanges.push([newPos, newPos + part.value.length]);
      newPos += part.value.length;
    } else {
      const len = part.value.length;
      same += len;
      oldPos += len;
      newPos += len;
    }
  }
  const maxLen = Math.max(oldText.length, newText.length);
  return { similarity: maxLen > 0 ? same / maxLen : 1, oldRanges, newRanges };
}

function injectBg(
  ansiLine: string,
  ranges: Array<[number, number]>,
  baseBg: string,
  hlBg: string,
): string {
  if (!ranges.length) return baseBg + ansiLine + D_RST;
  let out = baseBg;
  let vis = 0;
  let inHL = false;
  let rangeIndex = 0;
  let i = 0;
  while (i < ansiLine.length) {
    if (ansiLine[i] === "\x1b") {
      const end = ansiLine.indexOf("m", i);
      if (end !== -1) {
        const seq = ansiLine.slice(i, end + 1);
        out += seq;
        if (seq === "\x1b[0m") out += inHL ? hlBg : baseBg;
        i = end + 1;
        continue;
      }
    }
    while (rangeIndex < ranges.length && vis >= ranges[rangeIndex]![1])
      rangeIndex++;
    const want =
      rangeIndex < ranges.length &&
      vis >= ranges[rangeIndex]![0] &&
      vis < ranges[rangeIndex]![1];
    if (want !== inHL) {
      inHL = want;
      out += inHL ? hlBg : baseBg;
    }
    out += ansiLine[i];
    vis++;
    i++;
  }
  return out + D_RST;
}

function plainWordDiff(
  oldText: string,
  newText: string,
): { old: string; new: string } {
  const parts = Diff.diffWords(oldText, newText);
  let oldOut = "",
    newOut = "";
  for (const part of parts) {
    if (part.removed) oldOut += `${BG_DEL_W}${part.value}${D_RST}${BG_DEL}`;
    else if (part.added) newOut += `${BG_ADD_W}${part.value}${D_RST}${BG_ADD}`;
    else {
      oldOut += part.value;
      newOut += part.value;
    }
  }
  return { old: oldOut, new: newOut };
}

function shouldUseSplit(diff: ParsedDiff, tw: number): boolean {
  if (!diff.lines.length) return false;
  return tw >= 150;
}

export async function renderSplit(
  diff: ParsedDiff,
  language: BundledLanguage | undefined,
  max = MAX_PREVIEW_LINES,
  dc: DiffColors = DEFAULT_DIFF_COLORS,
): Promise<string> {
  const tw = termW();
  if (!shouldUseSplit(diff, tw)) return renderUnified(diff, language, max, dc);
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let i = 0;
  while (i < diff.lines.length) {
    const line = diff.lines[i]!;
    if (line.type === "sep" || line.type === "ctx") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < diff.lines.length && diff.lines[i]!.type === "del")
      dels.push(diff.lines[i++]!);
    while (i < diff.lines.length && diff.lines[i]!.type === "add")
      adds.push(diff.lines[i++]!);
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++)
      rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
  }
  const vis = rows.slice(0, max);
  const half = Math.floor((tw - 1) / 2);
  const nw = Math.max(
    2,
    String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0))
      .length,
  );
  const gw = nw + 5;
  const cw = Math.max(12, half - gw);
  const canHL =
    diff.chars <= MAX_HL_CHARS && vis.length * 2 <= MAX_RENDER_LINES * 2;
  const leftSrc: string[] = [];
  const rightSrc: string[] = [];
  for (const row of vis) {
    if (row.left && row.left.type !== "sep") leftSrc.push(row.left.content);
    if (row.right && row.right.type !== "sep") rightSrc.push(row.right.content);
  }
  const [leftHL, rightHL] = canHL
    ? await Promise.all([
        hlBlock(leftSrc.join("\n"), language),
        hlBlock(rightSrc.join("\n"), language),
      ])
    : [leftSrc, rightSrc];
  let leftIndex = 0,
    rightIndex = 0;
  type HalfResult = { gutter: string; contGutter: string; bodyRows: string[] };
  const halfBuild = (
    line: DiffLine | null,
    hl: string,
    ranges: Array<[number, number]> | null,
    side: "left" | "right",
  ): HalfResult => {
    if (!line) {
      const gPat = FG_STRIPE + "╱".repeat(nw + 2) + D_RST;
      const gutter = ` ${gPat}${FG_RULE}│${D_RST} `;
      return { gutter, contGutter: gutter, bodyRows: [stripes(cw)] };
    }
    if (line.type === "sep") {
      const label =
        line.newNum && line.newNum > 0 ? `··· ${line.newNum} lines ···` : "···";
      const gutter = `${BG_BASE} ${FG_DIM}${fit("", nw + 2)}${D_RST}${FG_RULE}│${D_RST} `;
      return {
        gutter,
        contGutter: gutter,
        bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, cw)}${D_RST}`],
      };
    }
    const isDel = line.type === "del";
    const isAdd = line.type === "add";
    const cBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE;
    const gBg = cBg;
    const sFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : dc.fgCtx;
    const sign = isDel ? "-" : isAdd ? "+" : " ";
    const num = isDel
      ? line.oldNum
      : isAdd
        ? line.newNum
        : side === "left"
          ? line.oldNum
          : line.newNum;
    const borderFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : "";
    const border = borderFg ? `${gBg}${borderFg}▌${D_RST}${gBg}` : `${gBg} `;
    const numFg = borderFg || FG_LNUM;
    let body =
      ranges && ranges.length > 0
        ? injectBg(hl, ranges, cBg, isDel ? BG_DEL_W : BG_ADD_W)
        : isDel || isAdd
          ? `${cBg}${hl}`
          : `${BG_BASE}${D_DIM}${hl}`;
    const gutter = `${border}${lnum(num, nw, numFg)}${gBg}${sFg}${D_BOLD}${sign}${D_RST}${cBg} ${FG_RULE}│ ${D_RST}`;
    const contGutter = `${border}${" ".repeat(nw + 1)}${D_RST}${cBg} ${FG_RULE}│ ${D_RST}`;
    return { gutter, contGutter, bodyRows: wrapAnsi(tabs(body), cw, cBg) };
  };
  const out: string[] = [];
  const hdrOld = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgDel}${D_DIM}old${D_RST}`;
  const hdrNew = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgAdd}${D_DIM}new${D_RST}`;
  out.push(
    `${BG_BASE}${hdrOld}${" ".repeat(Math.max(0, half - nw - 1))}${FG_RULE}┊${D_RST}${hdrNew}`,
  );
  out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);
  for (const row of vis) {
    const paired = Boolean(
      row.left &&
      row.right &&
      row.left.type === "del" &&
      row.right.type === "add",
    );
    const wd =
      paired && row.left && row.right
        ? wordDiffAnalysis(row.left.content, row.right.content)
        : null;
    let leftResult: HalfResult;
    let rightResult: HalfResult;
    if (
      paired &&
      wd &&
      row.left &&
      row.right &&
      wd.similarity >= WORD_DIFF_MIN_SIM &&
      canHL
    ) {
      leftResult = halfBuild(
        row.left,
        leftHL[leftIndex++] ?? row.left.content,
        wd.oldRanges,
        "left",
      );
      rightResult = halfBuild(
        row.right,
        rightHL[rightIndex++] ?? row.right.content,
        wd.newRanges,
        "right",
      );
    } else if (
      paired &&
      wd &&
      row.left &&
      row.right &&
      wd.similarity >= WORD_DIFF_MIN_SIM &&
      !canHL
    ) {
      const pwd = plainWordDiff(row.left.content, row.right.content);
      leftIndex++;
      rightIndex++;
      leftResult = halfBuild(row.left, pwd.old, null, "left");
      rightResult = halfBuild(row.right, pwd.new, null, "right");
    } else {
      leftResult = halfBuild(
        row.left,
        row.left && row.left.type !== "sep"
          ? (leftHL[leftIndex++] ?? row.left.content)
          : "",
        null,
        "left",
      );
      rightResult = halfBuild(
        row.right,
        row.right && row.right.type !== "sep"
          ? (rightHL[rightIndex++] ?? row.right.content)
          : "",
        null,
        "right",
      );
    }
    const maxRows = Math.max(
      leftResult.bodyRows.length,
      rightResult.bodyRows.length,
    );
    for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
      const lg = rowIndex === 0 ? leftResult.gutter : leftResult.contGutter;
      const rg = rowIndex === 0 ? rightResult.gutter : rightResult.contGutter;
      const lb =
        leftResult.bodyRows[rowIndex] ??
        (!row.left ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`);
      const rb =
        rightResult.bodyRows[rowIndex] ??
        (!row.right ? stripes(cw) : `${BG_EMPTY}${" ".repeat(cw)}${D_RST}`);
      out.push(`${lg}${lb}${DIVIDER}${rg}${rb}`);
    }
  }
  out.push(`${diffRule(half)}${FG_RULE}┊${D_RST}${diffRule(half)}`);
  if (rows.length > vis.length)
    out.push(
      `${BG_BASE}${FG_DIM}  ${collapsedDiffHint(rows.length - vis.length)}${D_RST}`,
    );
  return out.join("\n");
}

async function renderUnified(
  diff: ParsedDiff,
  language: BundledLanguage | undefined,
  max = MAX_RENDER_LINES,
  dc: DiffColors = DEFAULT_DIFF_COLORS,
): Promise<string> {
  if (!diff.lines.length) return "";
  const vis = diff.lines.slice(0, max);
  const tw = termW();
  const nw = Math.max(
    2,
    String(Math.max(...vis.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
  );
  const gw = nw + 5;
  const cw = Math.max(20, tw - gw);
  const canHL = diff.chars <= MAX_HL_CHARS && vis.length <= MAX_RENDER_LINES;
  const oldSrc: string[] = [];
  const newSrc: string[] = [];
  for (const line of vis) {
    if (line.type === "ctx" || line.type === "del") oldSrc.push(line.content);
    if (line.type === "ctx" || line.type === "add") newSrc.push(line.content);
  }
  const [oldHL, newHL] = canHL
    ? await Promise.all([
        hlBlock(oldSrc.join("\n"), language),
        hlBlock(newSrc.join("\n"), language),
      ])
    : [oldSrc, newSrc];
  let oldIndex = 0,
    newIndex = 0,
    index = 0;
  const out: string[] = [diffRule(tw)];
  const emitRow = (
    num: number | null,
    sign: string,
    gutterBg: string,
    signFg: string,
    body: string,
    bodyBg = "",
  ) => {
    const borderFg = sign === "-" ? dc.fgDel : sign === "+" ? dc.fgAdd : "";
    const contentBg = bodyBg || BG_BASE;
    const rowBg = contentBg;
    void gutterBg;
    const border = borderFg ? `${rowBg}${borderFg}▌${D_RST}${rowBg}` : `${rowBg} `;
    const numFg = borderFg || FG_LNUM;
    const gutter = `${border}${lnum(num, nw, numFg)}${rowBg}${signFg}${sign}${D_RST}${rowBg} ${FG_RULE}│ ${D_RST}`;
    const cont = `${border}${" ".repeat(nw + 1)}${D_RST}${rowBg} ${FG_RULE}│ ${D_RST}`;
    const rows = wrapAnsi(tabs(body), cw, bodyBg);
    out.push(`${gutter}${rows[0] ?? ""}${D_RST}`);
    for (let r = 1; r < rows.length; r++)
      out.push(`${cont}${rows[r] ?? ""}${D_RST}`);
  };
  while (index < vis.length) {
    const line = vis[index]!;
    if (line.type === "sep") {
      out.push(`${BG_BASE}${FG_DIM}···${D_RST}`);
      index++;
      continue;
    }
    if (line.type === "ctx") {
      const hl = oldHL[oldIndex] ?? line.content;
      emitRow(
        line.newNum,
        " ",
        BG_BASE,
        dc.fgCtx,
        `${BG_BASE}${D_DIM}${hl}`,
        BG_BASE,
      );
      oldIndex++;
      newIndex++;
      index++;
      continue;
    }
    const dels: Array<{ l: DiffLine; hl: string }> = [];
    while (index < vis.length && vis[index]!.type === "del") {
      dels.push({ l: vis[index]!, hl: oldHL[oldIndex] ?? vis[index]!.content });
      oldIndex++;
      index++;
    }
    const adds: Array<{ l: DiffLine; hl: string }> = [];
    while (index < vis.length && vis[index]!.type === "add") {
      adds.push({ l: vis[index]!, hl: newHL[newIndex] ?? vis[index]!.content });
      newIndex++;
      index++;
    }
    const isPaired = dels.length === 1 && adds.length === 1;
    const wd = isPaired
      ? wordDiffAnalysis(dels[0]!.l.content, adds[0]!.l.content)
      : null;
    if (isPaired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
      emitRow(
        dels[0]!.l.oldNum,
        "-",
        BG_GUTTER_DEL,
        `${dc.fgDel}${D_BOLD}`,
        injectBg(dels[0]!.hl, wd.oldRanges, BG_DEL, BG_DEL_W),
        BG_DEL,
      );
      emitRow(
        adds[0]!.l.newNum,
        "+",
        BG_GUTTER_ADD,
        `${dc.fgAdd}${D_BOLD}`,
        injectBg(adds[0]!.hl, wd.newRanges, BG_ADD, BG_ADD_W),
        BG_ADD,
      );
      continue;
    }
    for (const d of dels)
      emitRow(
        d.l.oldNum,
        "-",
        BG_GUTTER_DEL,
        `${dc.fgDel}${D_BOLD}`,
        `${BG_DEL}${canHL ? d.hl : d.l.content}`,
        BG_DEL,
      );
    for (const a of adds)
      emitRow(
        a.l.newNum,
        "+",
        BG_GUTTER_ADD,
        `${dc.fgAdd}${D_BOLD}`,
        `${BG_ADD}${canHL ? a.hl : a.l.content}`,
        BG_ADD,
      );
  }
  out.push(diffRule(tw));
  if (diff.lines.length > vis.length)
    out.push(
      `${BG_BASE}${FG_DIM}  ${collapsedDiffHint(diff.lines.length - vis.length)}${D_RST}`,
    );
  return out.join("\n");
}

export function getEditOperations(
  input: any,
): Array<{ oldText: string; newText: string }> {
  if (Array.isArray(input?.edits)) {
    return input.edits
      .map((edit: any) => ({
        oldText:
          typeof edit?.oldText === "string"
            ? edit.oldText
            : typeof edit?.old_text === "string"
              ? edit.old_text
              : "",
        newText:
          typeof edit?.newText === "string"
            ? edit.newText
            : typeof edit?.new_text === "string"
              ? edit.new_text
              : "",
      }))
      .filter(
        (edit: { oldText: string; newText: string }) =>
          edit.oldText && edit.oldText !== edit.newText,
      );
  }
  const oldText =
    typeof input?.oldText === "string"
      ? input.oldText
      : typeof input?.old_text === "string"
        ? input.old_text
        : "";
  const newText =
    typeof input?.newText === "string"
      ? input.newText
      : typeof input?.new_text === "string"
        ? input.new_text
        : "";
  return oldText && oldText !== newText ? [{ oldText, newText }] : [];
}

export function summarizeEditOperations(
  operations: Array<{ oldText: string; newText: string }>,
) {
  const diffs = operations.map((edit) => parseDiff(edit.oldText, edit.newText));
  const totalAdded = diffs.reduce((sum, diff) => sum + diff.added, 0);
  const totalRemoved = diffs.reduce((sum, diff) => sum + diff.removed, 0);
  const totalLines = diffs.reduce((sum, diff) => sum + diff.lines.length, 0);
  const totalHunks = diffs.reduce(
    (sum, diff) =>
      sum +
      diff.lines.filter((l) => l.type === "sep").length +
      (diff.lines.length ? 1 : 0),
    0,
  );
  return {
    diffs,
    totalAdded,
    totalRemoved,
    totalLines,
    totalHunks,
    summary: summarizeDiff(totalAdded, totalRemoved),
  };
}

function getMode<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function isMcpToolCandidate(tool: unknown): boolean {
  const rec = tool as Record<string, unknown> | undefined;
  const name = typeof rec?.name === "string" ? rec.name : "";
  const description =
    typeof rec?.description === "string" ? rec.description : "";
  return name === "mcp" || /\bmcp\b/i.test(description);
}

export function registerMcpToolOverrides(pi: ExtensionAPI): void {
  const wrappedMcpTools = new Set<string>();
  const doRegister = (): void => {
    let allTools: unknown[] = [];
    try {
      allTools =
        typeof (pi as any).getAllTools === "function"
          ? (pi as any).getAllTools()
          : [];
    } catch {
      allTools = [];
    }
    for (const tool of allTools) {
      if (!isMcpToolCandidate(tool)) continue;
      const record = tool as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      if (!name || wrappedMcpTools.has(name)) continue;
      const execute =
        typeof record.execute === "function" ? (record.execute as any) : null;
      if (!execute) continue;
      const label =
        typeof record.label === "string"
          ? record.label
          : name === "mcp"
            ? "MCP"
            : `MCP ${name}`;
      const description =
        typeof record.description === "string"
          ? record.description
          : "MCP tool";
      (pi as any).registerTool({
        name,
        label,
        description,
        parameters: record.parameters,
        prepareArguments:
          typeof record.prepareArguments === "function"
            ? record.prepareArguments
            : undefined,
        async execute(
          toolCallId: string,
          params: any,
          signal: AbortSignal | undefined,
          onUpdate: any,
          ctx: any,
        ) {
          return await Promise.resolve(
            execute(toolCallId, params, signal, onUpdate, ctx),
          );
        },
        renderCall(args: any, theme: Theme, ctx: any) {
          const target =
            name === "mcp"
              ? typeof args?.tool === "string"
                ? `${args.server ? `${args.server}:` : ""}${args.tool}`
                : typeof args?.connect === "string"
                  ? `connect ${args.connect}`
                  : typeof args?.search === "string"
                    ? `search ${JSON.stringify(args.search)}`
                    : "status"
              : label;
          const content = `${formatCallStatus(ctx, theme)}${theme.fg("toolTitle", theme.bold("MCP"))} ${theme.fg("accent", target)}`;
          const last = ctx.lastComponent;
          if (last instanceof Text) {
            last.setText(content);
            return last;
          }
          return new Text(content, 0, 0);
        },
        renderResult(
          result: any,
          { expanded, isPartial }: any,
          theme: Theme,
          ctx: any,
        ) {
          const raw =
            result.content
              ?.filter((c: any) => c.type === "text")
              .map((c: any) => c.text || "")
              .join("\n") ?? "";
          const lines = raw
            .split("\n")
            .filter((line: string) => line.trim().length > 0);
          let text = isPartial
            ? theme.fg("dim", "running...")
            : theme.fg(
                "muted",
                `${lines.length} line${lines.length === 1 ? "" : "s"} returned`,
              );
          if (!isPartial) {
            const mode = getMode(
              readSettings().mcpOutputMode,
              ["hidden", "summary", "preview"] as const,
              "preview",
            );
            if (mode === "hidden") text = "";
            else if (mode === "preview")
              text += `\n${buildPreviewText(
                lines.map((line: string) => theme.fg("toolOutput", line)),
                expanded,
                theme,
                previewLimit(),
              )}`;
          }
          const node = ctx.lastComponent;
          if (node instanceof Text) {
            node.setText(withBranch(text, theme));
            return node;
          }
          return new Text(withBranch(text, theme), 0, 0);
        },
      });
      wrappedMcpTools.add(name);
    }
  };
  pi.on("session_start", async () => {
    doRegister();
  });
  pi.on("before_agent_start", async () => {
    doRegister();
  });
}
