# dsh-mobile-sidebar — 手机端左上角悬浮侧栏入口

## 解决什么问题

手机上侧栏收起后，官方把「打开侧栏」控件放在框架的 `shell.leading` 座位里，而该座位**随侧栏列一起被平移出屏幕**。实测（393×852 视口）：

| 控件 | 尺寸 | x |
| --- | --- | --- |
| 打开侧边栏 | 44×44 | **-383（屏幕外）** |
| 新建会话 | 44×44 | **-383（屏幕外）** |
| 打开右侧边栏 | 44×44 | 337（可见） |

即**手机上没有任何可见入口能打开侧栏**。

## 效果

- 视口 ≤720px 或粗指针时，左上角出现 **44×44、78% 半透明、毛玻璃**的悬浮按钮
- 点击调用官方 `ctx.layout.toggleSidebar()`，侧栏以全宽抽屉展开
- 桌面端不显示，不与官方控件重复
- 配色全部走官方主题令牌，浅色/深色自动适配（实测浅色 78% 浅底 + 深图标、深色 78% 深底 + 浅图标）

## 为什么用 shell.overlay，而不是 shell.leading

`shell.leading` 是 `kind: single`、已被官方 ui-sidebar 占用、`replaceRisk: shadows-shipped-ui`——占用它会遮蔽官方控件并丢掉「新建会话」。

`shell.overlay` 是 `kind: list`、`replaceRisk: none`，新 id 加在官方条目**旁边**而非替换；该层默认**点击穿透**，本插件显式声明 `pointer-events: auto` 才接收点击。

**不读任何其他插件的 DOM 或样式**（插件开发规范禁止），按钮用 `position: fixed` + 安全区 inset 自行贴住视口左上角。

## 安装

```bash
# 官方 profile manager（会先校验 DSH peer/engines）
dsh plugin --profile <profile> add <此目录的绝对路径>
```

或把本目录放进 profile 后，用官方 `install_bundle` 流程安装。

## 兼容性

- 实测通过：**dsh 0.2.0-rc.2**
- 依赖：`shell.overlay` 槽位（由 `@deepseek-ai/dsh-client-ui-layout` 声明）与 `ctx.layout.toggleSidebar()`
- 客户端半**不 import** `@deepseek-ai/dsh-client-ui-primitives`，图标为内联 SVG

## 验证

```bash
node tools/dsh-ui-verify/dsh-mobile-audit.mjs
```

判据：按钮 `found=true`、`44×44`、`visible=true`、点击后侧栏列 x 归 0、控制台错误 0。
