# pi-extensions

Pi Coding Agent 个人扩展仓库。

## 包含

| 包 | 说明 |
|---|---|
| `packages/cc-ui` | TUI 界面增强（含 12 个精选 themes：6 dark + 6 light） |
| `packages/handoff` | 任务交接扩展 |
| `packages/mystatusline` | 自定义状态栏 |
| `packages/notify` | 任务结束等待输入时的终端系统通知 |
| `packages/oai-compact` | 压缩优化 |
| `packages/tool-opt` | 工具优化（图片处理等） |

## 安装

整体安装：

```bash
pi install git:github.com/hsingjui/pi-extensions
```

用 `pi config` 交互式勾选要启用的扩展（连带 skills/themes）。

## 开发

```bash
pnpm install        # 安装子包依赖
pnpm check          # 全部子包类型检查
```

新增扩展：把目录放进 `packages/`，确保有 `extensions/<name>.ts` 入口，然后在根 `package.json` 的 `pi.extensions` 里加一行。

## 致谢与声明

本仓库各扩展参考了大量开源社区项目（如 Claude Code / CC 风格 statusline 等）的实现思路与代码，在此一并致谢。

本仓库**仅供个人自用**，不提供任何保证；若需分发或商用，请注意遵守所参考项目的开源许可证要求。
