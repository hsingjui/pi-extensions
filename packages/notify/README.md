# pi-notify

当 Pi 结束运行（正常完成或异常停止）并等待用户输入时，发送**系统通知**。

按平台分发，无权限配置、无需安装任何东西：

| 平台 | 实现 |
|---|---|
| **WSL** | 插件内实现：调系统自带 `powershell.exe` 弹 Windows 原生 toast（不依赖任何第三方脚本/模块） |
| **macOS** | `osascript` `display notification` |
| **其他终端** | OSC 9 终端通知协议（ghostty / iTerm2 支持；不支持的终端忽略序列，无副作用） |

## 行为

- **短任务不通知**：运行不足 10 秒不打扰（`PI_NOTIFY_MIN_SECONDS` 可调）
- **可取消**：通知延迟 3 秒弹出（`PI_NOTIFY_DELAY_MS` 可调），期间回到终端、按任意键或发起新 run 即取消
- **正常完成** → 通知标题固定为 `PI_NOTIFY_TITLE`（默认 `Pi`），正文含项目名、状态、耗时和最后回答摘要（单行 ≤80 字）
- **运行异常**（API 错误、重试耗尽等）→ 通知「运行异常」，正文含错误信息
- **工具执行出错**（bash 失败等）→ 状态显示「⚠️ `<工具名>` 出错」
- **用户主动取消**（Esc）→ 不通知（人就在终端前）

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_NOTIFY_MIN_SECONDS` | `10` | 最小运行秒数才通知 |
| `PI_NOTIFY_DELAY_MS` | `3000` | 通知延迟毫秒，期间可被取消（`0`=即时弹出） |
| `PI_NOTIFY_TITLE` | `Pi` | 通知标题 |
| `PI_NOTIFY_DISABLE` | *(空)* | `1` 禁用 |

图标内置在插件包内（`extensions/pi-notify-icon.png`，toast 左上角 appLogoOverride）；
运行时经 base64 传给 PowerShell 写入 `%TEMP%` 再引用，toast 只认 Windows 本地路径。

## 备注

- WSL 实现自包含：图标内置在插件包（base64 写入 `%TEMP%` 后以 `file:///` 引用），中文经 `-EncodedCommand`（UTF-16LE base64）传递不乱码，AppId 用 Windows PowerShell 的已注册 AUMID（所有 Windows 自带，保证 toast 不被系统静默丢弃）；仅依赖 Windows 自带的 `powershell.exe`，任何用户安装即用
- macOS 实现通过 `osascript`，通知显示在系统通知中心
