---
name: computer-use-strategy
description: 浏览器/桌面操作选择策略与省 token 规则，外加"动作是否真的发生"的三态契约（Windows 形状）。选 Chrome/Edge/Firefox 的 DOM、桌面 UIA、窗口截图、物理鼠标键盘之前先读这个；需要判定一次点击/输入是否生效、坐标是否过期、窗口是否静止、是否有别的会话在抢同一窗口，或要首次接入一个没见过的 app 时，也读这个。
---

# Computer Use 执行策略（省 token 阶梯 + 动作契约）

两条主线：**先用便宜的通道**（结构化优先，视觉兜底），**再问它到底发生了没有**（投递 ≠ 生效）。

## A. 通道阶梯（从省到贵）

### L1 浏览器 DOM（最优）— `mcp__chrome__*` / `mcp__edge__*` / `mcp__firefox__*`
- `browser_navigate` + `browser_find`（文本/正则直接定位，**不要**先全量 snapshot）
- `browser_snapshot` 只在需要整体结构时用；`browser_click` / `browser_type` / `browser_fill_form` /
  `browser_select_option` / `browser_press_key` 用元素 ref 精确定位
- `browser_take_screenshot` 只在需要验证视觉渲染时用（图片 ~600-1000 vision token/张）
- 省钱：先 `browser_find` 再 snapshot；长页面用 `browser_evaluate` 只取所需数据
- **本地页面没法用 `file:`**（本机实测被拦：`Access to "file:" protocol is blocked`）→
  用 `about:blank` + `browser_evaluate` 注入，或起一个 http 服务

### L2 桌面 UIA — `mcp__desktop__desktop_uia_*`
- `desktop_uia_tree`（文本，~1-2KB，远低于截图）/ `desktop_uia_find` / `desktop_uia_click`（Invoke，不动物理鼠标）/
  `desktop_uia_setvalue` / `desktop_uia_getvalue` / `desktop_uia_read_text` / `desktop_uia_scroll`
- ⚠️ Electron/Canvas 应用（部分笔记类应用、部分现代 UI）UIA 树为空 → 直接跳 L3

### L3 窗口级截图 — `desktop_screenshot_window` / `desktop_screenshot`
- 只截目标窗口或小区域，**不要全屏**；坐标换算见 §C3

### L4 物理鼠标键盘 — `desktop_click` / `desktop_type` / `desktop_hotkey` / `desktop_scroll`
- 干扰最大、最不确定；仅在前三层不可行时用；执行前 `desktop_list_windows` + `desktop_activate_window`

## B. 动作契约（核心：只有"新出现"才算证据）

### B1 三态效果词汇
任何时候都按三态报告，不要用"成功/失败"：

```
ok: true, verified: false, effect: "unverifiable", verification_required: true
```

- `ok` = 工具接受了调用；**不等于**输入被观测到。
- `verified` = 有读回/判据证明效果发生。
- `unverifiable` / `not-met` = 没有证据；**不得盲目重试**（重试会重复输入）。
- **中止 = 结果未知**：取消只停止等待，不撤回已投递的输入；中止后先重新观察。

### B2 增量判据（最容易骗自己的一条）
期望文本必须**动作前不在、动作后出现**。
- 动作前就在屏上的字符串**不是证据**（本机实测：`idle` → `CLICKED-OK` 才算 verified）。
- 声明了"本来就存在"的期望 → 判 `invalid-expectation`，不要算通过。
- **元素树为空（0 元素）时，一切文本判据都不成立**：空树的 revision 是常量（`e3b0c442…`），
  它的"没变"不能当证据；这种窗口（UWP/XAML、画布）只能用像素差或视觉判据，并如实说明。

### B3 坐标绑定帧
从哪一帧读出的坐标，只能用于那一帧：每次动作前重新观察，把当前 `frame_id` 一起传回；
过期/陈旧的帧必须拒绝，而不是"大概没错"。`frame_id` 是粗签名（抗光标闪烁/覆盖层），
`pixel_id` 是精确字节哈希——只有前者适合做绑定判据。

### B4 写后回读才提交
`desktop_type` 只回 `typed N chars`（投递记账），**不是**文本进去了。回读命中才提交；
回读失败先重新观察，不要重打一遍。回读通道按**价值顺序**试：ValuePattern → TextPattern → 元素树；
三者都读不到时是 `unverifiable`（"没有通道能读"），**不是** `not-met`（"读到了但没有"）。

