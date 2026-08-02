import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

interface StartupHeaderOptions {
  cwd?: string;
  version?: string;
  piVersion?: string;
}

function centerLine(text: string, width: number, offset = 0): string {
  const renderedWidth = visibleWidth(text);
  if (renderedWidth >= width) return truncateToWidth(text, width);
  const leftPad = Math.max(0, Math.floor((width - renderedWidth) / 2) + offset);
  return `${" ".repeat(leftPad)}${text}`;
}

function shortenPath(path: string | undefined): string {
  if (!path) return "";
  const home = homedir();
  const display = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return display;
}

export function createStartupHeader(
  theme: Theme,
  options?: StartupHeaderOptions,
) {
  const accent = (text: string) => theme.fg("accent", theme.bold(text));
  const muted = (text: string) => theme.fg("muted", text);
  const dim = (text: string) => theme.fg("dim", text);

  const logo = [
    accent("    ██████╗   ██╗"),
    accent("    ██╔══██╗  ╚═╝"),
    accent("    ██████╔╝  ██╗"),
    accent("    ██╔═══╝   ██║"),
    accent("    ██║       ██║"),
    accent("    ╚═╝       ╚═╝"),
  ];

  const cwdLine = muted(shortenPath(options?.cwd));
  const versionLine = dim(
    options?.piVersion ? `pi v${options.piVersion} · cc-ui` : "Pi Coding Agent",
  );

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(24, width);
      return [
        "",
        ...logo.map((line) => centerLine(line, safeWidth, -1)),
        "",
        centerLine(cwdLine, safeWidth),
        centerLine(versionLine, safeWidth),
        "",
      ];
    },
    invalidate() {},
  };
}
