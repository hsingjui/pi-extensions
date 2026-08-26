# pi-custom-response-ws

注册自定义 API 类型 `openai-responses-ws`。供应商、认证和模型仍完全由 Pi 的 `~/.pi/agent/models.json` 管理；扩展只把 Pi 内置 `openai-responses` 的 HTTP 传输替换为 Responses WebSocket。

## 配置

在已有 Responses provider 中把 `api` 改为 `openai-responses-ws`：

```json
{
  "providers": {
    "ccs": {
      "api": "openai-responses-ws",
      "apiKey": "chen",
      "baseUrl": "http://127.0.0.1:5000",
      "models": [
        {
          "id": "gpt-5.6-terra",
          "name": "gpt-5.6-terra",
          "contextWindow": 272000,
          "maxTokens": 128000,
          "input": ["text", "image"],
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": null,
            "low": null,
            "medium": null,
            "high": "high",
            "xhigh": null,
            "max": "max"
          },
          "cost": {
            "cacheRead": 0.2,
            "cacheWrite": 2.5,
            "input": 2,
            "output": 12
          }
        }
      ]
    }
  }
}
```

`baseUrl` 规则与 `openai-responses` 相同。Pi 内置客户端请求 `${baseUrl}/responses`，扩展会自动转换为 `ws://` 或 `wss://`。

与 `pi-oai-compact` 同时加载时，扩展沿用 `~/.pi/agent/settings.json` 的 `oaiCompact.promptThreshold` 和 `modelPromptThresholds` 配置，通过每次 `response.create` 的 `context_management` 启用服务端压缩，全程不调用 HTTP `/responses/compact`。未配置时阈值仍为模型 `contextWindow` 的 80%。

## 协议

WebSocket 请求头只发送：

- `Authorization: Bearer <apiKey>`
- `User-Agent: pi (<platform> <release>; <arch>)`
- `OpenAI-Beta: responses_websockets=2026-02-06`
- `x-client-request-id`
- `session-id`

不会转发 OpenAI SDK 的 `x-stainless-*` 等通用 headers，也不会发送 Codex OAuth 专属的 `chatgpt-account-id` 和 `originator`。

每轮发送 Codex 风格的 `response.create`：

```json
{
  "type": "response.create",
  "model": "gpt-5.6-luna",
  "store": false,
  "stream": true,
  "context_management": [
    { "type": "compaction", "compact_threshold": 200000 }
  ],
  "instructions": "...",
  "input": [],
  "text": { "verbosity": "low" },
  "include": ["reasoning.encrypted_content"],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

与 Pi 内置 Codex 一样，WS payload 不发送 `max_output_tokens`、`prompt_cache_retention` 和 `prompt_cache_options`。普通 Responses input 中的首个 system/developer message 会提升为 `instructions`。

上游需要返回 OpenAI Responses stream events，例如 `response.created`、`response.output_text.delta` 和 `response.completed`。

Pi 的 transport 设置继续生效：

- `auto`：优先 WebSocket；连接或首个事件到达前失败时最多重连 3 次，仍失败才回退 SSE。
- `websocket` / `websocket-cached`：只使用 WebSocket。
- `sse`：直接使用 Pi 内置 SSE。

连接按 Pi session 复用，空闲 5 分钟回收，并在 55 分钟后主动换连接。`auto` 和 `websocket-cached` 会使用 `previous_response_id`，后续请求只发送新增 input；服务端生成的 `compaction` item 保留在该响应链中，不会被误当作 Pi 的本地 replay input。若服务端返回 `previous_response_not_found`，会自动重连并用完整上下文重试一次。连接上限错误同样重试一次。

扩展复用 Pi 内置 Responses 的消息、工具调用、reasoning、usage 和事件解析，不实现 Codex 专属 OAuth、账号 header、zstd SSE 压缩和 ChatGPT 计费逻辑。

参考 OpenAI 官方 [WebSocket Mode](https://developers.openai.com/api/docs/guides/websocket-mode) 和 [Responses WebSocket events](https://developers.openai.com/api/reference/resources/beta/subresources/responses/websocket-events)。官方当前说明 WebSocket 中 `stream` 是隐式字段、可省略；本扩展为与 Pi 内置 Codex 请求保持一致而继续发送 `stream: true`。官方新增的 `stream_id` 多路复用未启用，连接仍保持 Pi Codex 的单 in-flight 行为。