### B5 静止判据（替代固定 sleep）
- 必须**两个信号**都不动：元素树 + 窗口像素粗签名。只看树会漏掉转圈/进度条。
- **至少两次采样**：一次慢观察本身就能耗掉 `stable_ms`，单次采样是假稳定。
- 一直动就**如实报 unstable**，并写清"最后在动的是哪个信号"。
- 像素信号不可用时**要说不可用**，不能当成"没变化"。
- 像素判据有**两条**：采样网格的**平均亮度差**（大面积变化）＋ **跳变格子计数**（小目标移动）。
  只用平均值会把"一个小方块在动"平均掉——实测动画窗口平均差 1.33（低于容差 1.5）却真的在动；
  改成 48×27 真网格后同一窗口跳变格 49-58、静止窗 3-6，阈值取 12 才分得开。

### B6 散列只答"变没变"
`Image sha256` / revision / 内容散列能证明**变没变**，不能证明**是什么**。要断言内容，必须读文本。

### B7 自指证据
不要在被驱动的窗口里搜索**你自己刚发出的文本**：那串字出现在屏幕上，可能只是因为请求本身渲染在那里。
本机现状：Playwright 是独立 profile，不渲染本会话 → 这条路上被结构性规避；但**桌面路线**上用户屏幕
就有对话窗口（部分笔记类应用 里"输入标题再搜标题"同理），那条路线仍然有效。要证明视觉通道，用
**你事先不知道的随机码**去读。

## C. Windows 路由与坐标

### C1 按目标选通道，不按习惯选
| 目标 | 通道 | 判据 |
|---|---|---|
| 网页 / Electron 渲染层 | Playwright DOM（本机等价于 CDP 输入） | 终态 DOM 文本/URL，不是返回码 |
| 原生控件有 UIA 树 | `desktop_uia_*` 按名字定位 | 控件值/树文本读回 |
| 原生控件无 UIA 树 | 窗口截图 + 坐标点击 | 像素指纹 + 文本双判据 |
| 文本输入 | 键盘/UIA ValuePattern，**不要**靠坐标点定位光标 | 读回值 |
| 画布/自绘控件 | 截图取坐标 → 点击 → 像素比对 | 只能像素判据 |

**不要混用**：网页用坐标点击、原生控件指望 DOM，都是静默失败。

### C2 DPI 与坐标
- 本机 1920×1080、appliedDPI=96 → 截图像素与逻辑坐标 1:1。
- 换成 125%/150% 缩放时才需要换算；**换算前先确认 DPI**，不要沿用别处的系数。

### C3 截图落点
`desktop_screenshot`/`desktop_screenshot_window` 会返回保存路径 + **`Image sha256`**，
`desktop_screenshot_window` 还返回 **`frame_id`**——截图路线上把坐标绑帧就用它当 `screenshot_id`。
定位元素时按返回图片尺寸与真实窗口 rect 换算，别拿截图坐标直接当屏幕坐标用（窗口不在 (0,0) 时必错）。

## D. 并发（这台机器会有别的会话）
- 每个窗口一把**内核命名互斥量**：`Global\DSH-CUA-win-<hwnd>`（`DSH_CUA_MUTEX_PREFIX` 可覆盖）。
  **判据在内核**，不看"你是谁"：持有即有权动作；持有者进程死掉，内核立刻放行（不需要等 TTL）。
- `~/.dsh/computer-use/leases/` 里的文件现在只是**标签**（谁在动），**从不参与裁决**。
  `desktop_lease_status` 会同时报标签和内核探测结果：**标签还在但互斥量已空 = `stale_label`**，以后者为准。
- `session_tag` 参数只是标签（默认回落 `DSH_SESSION_ID` → pid），不传也不影响互斥。
- 互斥量管得住**调用我们这套工具的进程**；别人家的 agent 不调用就不受约束 → 仍然要配合下面的观测信号。
- 别的信号：目标窗口的 revision 在你没动它时也变了、前台应用在两次观察之间被换掉 → 判 `contended`，
  **放弃、不要重试**。
- 避开全局资源：剪贴板、前台焦点、全局热键是整机共享的。

## E. 工具速查（契约层就位时）
| 要做什么 | 用哪个 |
|---|---|
| 取一帧证据（revision + frame_id + pixel_id） | `desktop_observe` |
| 变了什么（结构 + 文本 + 像素差） | `desktop_diff_window` |
| 等窗口静止（双信号、≥2 采样） | `desktop_wait_stable` |
| 点击 + 三态裁决 | `desktop_click_verified(expect_text=..., screenshot_id=<frame_id>)` |
| 输入 + 回读裁决 | `desktop_type_verified(control_name=..., expect_text=...)` |
| 谁占着窗口（标签 + 内核探测） | `desktop_lease_status` |
| 首次接入未知 app | `desktop_probe_app`（见 §G） |

⚠️ **这些工具在驱动重启后才出现在工具列表里**。看不到它们时不要假设它们存在——退回手工纪律：
动作前 `desktop_observe`（或截图取 sha256）→ 动作 → 再观察一次 → 自己比对增量与指纹。

