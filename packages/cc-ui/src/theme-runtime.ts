import type { Theme } from "@earendil-works/pi-coding-agent";

type ThemeLike = Pick<Theme, "fg" | "bg" | "bold" | "getBashModeBorderColor"> & {
  readonly name?: string;
};

const identity = (text: string) => text;

const fallbackTheme: ThemeLike = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: identity,
  getBashModeBorderColor: () => identity,
};

let activeTheme: ThemeLike = fallbackTheme;
let activeThemeVersion = 0;

export function setActiveTheme(theme: Theme | null | undefined): void {
  if (!theme) return;
  activeTheme = theme;
  activeThemeVersion++;
}

export function getActiveTheme(): ThemeLike {
  return activeTheme;
}

export function getActiveThemeVersion(): number {
  return activeThemeVersion;
}
