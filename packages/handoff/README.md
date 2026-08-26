# pi-handoff

任务交接扩展：注册 `create_handoff_context` 工具，提供 `/handoff [请求]` 命令，并在非 Responses 会话达到阈值时自动触发交接流程。

## 配置

推荐在 `~/.pi/agent/settings.json` 中配置：

```json
{
  "handoff": {
    "nonResponses": "handoff",
    "promptThreshold": { "percent": 80 },
    "modelPromptThresholds": {
      "claude-*": { "percent": 75 },
      "google/gemini-*": { "tokens": 180000 }
    }
  }
}
```

- `nonResponses: "off"`（默认）：取消其他 API 的 Pi 内置压缩。
- `nonResponses: "pi"`：放行 Pi 内置压缩。
- `nonResponses: "handoff"`：取消 Pi 内置压缩，改为上下文达到阈值时自动触发 `/handoff` 交接。
- `promptThreshold` 和 `modelPromptThresholds` 控制自动交接的触发比例；未配置时默认 `80%`。

## 行为

- 常驻注册 `create_handoff_context`，保持工具定义稳定并支持模型主动生成交接摘要。
- `/handoff` 执行时先停止当前 agent，再生成、编辑并确认摘要，最后创建新 session 继续工作。
- 非 Responses 会话达到配置阈值时自动执行 `/handoff`：自动生成摘要后等待用户确认，确认后新开 session 并发送摘要；`openai-responses` 使用 standalone native compact，`openai-responses-ws` 使用 WS 服务端压缩。
- handoff 生成失败或被用户取消时本次交接中止，不回退 Pi 默认压缩。

`generateHandoffContext` 也会导出，供其他扩展生成交接摘要。