## G. 首次接入一个没见过的 app
顺序固定、先便宜后昂贵、**默认只读**：

1. `desktop_probe_app("<窗口标题>")` —— 只读：读树（元素数）、取像素指纹、按**进程与文件证据**
   判断是否 Chromium/Electron（`chrome.exe`、`resources\app.asar`、`chrome_*.pak` 等），不算名字。
2. 只有 `confirm=True` **并且你自己指定 `element_name`** 时才会真的点一下，比较 revision 与像素差。
   **结论取决于你挑的元素**：挑一个没有代表性的元素会得到一个"正确的错误答案"。
3. 同样需要 `confirm=True` 才会打一个探测字符并**读回 + 撤销**（撤销失败会在卡片里写 WARNING）。

判定（`route`）：
| 观察 | 路由 | 为什么 |
|---|---|---|
| 有树 + 点击生效 | `uia-name` | 按名字定位，窗口局部像素兜底 |
| 有树 + 点击无效 + Chromium | `dom` | 渲染层不吃合成点击，走 Playwright |
| 有树 + 点击无效 + 非 Chromium | `keyboard` | 文本视图/自绘控件常是这样 |
| 无树 + Chromium | `dom` | 只能走渲染层 |
| 无树 + 键盘可用 | `keyboard` | 没有树也能靠键盘驱动 |
| 无树 + 无证据 | `vision` | 只剩像素：截图取坐标 + 像素/文本双判据 |
| 还没点过 | `unknown` | 不下结论，先按第 2 步探一次 |

## H. 验收（改了这个驱动之后就跑一遍）
```
python <把 acceptance.py 放在哪>/acceptance.py --module-dir "$env:USERPROFILE\.dsh\mcp\desktop" --json report.json
```
`acceptance.py` 随 computer-use 制品包提供（`mcp/desktop/verify/`），也可拷到任意目录；
`--module-dir` 指向**被验的驱动**。一条命令，PASS / FAIL / SKIP 三态；**SKIP 必须带理由且不算通过**；
有 FAIL 即非零退出。
夹具是脚本自己启动并清理的窗口（计算器 + 自有的 WinForms 对话框），
**不要用标题子串去认夹具**——本机踩过两次：一次把测试文本打进了用户已开标签页的记事本，
一次把浏览器地址栏当成"运行"对话框的输入框。判据是"启动后新出现的窗口"。

## F. 已知边界（写"证据 + 替代"，只写"不支持"等于把问题丢给下一个人）
| 边界 | 证据等级 | 替代 |
|---|---|---|
| Playwright 拦 `file:` 协议 | 本机实测 2026-10-19 | `about:blank` 注入 / 起 http |
| Chromium 窗口默认不暴露 UIA 树（0 元素） | 沿用他机实测，**本机未复验** | 走 Playwright DOM |
| 文本视图用坐标点击不定位光标 | 沿用他机实测，**本机未复验** | 键盘 / `desktop_uia_setvalue` |
| 记事本编辑器不暴露 ValuePattern/TextPattern | 本机实测 2026-10-19 | 用有 ValuePattern 的控件；或判 `unverifiable` 而非 `not-met` |
| UWP/XAML 窗口对 **UIA2** 不暴露树（PowerShell 5.1 加载的 UIAutomationClient），「设置」深度 6/10 都是 0 元素 | 本机实测 2026-10-19 | 走像素/视觉；这类窗口上文本判据不可能成立 |
| 中文/非 ASCII 标题与控件名曾在宿主内变成**空输出**（helper 继承了父进程控制台编码） | 本机实测 2026-10-19，已在 `uia_helper.ps1` 钉死 UTF-8 输出 | 生产者与消费者同口径（消费端本来就按 UTF-8 解码） |
| 打包应用（UWP）的 UIA 名与标题栏不一致，按名字找不到窗口 | 本机实测 2026-10-19 | 先按 Win32 窗口标题找 hwnd 再 `FromHandle`（helper 已改） |
| 打包应用的窗口所有者常是 `ApplicationFrameHost.exe`，不是应用自己 | 本机实测 2026-10-19 | `probe_app` 已改为**找子窗口的真实 pid**再分类，并在 `evidence` 里同时报 `window_owner_pid` 与 `pid`；两者都对不上时才按"未分类"处理 |
| Open/Save 原生面板不可自动化 | 沿用他机（macOS）结论 | 网页走 `browser_file_upload`；原生应用把路径粘进应用自身 UI |
| 网页 HTML5 拖放不可用 | 沿用他机实测，**本机未复验** | 让页面暴露可编程接口，或点/键盘代替拖放 |
| 无模型级取消原语 | 契约层面的诚实结论 | "中止=未知，先复验" |
