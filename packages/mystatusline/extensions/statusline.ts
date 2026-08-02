import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

export type FooterDataLike = {
  getGitBranch(): string | null;
  onBranchChange(listener: () => void): () => void;
};

export type StatuslineThemeLike = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type WorkspaceStats = {
  dirty: boolean;
  added: number;
  removed: number;
};

export type UsageTotals = {
  input: number;
  output: number;
  cost: number;
};

export type StatuslineRenderContext = {
  ctx: ExtensionContext;
  footerData: FooterDataLike;
  theme: StatuslineThemeLike;
  getThinkingLevel(): string;
  workspace: WorkspaceStats;
  usageTotals: UsageTotals;
  lastTps: number | null;
};

const ICONS = {
  context: "",
  branch: "",
  folder: "󰉋",
  warn: "",
  tps: "󰓅",
};

const MODEL_HEX = "E3A869";
const PATH_HEX = "7CB7FF";
const BRANCH_HEX = "91CB91";
const CONTEXT_HEX = "B392F0";
const COST_HEX = "FF78A2";
const TPS_HEX = "6ED7D3";
const SEPARATOR_HEX = "3B4048";

type ModelStyle = {
  icon: string;
  colorHex: string;
  fallback: string;
  label: string;
};

function formatCompactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 100_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function formatTps(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value <= 0) return `0.0 tps`;
  return `${value.toFixed(1)} tps`;
}

function getModelLabel(modelName: string | undefined): string {
  return modelName ?? "no-model";
}

function getModelStyle(modelId: string | undefined): ModelStyle {
  const label = getModelLabel(modelId);
  return { icon: "", colorHex: MODEL_HEX, fallback: "accent", label };
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace(/^#/, "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return [r, g, b];
}

function supportsTruecolor(): boolean {
  const colorterm = process.env.COLORTERM?.toLowerCase();
  return colorterm === "truecolor" || colorterm === "24bit";
}

function colorHex(theme: StatuslineThemeLike, hex: string, text: string, fallback: string): string {
  if (!supportsTruecolor()) {
    return theme.fg(fallback, text);
  }

  const [r, g, b] = hexToRgb(hex);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

function medium(theme: StatuslineThemeLike, text: string): string {
  return theme.bold(text);
}

function getUsageColor(percent: number | null): string {
  const safePercent = percent ?? 0;
  if (safePercent >= 90) return "error";
  if (safePercent >= 70) return "warning";
  return "success";
}


function joinParts(theme: StatuslineThemeLike, parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(colorHex(theme, SEPARATOR_HEX, " | ", "dim"));
}

function renderLine1(input: StatuslineRenderContext): string {
  const { ctx, theme, footerData, getThinkingLevel } = input;
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const tokens = usage?.tokens ?? null;
  const percent = usage?.percent ?? null;
  const usageColor = getUsageColor(percent);
  const percentLabel = percent === null ? "?" : `${percent.toFixed(1)}%`;
  const tokenLabel = tokens === null ? "?" : formatCompactTokens(tokens);
  const windowLabel = contextWindow > 0 ? formatCompactTokens(contextWindow) : "?";
  const modelStyle = getModelStyle(ctx.model?.name);
  const totals = input.usageTotals;
  const totalCost = totals.cost;
  const tpsLabel = formatTps(input.lastTps);
  const branch = footerData.getGitBranch();
  const cwdLabel = `${colorHex(theme, PATH_HEX, medium(theme, ICONS.folder), "accent")} ${colorHex(theme, PATH_HEX, medium(theme, basename(ctx.cwd) || ctx.cwd), "accent")}`;
  const branchLabel = branch ? `${colorHex(theme, BRANCH_HEX, medium(theme, ICONS.branch), "success")} ${colorHex(theme, BRANCH_HEX, medium(theme, branch), "success")}` : undefined;
  const thinkingLevel = getThinkingLevel();
  const modelWithThinking = medium(
    theme,
    colorHex(theme, modelStyle.colorHex, `${modelStyle.label}(${thinkingLevel})`, modelStyle.fallback),
  );

  return joinParts(theme, [
    `${colorHex(theme, modelStyle.colorHex, medium(theme, modelStyle.icon), modelStyle.fallback)} ${modelWithThinking}`,
    cwdLabel,
    branchLabel,
    `${colorHex(theme, CONTEXT_HEX, medium(theme, ICONS.context), "accent")} ${colorHex(theme, CONTEXT_HEX, medium(theme, percentLabel), usageColor)}${(percent ?? 0) >= 90 ? ` ${theme.fg("error", medium(theme, ICONS.warn))}` : ""} ${colorHex(theme, CONTEXT_HEX, `(${tokenLabel}/${windowLabel})`, "dim")}`,
    medium(theme, colorHex(theme, COST_HEX, `$${totalCost.toFixed(2)}`, totalCost > 0 ? "warning" : "dim")),
    colorHex(theme, TPS_HEX, medium(theme, `${ICONS.tps} ${tpsLabel}`), "accent"),
  ]);
}

export function renderStatusline(width: number, input: StatuslineRenderContext): string[] {
  return [truncateToWidth(renderLine1(input), width)];
}
