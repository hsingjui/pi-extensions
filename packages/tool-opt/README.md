# pi-tool-opt

Pi 工具优化扩展。

## 功能

- **read 工具增强**：图片方向/缩放等处理
- **bash 默认超时**：模型未传 `timeout` 时，默认 30 秒；显式传入时以模型为准

## 目录

- `src/`：扩展源码
- `extensions/`：包入口
- `.pi/extensions/`：项目内自动发现入口
- `.pi/settings.json`：项目级 pi 配置

## 开始

```bash
pnpm install
pnpm check
```
