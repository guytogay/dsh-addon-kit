---
name: computer-use-strategy
description: 浏览器/桌面操作选择策略与省 token 规则（Chrome/Edge/Firefox/DOM vs UIA vs 截图）
whenToUse: 任务涉及操作网页、浏览器、桌面应用、GUI 自动化，或需要决定用哪种工具执行时
---

# Computer Use 执行策略（省 token 优先级）

执行任何界面操作前，按下面的**优先级阶梯**选择工具。核心原则：
**结构化优先，视觉兜底**——每一级通常比下一级便宜 10~50 倍。

## 阶梯（从省到贵）

### L1 浏览器 DOM（最优）— mcp__chrome__* / mcp__edge__* / mcp__firefox__*
- `browser_navigate` + `browser_find`（文本/正则直接定位元素，**不要**先全量 snapshot）
- `browser_snapshot`：只在需要看整体结构时用；**深度默认已限制**，返回可访问性树文本
- `browser_click` / `browser_type` / `browser_fill_form` / `browser_select_option` /
  `browser_press_key`：元素 ref 精确定位，毫秒级，无坐标误差
- `browser_take_screenshot`：**仅在需要验证视觉渲染/图形界面时**使用（图片 ~600-1000 vision token/张）
- 浏览器选择：目标站点常见于哪个就按需用对应实例；`browser_tabs` 可切换多个标签
- 省钱技巧：`browser_snapshot` 前先 `browser_find`；长页面用 `browser_evaluate` 提取所需数据；避免反复截图

### L2 桌面 UIA — mcp__desktop__desktop_uia_*
- 读控件树：`desktop_uia_tree`（文本，~1-2KB，远低于截图）
- 操作控件：`desktop_uia_click`（Invoke/Select/Toggle，**不动物理鼠标**）、`desktop_uia_setvalue`、
  `desktop_uia_getvalue`、`desktop_uia_read_text`、`desktop_uia_scroll`
- ⚠️ 已知边界：Electron/Canvas 应用（如 部分笔记类应用、部分现代 UI）UIA 树为空 → 直接跳 L3

### L3 窗口级截图 — mcp__desktop__desktop_screenshot_window / desktop_screenshot
- 只截目标窗口或小区域（left/top/width/height），**不要全屏**
- 截图返回的图片是**下采样后**的；定位元素时按返回图片尺寸与真实窗口尺寸换算坐标
  （desktop_screenshot_window 的返回值文本含保存路径；窗口 rect 可用 desktop_list_windows 获取）
- 坐标换算：click 坐标 = 截图坐标 × (真实窗口宽/截图宽)

### L4 物理鼠标键盘 — desktop_click / desktop_type / desktop_hotkey / desktop_scroll
- 最高干扰（不抢占用户输入）、最高不确定性；仅在 L1-L3 都不可行时使用
- 执行前确认：目标窗口已 `desktop_activate_window` 置前；鼠标位置 `desktop_get_cursor`

## 其他纪律

- 桌面操作前先 `desktop_list_windows` + `desktop_activate_window`（避免打到错误窗口）
- 生成/等待类任务：等足够时间再验证（长任务直接 30-60s），不要频繁轮询截图
- 密钥/敏感输入：优先 `desktop_uia_setvalue` / `browser_type`，绝不写入日志
- 图片 token 会累积到会话压缩：长会话适时 /compact；视觉验证尽量用窗口/区域级截图
- Playwright MCP 实例都是**持久 profile**（登录态保留）；如需连接用户正在用的浏览器
  可用 `--extension` 模式（需安装 Playwright Extension），或用 `browser_tabs` 复用已有标签
