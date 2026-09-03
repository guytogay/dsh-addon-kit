# playwright-browsers MCP — Chrome / Edge / Firefox 三浏览器执行层

基于 Microsoft 官方 @playwright/mcp，一个本地安装、三个实例（Chrome/Edge/Firefox），
DOM 级网页互动（navigate/find/snapshot/click/type/fill_form/screenshot…24 工具/实例）。
**省 token 要点**：网页操作走 DOM（文本）而非截图；截图仅用于渲染验证。

## 依赖
- Node.js 18+（本机验证 Node 24 / npm 11）
- 浏览器：Chrome/Edge 用系统安装（channel，零下载）；Firefox 用 Playwright 构建
  （`npx playwright install firefox`，~122MiB）

## 安装
### 通用（任意 MCP 客户端）
```bash
npm install -g @playwright/mcp          # 或项目内安装
npx playwright install firefox          # 可选：Firefox 支持
# 启动：npx @playwright/mcp --browser chrome   （或 msedge / firefox）
```

### DSH（cordis patch）
见 `cordis-patch.yaml`：三个 insert（mcp-chrome / mcp-edge / mcp-firefox），
各自 `--user-data-dir` 持久 profile（登录态跨会话保留）。

### 其他 MCP 客户端（JSON）
```json
{ "mcpServers": { "firefox": { "command": "npx",
  "args": ["-y","@playwright/mcp@latest","--browser","firefox","--user-data-dir","./ff-profile"] } } }
```

## 参数速查（省 token 相关）
- `--browser chrome|msedge|firefox`（系统 Chrome/Edge 通道 / Playwright Firefox 构建）
- `--user-data-dir <path>`：持久 profile（登录态）
- `--isolated`：内存 profile（测试用）
- `--mobile`：移动页面模拟（官方称更省 token）
- `--extension`（Chrome/Edge）：接管**你正在运行的浏览器**（需装 Playwright Extension）
- 行为建议：先 `browser_find` 定位、再操作；`browser_snapshot` 看结构；截图仅验证渲染

## 验证
```bash
node smoke_test.js    # 本机（含本机路径）示例，见 mcp/playwright 原目录
```
