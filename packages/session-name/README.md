# pi-session-name

一个 Pi 扩展：在会话收到第一条用户消息时，用当前配置的模型自动为会话命名，名称简洁，且语言与首条用户消息一致。

## 功能

- 监听第一条用户消息，通过**非流式**请求调用命名模型生成标题（复用 Pi 的模型/baseUrl/API key，兼容 OpenAI-completions / responses / anthropic-messages 及带 `data` 外层包装的网关）。
- 标题简洁：中文 4–10 字，其他语言 2–6 词；只返回标题本身。
- 语言一致：自动识别首条用户消息是否为中文（CJK 检测），并据此要求模型用对应语言输出。
- 失败重试：若第一条消息生成失败，暂存首条用户消息；等 agent 回复后，用「首条用户消息 + agent 回复」两条消息再尝试一次。重试仍失败则放弃，不无限重试。
- 已有名字的会话不再重命名（用户手动命名或已命名均不覆盖）。
- Herdr tab 同步：当在 Herdr 中运行（`HERDR_ENV=1`）时，把会话名同步为当前 Herdr tab 的标签。覆盖三种时机：启动/恢复已有名字的会话、自动命名完成、用户手动 `/name` 修改。

## 使用

将该扩展加入你的扩展清单即可：

```json
{
  "pi": {
    "extensions": [
      "packages/session-name/extensions/pi-session-name.ts"
    ]
  }
}
```

默认复用 Pi 当前工作模型。可配置命名专用模型（推荐用便宜轻量模型）：在 pi `settings.json` 的 `sessionName` 键，或独立配置文件 `session-name.json` 中设置 `model`，支持 `provider/id` 或纯 `id`：

```jsonc
// .pi/settings.json 为例
{
  "sessionName": {
    "model": "anthropic/claude-3-5-haiku"
  }
}
```

```jsonc
// 或独立文件 session-name.json
{
  "model": "grok/grok-4-fast-mini"
}
```

API key 与 baseUrl 仍复用 Pi 自身的模型注册表，无需单独配置。若配置的模型在 Pi 中不存在，会自动回退到当前工作模型。

## 说明

- 仅当会话尚无名字时生效；改名通过 `pi.setSessionName()` 完成。
- 命名请求有 10 秒超时；失败会在 TUI 中提示。
- 并发保护：同一时刻只允许一次命名请求，避免重复触发。
- Herdr 集成说明：依赖 `herdr` 在 PATH 中，并在 Herdr 环境下运行（Herdr 会注入 `HERDR_ENV=1` 与 `HERDR_TAB_ID`）；非 Herdr 环境自动跳过。

## 开发

```sh
pnpm check        # 类型检查
```
