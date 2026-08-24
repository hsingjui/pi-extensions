# pi-handoff

任务交接扩展：提供 `create_handoff_context` 工具，从当前对话中提取关键上下文（已完成工作、重要指令、待办）并列出相关文件，生成交接摘要供另一个 agent 继续会话。

- `/handoff [请求]`：总结当前上下文，确认内容后直接创建新 session 并发送给 agent
- `generateHandoffContext`（导出）：无 UI 依赖的交接摘要生成函数，供其他扩展复用（如 pi-oai-compact 的 `nonResponses: "handoff"` 用它代替内置压缩）