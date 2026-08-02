export const PROMPT_PREFIX = "❯ ";
export const BASH_PROMPT_PREFIX = "! ";
// 去掉常见终端控制序列，避免边框行判断被 OSC/APC 标记干扰。
// - CSI: \x1b[...m 等样式序列
// - OSC: \x1b]...BEL / \x1b]...ST（例如 OSC 133）
// - APC: \x1b_...BEL / \x1b_...ST（例如 pi-tui 的 cursor marker）
export const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

// 用户消息顶部保留一行空白，和上一条 assistant 消息拉开距离。
export const USER_MESSAGE_TOP_SPACING = 1;
