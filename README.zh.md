# dsh-addon-kit — DSH 自定义能力制品包（跨 Agent 复用矩阵）

> 打包自本地 DSH（2026-08-20~09-03 间授权开发的全部附加层），
> 每个制品均可安装到其他 DSH 实例或任意 MCP/A2A 客户端。
> **不包含任何凭据值**（全部模板化，密钥用 generate-keys.ps1 重新生成）。
> 本机完整审计：`../DSH-自定义审计-2026-09-03.md`（工作区根，仅本地）。

## 制品矩阵

| 目录 | 制品 | 跨 DSH 复用 | 跨 Agent 复用（非 DSH） |
|---|---|---|---|
| `skills/computer-use-strategy` | 执行策略 skill（省 token 阶梯） | 复制到任意 DSH `~/.dsh/skills/` | 复制成 Claude/Cursor skill 格式 |
| `mcp/desktop` | Windows 桌面执行层（物理+UIA，17 工具） | cordis patch + install.ps1 | 任意 MCP 客户端 stdio（pip 装 mcp+mss） |
| `mcp/playwright-browsers` | Chrome/Edge/Firefox 三浏览器（DOM 级） | cordis patch ×3 | 任意 MCP 客户端（npx @playwright/mcp） |
| `plugins/dsh-file-attach` | DSH web 附件上传插件（v0.1.0） | cordis patch + 放置 node_modules | DSH 专用；参考 client.js 自行适配 |
| `bridges/a2a-peer-bridge` | A2A v1.0 端点 + Peer MCP 桥（生产级） | 两端部署（PC↔任意 peer） | **任何 A2A 标准客户端** |
| `mobile-remote` | 手机 HTTPS 双通道接入包 | setup.ps1 + patch 片段 | 仅 DSH（Tailscale 层是通用的） |
| `ui-patches/dsh-patch-kit-release` | Web UI 补丁库（移动端/布局） | 复制应用到目标 web-frontend | 仅 DSH 构建 |

## 安装矩阵速查

**目标：新 DSH 实例** → skill 复制 + 各 cordis-patch.yaml 片段（路径替换）+ install 脚本。
**目标：Claude Code / Cursor / Windsurf 等** → `mcp/desktop` 与 `mcp/playwright-browsers`
给 JSON mcpServers 配置（command/args 相同）；`skills/computer-use-strategy` 转为对应
skills 目录；A2A 桥可直接被其 A2A 客户端唤醒（若宿主支持 A2A）。
**目标：其他 A2A agent** → bridges 对端部署（生成新密钥，勿复用本机值）+ A2A card 发现。

## 发布规范
- 每个制品自足：README（用途/依赖/安装 DSH 片段/通用安装/验证/边界）
- 凭据零值：只给模板 + 生成器；旧值本机保留（不随包分发）
- 版本：桌面 v1.0 · browsers v1.0 · bridge 契约 v1.6.1 · file-attach v0.1.0 · patch-kit 发布快照
- 一致性由 `addon-manifest.yaml` 机器可读清单锚定；公开仓 CI（sanity.yml）每次 push 验密

## 目录速览
```
dsh-addon-kit/
├── README.md（英文）  README.zh.md（本文件）
├── addon-manifest.yaml      机器可读清单
├── ci-scan.py / .github/workflows/sanity.yml   CI 验密
├── skills/  mcp/  plugins/  bridges/  mobile-remote/  ui-patches/
└── （各制品内 README + 安装脚本 + cordis 片段）
```
