# desktop MCP — Windows 桌面执行层（自研，零付费依赖）

给任意 MCP 客户端提供"Windows 桌面 computer use"：物理键鼠 + UIA（无障碍树）双模式。
视觉决策由调用方模型完成（本机 DSH 用 DeepSeek 视觉模型，零 OpenAI/Codex 成本）。

## 工具（17 个）
- 物理：desktop_screenshot（支持区域/窗口级）· desktop_click · desktop_move · desktop_type（中文）·
  desktop_key · desktop_hotkey（支持 ctrl+p 等字母键）· desktop_scroll · desktop_list_windows ·
  desktop_activate_window · desktop_get_cursor · desktop_screenshot_window
- UIA（不动物理鼠标、零图片 token）：desktop_uia_tree · desktop_uia_find · desktop_uia_click ·
  desktop_uia_setvalue · desktop_uia_getvalue · desktop_uia_read_text · desktop_uia_scroll

## 依赖（仅 Windows + Python 3.11+）
- `pip install mcp mss`（本项目 venv：mcp 1.29.1 + mss 10.2.0；**不要装 mcp>=2**，FastMCP API 在 2.x 改名）
- UIA 走 Windows 内置 PowerShell 5.1 + .NET UIAutomationClient（零额外依赖）

## 安装

### 通用（任意 MCP 客户端；stdio）
```bash
pip install mcp>=1.28,<2 mss
# 启动命令：python <kit>/mcp/desktop/desktop_server.py
```

### DSH（本机，cordis patch）
把 `cordis-patch.yaml` 的片段加入 `~/.dsh/profiles/web/cordis.patch.yml`（或任意 profile patch）。

### Claude Code / Cursor / Windsurf 等（JSON 配置）
```json
{ "mcpServers": { "desktop": {
  "command": "python",
  "args": ["</path/to/desktop_server.py>"] } } }
```

## 验证
```bash
python smoke_test.py        # 握手 + tools/call screenshot + list_windows
```

## 已知边界
- UIA 对 Electron/canvas 应用（部分笔记类应用 等）树为空 → 回退物理输入
- 需要本机交互式桌面会话（RDP/远程无桌面受限）
- 无任何 OpenAI/Codex/付费依赖；截图 token 取决于调用模型视觉定价
