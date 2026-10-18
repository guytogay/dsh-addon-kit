# computer-use-cua-driver-native（索引条目）

**源码不在这里。** 这个目录只是索引：真正的源码与 81 项单测在

👉 [`guytogay/computer-use-upgrade`](https://github.com/guytogay/computer-use-upgrade) →
`plugins/dsh-computer-use/`

为什么只放索引：同一份代码在两个仓各存一份，早晚漂移（2026-10-19 已经因为两份代码需要 rebase 一次）。
本 kit 的角色是**分发/索引**（像 Homebrew tap、MCP registry），指向源码，不复制源码。

## 它是什么

DSH 宿主侧插件（macOS，Cua Driver 原生 SDK），在桌面工具之上加了四条契约能力：
首次接入探针 `probe_app`、按**变化像素占比**的静止判据（实测：转圈 0.30%、有焦点光标 0.0145%）、
路由判定 `routeVerdict`、每窗口租约。上游包：
`@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.2.1-alpha.2`（本副本不推上游）。

## 免插件的等价物

任何 MCP 客户端都能用同一套判据：`computer-use-upgrade/mcp/probe-server.mjs`（独立 MCP server）
+ `verify/probe-app.mjs`（CLI）。
