import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, stripAnsi } from "./utils";

export interface ThemeLike {
  fg(color: string, text: string): string;
}

export interface AssistantMessageLike {
  role?: unknown;
  api?: unknown;
  content?: unknown;
  usage?: unknown;
}

const THINKING_CHAT_PREFIX = "Thinking: ";
const THINKING_LABEL_PREFIX_PATTERN = /^(?:thinking:\s*)+/i;
const LEADING_ANSI_FRAGMENT_PATTERN = /^(?:\s*;?\d{1,3}(?:;\d{1,3})*m)+\s*/;

function stripLeadingAnsiFragments(text: string): string {
  let current = text;
  while (true) {
    const next = current.replace(LEADING_ANSI_FRAGMENT_PATTERN, "");
    if (next === current) return current;
    current = next;
  }
}

function stripThinkingPresentationArtifacts(text: string): string {
  let current = stripAnsi(text);
  let removedThinkingLabel = false;

  while (true) {
    const withoutLabel = current.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart();
    if (withoutLabel !== current) {
      current = withoutLabel;
      removedThinkingLabel = true;
      continue;
    }

    const withoutAnsiFragments = stripLeadingAnsiFragments(current).trimStart();
    if (withoutAnsiFragments !== current) {
      const fragmentExposedAnotherLabel =
        withoutAnsiFragments.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart() !==
        withoutAnsiFragments;

      if (removedThinkingLabel || fragmentExposedAnotherLabel) {
        current = withoutAnsiFragments;
        continue;
      }
    }

    return current;
  }
}

function formatThinkingLabel(theme: ThemeLike | undefined, thinkingText: string): string {
  const prefix = theme ? theme.fg("accent", THINKING_CHAT_PREFIX) : THINKING_CHAT_PREFIX;
  return `${prefix}${thinkingText}`;
}

function prefixThinkingLine(text: string, theme: ThemeLike | undefined): string {
  const normalizedThinking = stripThinkingPresentationArtifacts(text).trim();
  if (!normalizedThinking) return text;
  return formatThinkingLabel(theme, normalizedThinking);
}

function normalizeThinkingLineForContext(text: string): string {
  return stripThinkingPresentationArtifacts(text);
}

function isThinkingBlock(value: unknown): value is Record<string, unknown> & {
  type: "thinking";
  thinking: string;
} {
  if (!isRecord(value)) return false;
  return value.type === "thinking" && typeof value.thinking === "string";
}

function withThinkingLabelsForDisplay(content: unknown, theme: ThemeLike | undefined): unknown {
  if (!Array.isArray(content)) return content;

  let changed = false;
  const nextContent = content.map((block) => {
    if (!isThinkingBlock(block)) return block;
    const nextThinking = prefixThinkingLine(block.thinking, theme);
    if (nextThinking === block.thinking) return block;
    changed = true;
    return { ...block, thinking: nextThinking };
  });

  return changed ? nextContent : content;
}

function sanitizeThinkingBlocksForContext(message: AssistantMessageLike): AssistantMessageLike {
  if (!Array.isArray(message.content)) return message;

  let changed = false;
  const nextContent = message.content.map((block) => {
    if (!isThinkingBlock(block)) return block;
    const nextThinking = normalizeThinkingLineForContext(block.thinking);
    if (nextThinking === block.thinking) return block;
    changed = true;
    return { ...block, thinking: nextThinking };
  });

  return changed ? { ...message, content: nextContent } : message;
}

function sanitizeContextMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!isRecord(message) || message.role !== "assistant") return message;
    const sanitized = sanitizeThinkingBlocksForContext(message as AssistantMessageLike);
    if (sanitized !== message) {
      changed = true;
      return sanitized;
    }
    return message;
  });

  return changed ? nextMessages : messages;
}

function prefixThinkingBlocksForDisplay(message: AssistantMessageLike, theme: ThemeLike | undefined): void {
  const displayContent = withThinkingLabelsForDisplay(message.content, theme);
  if (displayContent !== message.content) message.content = displayContent;
}

export function extractAssistantMessage(event: unknown): AssistantMessageLike | undefined {
  if (!isRecord(event)) return undefined;
  const maybeMessage = event.message;
  if (!isRecord(maybeMessage)) return undefined;
  if (maybeMessage.role !== "assistant") return undefined;
  return maybeMessage as AssistantMessageLike;
}

export function handleThinkingMessageUpdateEvent(event: unknown, ctx: ExtensionContext | undefined): void {
  try {
    const message = extractAssistantMessage(event);
    if (!message) return;
    prefixThinkingBlocksForDisplay(message, (ctx as { ui?: { theme?: ThemeLike } })?.ui?.theme);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`Thinking label formatting failed: ${msg}`, "warning");
  }
}

export function handleThinkingMessageEndEvent(event: unknown, ctx: ExtensionContext | undefined): void {
  try {
    const message = extractAssistantMessage(event);
    if (!message) return;
    prefixThinkingBlocksForDisplay(message, (ctx as { ui?: { theme?: ThemeLike } })?.ui?.theme);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`Thinking label finalization failed: ${msg}`, "warning");
  }
}

export function handleThinkingContextEvent(event: unknown, ctx: ExtensionContext | undefined): void {
  try {
    if (!isRecord(event) || !Array.isArray(event.messages)) return;
    const sanitizedMessages = sanitizeContextMessages(event.messages);
    if (sanitizedMessages !== event.messages && Array.isArray(sanitizedMessages)) {
      event.messages.splice(0, event.messages.length, ...sanitizedMessages);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`Thinking context sanitization failed: ${msg}`, "warning");
  }
}

export function countTextLength(content: unknown[]): number {
  let length = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") length += block.text.length;
  }
  return length;
}

export function hasToolCall(content: unknown[]): boolean {
  for (const block of content) {
    if (isRecord(block) && block.type === "toolCall") return true;
  }
  return false;
}

export function hasThinking(content: unknown[]): boolean {
  for (const block of content) {
    if (isRecord(block) && block.type === "thinking") return true;
  }
  return false;
}

export function getAssistantOutputTokens(message: AssistantMessageLike | undefined): number | null {
  if (!message || !isRecord(message.usage)) return null;
  const output = message.usage.output;
  return typeof output === "number" && Number.isFinite(output) ? output : null;
}
