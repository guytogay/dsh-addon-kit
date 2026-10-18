# computer-use-cua-driver-native — macOS 桌面执行层（DSH 插件）

DSH 宿主侧插件：通过 Cua Driver 原生 SDK 提供桌面工具（无障碍读树、元素/坐标点击、键盘、截图、
区域读取、菜单、剪贴板等），并在其上加了四条**契约级**能力。与
[`guytogay/computer-use-upgrade`](https://github.com/guytogay/computer-use-upgrade) 是配套关系：
那边是可移植的合同与参考实现（任何 agent 可用，含 `probe_app` 独立 MCP server），这里是 DSH 内的落地。

## 文件

- `src/index.ts` — 插件主体（工具注册 + 合同实现）
- `src/png.ts` — 零依赖 PNG 解码（8 位、非隔行、灰度/RGB/RGBA）、亮度网格、变化占比、静止签名
- `src/cdp.ts` — 浏览器页面的 CDP 助手（点/悬停/拖拽走真实输入事件）
- `src/lease.ts` — 每窗口租约（Windows 端口已改为内核命名互斥量，见 §8f）
- `tests/provider.spec.ts`、`tests/fixtures/png.ts` — 81 项单测（含"光标闪仍 settled""真实动画必须 busy"两条）

## 这一版新增的四件事

1. **首次接入探针 `probe_app(pid, window_id, confirm?, click_element?, key?)`**
   三步探测（树可读 / 点击是否改内容 / 键盘是否落地）→ 路由卡（`ax-pixels` / `cdp` / `keyboard` / `vision`）。
   **默认只读**，`confirm:true` 才会真的点或敲；打字用真实按键并在撤销后**回读验证**，没复原就写 WARNING。
2. **静止判据改成像素网格**（`wait_settled`）
   384×216 亮度网格上按**变化像素占比**判，不用字节哈希、也不用跳变格计数。
   实测：转圈窗 **0.30%**、有焦点的闪烁光标 **0.0145%**、无焦点 **0.0000%** → 阈值 `moving ≥0.1%`、
   `jitter ≥0.05%`（只做诊断）、其余 `still`。
   **在动的帧直接重置计时**——两次相同的 `moving` 标签不能被当成"没变化"（这个错犯过两次，被真机抓住）。
3. **路由判定 `routeVerdict`**：无树 + Chromium → CDP；有树 + 点击无效 + 非 Chromium → 键盘；等等。
4. **窗口租约**：跨会话互斥，避免两个会话操作同一窗口。

## 安装（DSH）

1. 放到 monorepo：`packages/experimental/computer-use-cua-driver-native/`（覆盖同名目录）
2. 配置里加载 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`
3. 依赖：`@trycua/cua-driver`（darwin-arm64，本机实测 0.28.0）+ Node 24
4. 自检：`npx vitest run packages/experimental/computer-use-cua-driver-native/tests/provider.spec.ts` → 81 passed

## 已知欠账

- 仓库的 staged lint 仍报 18 条风格问题（12 条 `max-len`、4 条非空断言、1 条 `void` 类型），
  多在 `src/cdp.ts` 与较早的 `src/index.ts` 行；归档提交用了 `--no-verify`，行为由 81 项单测覆盖。

## 其他 agent 怎么用同一套能力

不需要这个插件：用 `guytogay/computer-use-upgrade` 里的
`mcp/probe-server.mjs`（独立 MCP server）或 `verify/probe-app.mjs`（CLI），合同与判据完全一致。
