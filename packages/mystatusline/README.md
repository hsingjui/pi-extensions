# pi-mystatusline

一个参考 Claude/CC 风格 statusline 脚本视觉布局的 pi footer 扩展，实现集中放在 `extensions/` 下。

## 目录结构

- `extensions/pi-mystatusline.ts`：扩展主入口
- `extensions/statusline.ts`：statusline 渲染逻辑

## 当前效果

当前会渲染为两行 footer：

第一行：
- `◆ 模型`
- 上下文彩条 + 百分比 + `(已用/总量)`
- `⚡` thinking 指示
- `$cost`
- 已运行时间
- `Ready / Working`

第二行：
- `⎇ 分支*`
- `+新增/-删除`
- 当前目录

## 说明

- 参考 Claude/CC 风格 statusline 视觉布局
- pi 扩展 API 没有直接暴露 rate limit，所以这版先不显示 `5h/7d` 限流信息
- 改完代码后执行 `/reload` 即可生效
