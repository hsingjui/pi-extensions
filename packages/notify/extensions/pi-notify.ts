/**
 * Pi Notify Extension
 *
 * 当 Pi 结束运行（完成或异常停止）并等待用户输入时，发送系统通知。
 * 借鉴 https://github.com/wuyaos/pi-packages/tree/master/pi-notify 的设计：
 * - 运行时长 ≥ PI_NOTIFY_MIN_SECONDS（默认 10s）才通知，短任务不打扰
 * - 通知延迟 PI_NOTIFY_DELAY_MS（默认 3s）弹出，期间用户任何活动（输入/按键/新 run）即取消
 * - 工具执行出错时状态显示「⚠️ <工具名> 出错」
 * - 标题：会话名 → 项目目录名 → PI_NOTIFY_TITLE
 *
 * 实现：OSC 9 终端通知协议（\x1b]9;...\x1b\），由终端 App（ghostty/iTerm2 等）自己弹出通知，
 * 无子进程、无权限问题、无需安装任何东西。
 *
 * 配置（环境变量）：
 *   PI_NOTIFY_MIN_SECONDS — 最小运行秒数才通知（默认 10）
 *   PI_NOTIFY_DELAY_MS    — 通知延迟毫秒，期间可被取消（默认 3000；0=即时）
 *   PI_NOTIFY_TITLE       — 通知标题兜底（默认 "pi"）
 *   PI_NOTIFY_DISABLE     — "1" 禁用
 */

import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 提取 assistant 消息的文本内容（text 块拼接） */
function assistantText(message: AgentEndEvent["messages"][number] | undefined): string {
	if (!message || message.role !== "assistant") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/** 去掉 markdown 残留符号，压成单行并截断，通知正文才看得全 */
function summarize(text: string, max = 80): string {
	const oneLine = text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
	return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** 终端通知（OSC 9，ghostty/iTerm2 等支持）；非交互终端跳过，避免污染管道输出 */
function sendSystemNotification(title: string, body: string): void {
	if (!process.stdout.isTTY) return;
	// 去掉可能干扰终端协议的控制字符
	const text = `${title}${body ? ` - ${body}` : ""}`.replace(/[\x1b\x07\x9c]/g, "");
	process.stdout.write(`\x1b]9;${text}\x1b\\`);
}

export default function (pi: ExtensionAPI) {
	const disabled = process.env.PI_NOTIFY_DISABLE === "1";
	const minSeconds = parseInt(process.env.PI_NOTIFY_MIN_SECONDS ?? "10", 10);
	const delayMs = parseInt(process.env.PI_NOTIFY_DELAY_MS ?? "3000", 10);
	const defaultTitle = process.env.PI_NOTIFY_TITLE ?? "pi";

	let runStart = 0; // 本轮 agent_start 时间戳；0=没有进行中的 run
	let lastRun: { status: "done" | "error" | "aborted"; body: string } | undefined;
	let lastErrorTool: string | null = null; // 本轮第一个执行出错的工具名

	// ── 断路器：延迟弹通知，期间用户任何活动即取消（用户已回屏，不打扰）──
	let pendingTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingNotify: { title: string; body: string } | null = null;

	function cancelPending(): void {
		if (pendingTimer) clearTimeout(pendingTimer);
		pendingTimer = null;
		pendingNotify = null;
	}

	function scheduleNotify(title: string, body: string): void {
		cancelPending();
		if (delayMs > 0) {
			pendingNotify = { title, body };
			pendingTimer = setTimeout(() => {
				const n = pendingNotify;
				pendingNotify = null;
				pendingTimer = null;
				if (n) sendSystemNotification(n.title, n.body);
			}, delayMs);
			pendingTimer.unref();
		} else {
			sendSystemNotification(title, body);
		}
	}

	pi.on("agent_start", () => {
		cancelPending();
		runStart = Date.now();
		lastErrorTool = null;
	});

	// 用户发消息 / 新 run 开始 → 取消 pending（用户已回屏）
	pi.on("input", () => cancelPending());
	pi.on("before_agent_start", () => cancelPending());

	// 跟踪本轮工具执行错误（bash 失败、文件不存在等）
	pi.on("tool_execution_end", (event) => {
		if (event.isError && !lastErrorTool) lastErrorTool = event.toolName;
	});

	// agent_end 记录本次运行结果；agent_settled 时 Pi 不会再自动继续，此时才通知
	pi.on("agent_end", (event) => {
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		const stopReason = (lastAssistant as { stopReason?: string } | undefined)?.stopReason;
		const errorMessage = (lastAssistant as { errorMessage?: string } | undefined)?.errorMessage;
		if (stopReason === "error") {
			lastRun = { status: "error", body: `运行异常：${errorMessage ?? "未知错误"}` };
		} else if (stopReason === "aborted") {
			// 用户主动取消，人就在终端前，不打扰
			lastRun = { status: "aborted", body: "" };
		} else if (!lastAssistant || stopReason !== "stop") {
			// 没有完整的 assistant 响应（被 reload/中断打断等）→ 不算完成，不通知
			lastRun = undefined;
		} else {
			lastRun = { status: "done", body: summarize(assistantText(lastAssistant)) || "（无文本输出）" };
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (disabled || !ctx.isIdle() || !runStart) return;
		const elapsed = (Date.now() - runStart) / 1000;
		runStart = 0;
		if (elapsed < minSeconds) return; // 短任务不打扰
		const run = lastRun;
		lastRun = undefined;
		if (!run || run.status === "aborted") return;

		const projectName = ctx.cwd.split(/[/\\]/).filter(Boolean).pop() || defaultTitle;
		const title = ctx.sessionManager.getSessionName() ?? projectName;
		const mins = Math.floor(elapsed / 60);
		const dur = mins > 0 ? `${mins}m${Math.floor(elapsed % 60)}s` : `${Math.floor(elapsed)}s`;
		const status = run?.status === "error" ? "运行异常" : lastErrorTool ? `⚠️ ${lastErrorTool} 出错` : "完成";
		const body = `${projectName} · ${status} (${dur})\n${run?.body ?? "（无文本输出）"}`;
		scheduleNotify(title, body);
	});

	// 终端任何按键 → 取消 pending（用户已回屏）
	pi.on("session_start", (_e, ctx) => {
		ctx.ui.onTerminalInput(() => {
			cancelPending();
			return undefined;
		});
	});
	pi.on("session_shutdown", () => cancelPending());

}
