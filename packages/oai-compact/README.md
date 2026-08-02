# pi-oai-compact

仅在 `openai-responses` API 下，用 OpenAI `POST /v1/responses/compact` 替换 Pi 内置 compact。其他 API/格式继续使用 Pi 原本的压缩逻辑。

## 安装

```bash
pnpm install
```

## 运行

```bash
pi -e ./src/index.ts
```

## 配置

推荐在 pi 的 `settings.json`（`~/.pi/agent/settings.json`）顶层加 `oaiCompact` 键：

```json
{
  "oaiCompact": {
    "model": "gpt-5.2",
    "promptThreshold": { "percent": 80 },
    "modelPromptThresholds": {
      "gpt-5.2": { "percent": 75 },
      "openai/gpt-5.2": { "tokens": 180000 },
      "gpt-*": { "percent": 85 },
      "gpt5.*": { "tokens": 200000 }
    }
  }
}
```

兼容旧配置：未找到 `oaiCompact` 键时，回退到独立配置文件 `oai-compact.json`（按 `$PI_CODING_AGENT_DIR/oai-compact.json`、`~/.pi/oai-compact.json` 顺序查找）。

- `model`：可选，compact 请求使用的模型。
- `promptThreshold`：可选，agent 回复结束后检查当前上下文，达到阈值时提示是否执行 `/compact`。未配置且未命中 `modelPromptThresholds` 时默认为 `80`（80%）。
  - 可以写数字，表示百分比：`"promptThreshold": 80`
  - 也可以写对象：`{ "percent": 80 }`、`{ "tokens": 180000 }`，或二者同时配置（任一达到即提示）
- `modelPromptThresholds`：可选，按当前会话模型覆盖提示阈值；key 支持模型 `id`（如 `gpt-5.2`）或 `provider/id`（如 `openai/gpt-5.2`），也支持 `*` 通配符（如 `gpt-*`、`gpt5.*`、`openai/gpt-*`）。精确匹配优先于通配符；多个通配符命中时按配置文件中的顺序使用第一个。

native compact 只在当前会话模型是 `openai-responses` 时生效，并复用当前模型的：

- `baseUrl`（自动拼成 `/responses/compact`）
- API key / headers（从 Pi 当前模型认证配置读取）

compact 请求里的 `model` 优先使用 `oai-compact.json` 的 `model`；未配置时回退到当前会话模型的 `id`。

`promptThreshold` / `modelPromptThresholds` 不限制 API 类型：只要 Pi 能给出当前上下文用量，就会在 `agent_end` 后提示；确认压缩后仍会走本插件的 native compact 逻辑（仅 `openai-responses`）或 Pi 默认 compact。

## 行为

- 监听 `agent_end`，按 `promptThreshold` / `modelPromptThresholds` 检查上下文阈值并提示用户压缩
- 只处理 `ctx.model.api === "openai-responses"` 的 native compact 会话
- 监听 `session_before_compact`
- 调用 OpenAI `responses/compact`，携带与 Pi 正常请求相同的 `prompt_cache_key`（sessionId）且 input 前缀包含 system prompt，命中正常请求已写入的 prompt cache
- 将返回的原生 compact window 存进 compaction details
- 监听 `before_provider_request`
- 后续 Responses 请求改写为原生 compact replay，保留 Pi 自带的同 key 命中 compact 写入的缓存，只需处理压缩窗口之后的增量内容
- 非 `openai-responses` API 不调用该接口，直接回退/沿用 Pi 默认 compact
- 失败时回退到 Pi 默认 compact

## 兼容

- `openai-responses` / Responses 格式请求：`input`（使用 OpenAI native compact replay）
- `Chat Completions` / `openai-completions` 格式请求：不适配，使用 Pi 原本 compact 逻辑
- `Anthropic Messages` 格式请求：不适配，使用 Pi 原本 compact 逻辑
