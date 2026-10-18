# desktop MCP — Windows 桌面执行层（自研，零付费依赖）

给任意 MCP 客户端提供"Windows 桌面 computer use"：物理键鼠 + UIA（无障碍树）+ **动作契约层**。
视觉决策由调用方模型完成（本机 DSH 用 DeepSeek 视觉模型，零 OpenAI/Codex 成本）。

## 工具（25 个）

### 物理输入与窗口（11）
`desktop_screenshot`（区域/窗口级）· `desktop_screenshot_window` · `desktop_click` · `desktop_move` ·
`desktop_type`（中文）· `desktop_key` · `desktop_hotkey` · `desktop_scroll` · `desktop_list_windows` ·
`desktop_activate_window` · `desktop_get_cursor`

### UIA（不动物理鼠标、零图片 token，7）
`desktop_uia_tree` · `desktop_uia_find` · `desktop_uia_click` · `desktop_uia_setvalue` ·
`desktop_uia_getvalue` · `desktop_uia_read_text` · `desktop_uia_scroll`

### 动作契约（7）——回答"这一下到底发生了没有"
| 工具 | 作用 |
|---|---|
| `desktop_observe` | 一帧证据：元素数、结构 revision、像素粗签名 `frame_id`、精确 `pixel_id` |
| `desktop_diff_window` | 相对上次观察变了什么（结构 + 文本 + 像素差） |
| `desktop_wait_stable` | 测出来的静止（元素树 + 像素双信号、≥2 采样），不是固定 sleep |
| `desktop_click_verified` | 点击 + 三态裁决；`expect_text` 必须"前无后有"；`screenshot_id` 绑帧，陈旧帧拒绝 |
| `desktop_type_verified` | 输入 + 回读裁决；通道 ValuePattern → TextPattern → 元素树 |
| `desktop_probe_app` | 首次接入未知 app：三步探针 → 路由卡（`uia-name`/`keyboard`/`dom`/`vision`） |
| `desktop_lease_status` | 谁占着哪个窗口（多会话单边防线） |

三态词汇：`ok`（已投递）≠ `verified`（有证据）。`unverifiable` / `not-met` 都**不得盲目重试**；
`invalid-expectation` 表示"期望本来就在屏上"，不算通过。契约层只加不改：原有 17 个工具行为一字未动。

## 依赖（仅 Windows + Python 3.11+）
- `pip install mcp mss`（本项目 venv：mcp 1.29.1 + mss 10.2.0；**不要装 mcp>=2**，FastMCP API 在 2.x 改名）
- UIA 走 Windows 内置 PowerShell 5.1 + .NET UIAutomationClient（零额外依赖）

## 环境变量（实例差异参数化，别写死本机值）
| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_CUA_LEASE_DIR` | `~/.dsh/computer-use/leases` | 窗口租约目录（测试可指到临时目录） |
| `DSH_CUA_SCREENSHOT_DIR` | `~/.dsh/mcp/desktop/screenshots` | 截图落盘目录 |
| `DSH_UIA_HELPER` | 与本文件同目录的 `uia_helper.ps1` | 便于在候选目录里原地测试 |

## 安装

### 通用（任意 MCP 客户端；stdio）
```bash
pip install "mcp>=1.28,<2" mss
# 启动命令：python <kit>/mcp/desktop/desktop_server.py
```

### DSH（本机，cordis patch）
把 `cordis-patch.yaml` 的片段加入 `~/.dsh/profiles/web/cordis.patch.yml`（或任意 profile patch）。
**改完驱动要重启 MCP 客户端**，工具列表才会更新。

### Claude Code / Cursor / Windsurf 等（JSON 配置）
```json
{ "mcpServers": { "desktop": {
  "command": "python",
  "args": ["</path/to/desktop_server.py>"] } } }
```

## 验证
```bash
python smoke_test.py                     # 冒烟：握手 + 一次 screenshot + list_windows
python verify/acceptance.py --module-dir <驱动目录> --json report.json
python verify/in_host_check.py --server <驱动目录>/desktop_server.py --json in-host.json
```
`verify/in_host_check.py` 走 **MCP 协议**（initialize → tools/list → tools/call）验真实工具面。
为什么要两条：进程内验收会把**宿主环境类**缺陷判成绿——本机就漏过一次"回复含中文在宿主内变空输出"，
独立进程里永远看不到。
`verify/acceptance.py` 是可重跑验收：PASS / FAIL / SKIP 三态，**SKIP 必须带理由且不算通过**，
有 FAIL 即非零退出。夹具是脚本自己启动并清理的窗口（计算器 + 自带 WinForms 对话框），
按"启动后新出现的窗口"识别，**不用标题子串认夹具**。
本机实测（Windows 11 / 1920×1080 / DPI 96）：**14 PASS / 0 FAIL / 1 SKIP**。

## 设计要点（来自实测，不是照抄）
- **静止与绑定用粗签名**：`frame_id` 是 48×27 采样亮度网格（每格 2×2 块均值）、32 级量化；
  静止判据另加**跳变格计数**（实测动画窗 49-58 格 / 静止窗 3-6 格，阈值 12）——只看平均差会把
  小目标移动平均掉（动画窗平均差仅 1.33，低于容差 1.5）。精确 sha256 只作辅助。
  实测精确哈希会被光标闪烁/桌面覆盖层打破（静窗 9 次采样 6.3 s 仍报在动），粗签名 2 次采样 1.1 s 收敛。
- **回读按通道分级**：ValuePattern → TextPattern → 元素树；三者都读不到时报 `unverifiable`，
  不能报 `not-met`（记事本的编辑器就是"读不到但确实写进去了"的例子）。
- **互斥交给内核，不交给"自我介绍"**：每个窗口一把命名互斥量 `Global\DSH-CUA-win-<hwnd>`。
  持有即有权动作，**不需要调用方报身份**；持有者进程死掉，内核立刻放行（无需等 TTL）。
  `~/.dsh/computer-use/leases/` 里的文件降级为**标签**（谁在动），`desktop_lease_status` 同时报标签与
  内核探测结果——标签还在而互斥量已空即 `stale_label`，以互斥量为准。
  为什么换：文件租约靠调用方自述身份，同一个 MCP 服务进程服务多个会话时它们看起来是同一个持有者，
  于是租约在会话之间形同虚设；互斥量不看身份，天然跨进程跨会话。它仍然约束不了不调用本工具的其他 agent。
- **UIA 输出与窗口身份**：helper 强制 UTF-8 输出——否则在宿主内包含中文的回复会变成空输出（实测
  `desktop_observe("设置")` → `{"ok":false,"msg":"empty output"}`，同一调用在交互式 shell 里正常）；
  窗口解析先按 Win32 标题找 hwnd 再 `FromHandle`，因为打包应用的 UIA 名与标题栏不一致。
- **空元素树不等于没变化**：UWP/XAML 窗口对 UIA2 不暴露树，空树的 revision 是常量（`e3b0c442…`），
  这类窗口只能用像素判据。
- **探针结论取决于你挑的元素**：`desktop_probe_app` 默认只读，点/打字必须显式 `confirm=True`，
  且探测字符会撤销并读回复核。

## 已知边界
- Electron/canvas 应用 UIA 树为空 → 走 Playwright/DOM 或视觉兜底
- Chromium 窗口默认不暴露 UIA 树（需强制无障碍才有）
- 需要交互式桌面会话（RDP/远程无桌面受限）
- `desktop_click_verified` 一次约 1.1-1.5 s（1 次前置观察 + ≥2 次采样）
