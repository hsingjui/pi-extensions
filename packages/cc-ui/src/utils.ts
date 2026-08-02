import { ANSI_ESCAPE_RE } from "./constants";

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function isBorderLine(text: string): boolean {
  const plain = stripAnsi(text).trimStart();
  return plain.startsWith("──");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
