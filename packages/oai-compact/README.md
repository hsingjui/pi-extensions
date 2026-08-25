# pi-oai-compact

已合并 pi-handoff：安装本扩展即同时提供 `/handoff` 命令（总结当前上下文，确认后新建 session 交接给 agent），并常驻注册 `create_handoff_context` 工具（工具定义稳定出现在每次请求中以保证提示词缓存命中，模型可在对话中主动调用生成交接摘要）。

仅在 `openai-responses` API 下使用 OpenAI remote compaction v2（`POST /v1/responses` + `compaction_trigger`）；非 `openai-responses` API 默认禁用 Pi 内置 compact（可通过 `nonResponses` 开关放行或改用 handoff 摘要，见配置）。

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
    "promptThreshold": { "percent": 80 },
    "modelPromptThresholds": {
      "gpt-5.2": { "percent": 75 },
      "openai/gpt-5.2": { "tokens": 180000 },
      "gpt-*": { "percent": 85 },
      "gpt5.*": { "tokens": 200000 }
    },
    "nonResponses": "handoff"
  }
}
```

兼容旧配置：未找到 `oaiCompact` 键时，回退到独立配置文件 `oai-compact.json`（按 `$PI_CODING_AGENT_DIR/oai-compact.json`、`~/.pi/oai-compact.json` 顺序查找）。

- `promptThreshold`：可选，仅在 `openai-responses` 下于每次模型响应及其工具结果完成后检查当前上下文，达到阈值时自动执行 native compact。未配置且未命中 `modelPromptThresholds` 时默认为 `80`（80%）。
  - 可以写数字，表示百分比：`"promptThreshold": 80`
  - 也可以写对象：`{ "percent": 80 }`、`{ "tokens": 180000 }`，或二者同时配置（任一达到即提示）
- `modelPromptThresholds`：可选，按当前会话模型覆盖提示阈值；key 支持模型 `id`（如 `gpt-5.2`）或 `provider/id`（如 `openai/gpt-5.2`），也支持 `*` 通配符（如 `gpt-*`、`gpt5.*`、`openai/gpt-*`）。精确匹配优先于通配符；多个通配符命中时按配置文件中的顺序使用第一个。
- `nonResponses`：可选，非 `openai-responses` API（Chat Completions、Anthropic Messages、Gemini 等）在压缩触发时的策略：
  - `"off"`（默认）：取消压缩，保持当前行为（不压缩，需手动切会话/模型）
  - `"pi"`：放行 Pi 内置 compact（同会话摘要式截断）
  - `"handoff"`：用 pi-handoff 的交接提取逻辑生成摘要代替内置压缩（同会话，生成失败则取消压缩、不压缩）

native compact 只在当前会话模型是 `openai-responses` 时生效，并复用当前模型的：

- 最近一次 normal 请求的完整 Responses payload（包括 `model`、`input`、`tools`、`reasoning`、`text`、`service_tier` 和 prompt cache 配置）
- `baseUrl`（自动定位 `/responses`）
- API key / headers（从 Pi 当前模型认证配置读取）

compact 请求不再单独配置 `model`，只在完整 normal payload 的 `input` 末尾追加 `compaction_trigger`。

`promptThreshold` / `modelPromptThresholds` 仅用于 `openai-responses`：每次模型响应及其工具结果完成（`turn_end`）后检查阈值并触发 native compact。Native compact 失败时取消压缩；其他 API 的压缩请求也会直接取消，均不回退 Pi 默认 compact。

## 完整前缀缓存测试

下面的脚本先发送一次完整 normal Responses 请求写入缓存，再发送完整相同 payload 并仅在 `input` 末尾追加 `compaction_trigger`。脚本会断言两次请求的所有顶层字段和完整 input 前缀一致，并输出两次请求的 `input_tokens`、`cached_tokens`。默认使用约 260,000 字符的稳定前缀（`gpt-5.6-luna` 实测约 52k input tokens），共产生 2 次计费请求。

```bash
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-5.6 \
pnpm --filter pi-oai-compact test:prefix-cache
```

命中时输出 `Cache result: HIT`。未命中但 payload 断言通过时会输出警告，可重复执行以排除缓存路由或过期；需要让 cache miss 返回非零退出码时加 `STRICT_CACHE_HIT=1`。可用 `OPENAI_CACHE_PREFIX_CHARS` 调整前缀长度，或用 `OPENAI_SERVICE_TIER`、`OPENAI_REASONING_EFFORT` 匹配实际 normal 请求。

## API 诊断

使用真实 remote compaction v2 端点依次比较基础请求、`prompt_cache_key` 和 `prompt_cache_retention`。每组连续发送两次相同长前缀，并输出两次 `cached_tokens`；脚本不会打印 API key。`all` 默认发送 6 次计费请求，也可指定单个 variant：`base`、`key` 或 `retention`（各发送 2 次）。

```bash
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_API_KEY=sk-... \
OPENAI_MODEL=gpt-5.2 \
pnpm --filter pi-oai-compact test:api -- all
```

## 行为

- 仅在 `openai-responses` 下监听 `turn_end` 的实际效果：本轮模型响应及其工具结果全部进入上下文后、下一次模型请求前检查阈值并触发 native compact
- 只处理 `ctx.model.api === "openai-responses"` 的 native compact 会话
- 监听 `session_before_compact`
- 调用 OpenAI remote compaction v2：复用最近一次 normal 请求的完整 payload，不按 Pi 的 `messagesToSummarize` 裁剪，只在 `input` 末尾追加 `compaction_trigger`
- 网络错误、`429` 或 `5xx` 最多重试 3 次，按 `1s`、`2s`、`4s` 退避；其他错误立即取消压缩
- 将返回的原生 compact window 存进 compaction details
- 监听 `before_provider_request`
- 后续 Responses 请求改写为原生 compact replay，保留 Pi 自带的同 key 命中 compact 写入的缓存，只需处理压缩窗口之后的增量内容
- 非 `openai-responses` API：按 `nonResponses` 配置处理（见配置）；`"handoff"` 模式下生成失败、认证不可用或被终止时取消整次压缩，不回退 Pi 默认 compact
- `openai-responses` 的 native compact 失败、认证不可用或被终止时取消整次压缩，不回退 Pi 默认 compact

## 兼容

- `openai-responses` / Responses 格式请求：`input`（使用 OpenAI native compact replay，失败时不回退默认压缩）
- `Chat Completions` / `openai-completions` 格式请求：`nonResponses: "pi"` 时使用 Pi 内置压缩；`"handoff"` 时使用 pi-handoff 交接摘要压缩（同一会话）；默认 `"off"` 不压缩
- `Anthropic Messages` 格式请求：同上

非 `openai-responses` 会话默认（`nonResponses: "off"`）达到上下文上限后无法压缩，需要切换会话或模型；配置 `"pi"` 或 `"handoff"` 后可自动压缩。
