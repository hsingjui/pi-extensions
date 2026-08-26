# pi-oai-compact

只接管 `openai-responses` API 的 OpenAI native compaction。`openai-responses-ws` 由 `pi-custom-response-ws` 通过 `context_management` 在 WebSocket 响应链内压缩；其他 API 由 `pi-handoff` 负责策略控制。

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

- `openai-responses`：监听 `turn_end`，达到阈值后自动触发 standalone native compact。
- `openai-responses-ws`：在 `before_provider_request` 注入同一配置计算出的 `context_management.compact_threshold`，由服务端在 WS 响应链内压缩。
- 监听 `session_before_compact`，仅处理当前模型为 `openai-responses` 的会话。
- 复用最近一次完整 Responses payload，并将 OpenAI compact window 保存到 session details。
- 监听 `before_provider_request`，将后续 Responses 请求改写为 native compact replay。
- native compact 失败、认证不可用或被中止时取消本次压缩，不回退 Pi 默认 compact。
