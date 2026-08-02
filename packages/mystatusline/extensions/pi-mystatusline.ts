import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderStatusline, type UsageTotals, type WorkspaceStats } from "./statusline";

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  return role === "assistant";
}

export default function (pi: ExtensionAPI) {
  let workspace: WorkspaceStats = {
    dirty: false,
    added: 0,
    removed: 0,
  };
  let usageTotals: UsageTotals = {
    input: 0,
    output: 0,
    cost: 0,
  };
  let agentStartMs: number | null = null;
  let lastTps: number | null = null;
  let requestFooterRender: (() => void) | undefined;

  const refreshUsageTotals = (ctx: ExtensionContext) => {
    let input = 0;
    let output = 0;
    let cost = 0;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message as AssistantMessage;
      input += message.usage.input;
      output += message.usage.output;
      cost += message.usage.cost.total;
    }

    usageTotals = { input, output, cost };
  };

  const refreshWorkspace = async (ctx: ExtensionContext) => {
    const cwd = JSON.stringify(ctx.cwd);
    const command = `
if ! git -C ${cwd} rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi
status=$(git -C ${cwd} status --porcelain 2>/dev/null)
stats=$(
  (git -C ${cwd} diff --numstat 2>/dev/null; git -C ${cwd} diff --cached --numstat 2>/dev/null) |
  awk 'BEGIN { add=0; del=0 } { if ($1 != "-" && $1 != "") add += $1; if ($2 != "-" && $2 != "") del += $2 } END { printf "add=%d del=%d", add, del }'
)
dirty=0
if [ -n "$status" ]; then dirty=1; fi
printf "dirty=%s %s\n" "$dirty" "$stats"
`.trim();

    const result = await pi.exec("bash", ["-lc", command], { signal: ctx.signal, timeout: 5000 });
    if (result.code !== 0) return;

    const output = `${result.stdout}\n${result.stderr}`;
    const dirtyMatch = output.match(/dirty=(\d+)/);
    const addMatch = output.match(/add=(\d+)/);
    const delMatch = output.match(/del=(\d+)/);

    workspace = {
      dirty: dirtyMatch?.[1] === "1",
      added: Number(addMatch?.[1] ?? 0),
      removed: Number(delMatch?.[1] ?? 0),
    };
  };

  const installFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose() {
          if (requestFooterRender) requestFooterRender = undefined;
          unsubscribeBranch();
        },
        invalidate() {},
        render(width: number): string[] {
          return renderStatusline(width, {
            ctx,
            theme,
            footerData,
            getThinkingLevel: () => pi.getThinkingLevel(),
            workspace,
            usageTotals,
            lastTps,
          });
        },
      };
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshUsageTotals(ctx);
    await refreshWorkspace(ctx);
    installFooter(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshUsageTotals(ctx);
    await refreshWorkspace(ctx);
    requestFooterRender?.();
  });

  pi.on("agent_start", () => {
    agentStartMs = Date.now();
  });

  pi.on("agent_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (agentStartMs === null) return;

    const elapsedMs = Date.now() - agentStartMs;
    agentStartMs = null;
    if (elapsedMs <= 0) return;

    let output = 0;
    for (const message of event.messages) {
      if (!isAssistantMessage(message)) continue;
      output += message.usage.output;
    }

    if (output <= 0) return;

    lastTps = output / (elapsedMs / 1000);
    requestFooterRender?.();
  });

  pi.on("model_select", async (_event, ctx) => {
    requestFooterRender?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    agentStartMs = null;
    lastTps = null;
    requestFooterRender = undefined;
    ctx.ui.setFooter(undefined);
  });
}
