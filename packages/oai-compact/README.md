# pi-oai-compact

同时接管 `openai-responses` 和 `openai-responses-ws` 的 OpenAI native compaction。HTTP/SSE 通过 Responses compact 请求获取 compact window；WS 由本插件建立独立连接并发送 `compaction_trigger`。两者都把服务端真实结果保存为 Pi 正式 `compaction` entry；其他 API 由 `pi-handoff` 负责策略控制。

## 配置

推荐在 `~/.pi/agent/settings.json` 中配置：

```json
{
  "oaiCompact": {
    "promptThreshold": { "percent": 80 },
    "modelPromptThresholds": {
      "gpt-5.2": { "percent": 75 },
      "openai/gpt-5.2": { "tokens": 180000 },
      "gpt-*": { "percent": 85 }
    }
  },
  "handoff": {
    "nonResponses": "handoff",
    "promptThreshold": { "percent": 80 }
  }
}
```

- `oaiCompact.promptThreshold` 和 `modelPromptThresholds` 同时控制 `openai-responses` 的 standalone native compact 与 `openai-responses-ws` 的服务端压缩；默认阈值为 `80%`。
- `handoff` 配置由 `pi-handoff` 读取，负责其他 API 的压缩策略和阈值。
- 未找到 `handoff` 配置时，兼容从旧的 `oaiCompact.nonResponses` 和 `oai-compact.json` 读取非 Responses 策略。
- 旧配置文件 `oai-compact.json` 仍可作为 `oaiCompact` 配置回退来源。

## 行为

- `openai-responses` 和 `openai-responses-ws`：监听每个 `turn_end`，达到阈值后自动触发 native compact。
- `openai-responses-ws` 由本插件从当前 session 重建完整 input，恢复最近一次普通 WS 请求的非 input 字段和 `prompt_cache_key`，再建立独立 WS 连接发送 `compaction_trigger`；压缩请求与普通请求共享完整 prompt 前缀，不依赖旧对话连接仍然存活。
- `session_before_compact` 返回正式 extension compaction result，由 Pi 写入本地 `compaction` entry、显示原生成功 UI并重建上下文。
- 后续 Responses 请求统一改写为 native compact window 加压缩后的增量历史，支持断线、重启和 session 恢复。
- 自动压缩完成后发送一次 `continue`；手动 WS `/compact` 在正式 `session_compact` 后同样续接一次。
- native compact 失败、认证不可用或被中止时取消本次压缩，不回退 Pi 默认 compact。
