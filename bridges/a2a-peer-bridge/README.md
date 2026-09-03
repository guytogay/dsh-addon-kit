# A2A + Peer MCP 桥 — 跨 Agent 互联制品（生产已验证）

把"任何 DSH/agent 变成 A2A 标准 peer + MCP 可调端点"的最小完整包。
PC 侧实绩：run_task A2A-OK ✓ · 异步 Push 回调端到端 ✓ · 入站唤醒独立 agent ✓（2026-08-31~09-01）。

## 组件
| 文件 | 作用 |
|---|---|
| `a2a-agent.mjs` | A2A v1.0 端点（官方 @a2a-js/sdk）：card 发现 / get_status / query_sessions / run_task（执行 headless DSH）/ message/send + `POST /a2a/push`（三路鉴权：Bearer / X-A2A-Notification-Token / **X-A2A-Signature** HMAC-SHA256） |
| `peer-mcp-server.mjs` | 跨机 MCP 桥（stdio↔HTTP），DSH 侧 `mcp__peer__*` |
| `generate-keys.ps1` | 生成随机 token/secret（**不复制任何真实值**） |
| `DshA2a.vbs.template` / `DshPeerMcp.vbs.template` | 开源自启模板（隐藏窗口） |
| `contract-v1.6.md` | 契约纪要（端点/鉴权/签名格式） |
| `a2a-agent.mjs.bak-push` | 变更前备份（对照） |

## 部署（对端双向）
1. `npm i @a2a-js/sdk@1.1.0 express`（a2a-agent 依赖）
2. 生成密钥：`powershell -File generate-keys.ps1` → 得到 PUSH_TOKEN / SIGNATURE_SECRET / PEER_TOKEN
3. token 放本地文件（`a2a-push.token` / `a2a-push-signature.secret` / peer token），**不落库/日志**
4. 启动：`node a2a-agent.mjs`（监听 :39481）+ `node peer-mcp-server.mjs`（:39480）
5. 自启：Startup 放模板 vbs（改绝对路径）
6. 对端（any A2A client）：card 发现 → run_task / message/send；push 回调带
   Bearer 或签名（签名规则见 contract-v1.6.md）

## 端点
- A2A：`http://<pc-tailscale-ip>:39481`（card: /.well-known/agent-card.json · push: /a2a/push）
- MCP：`http://<pc-tailscale-ip>:39480/mcp`（Bearer）

## 安全
- 密钥全部经环境变量/文件读取（源码零硬编码，已扫描）
- /a2a/push 三路鉴权 fail-closed；远程只走 Tailscale（tailnet-only）
- 签名注意：peer 签名 = HMAC-SHA256(secret, json.dumps(obj, sort_keys=True, ensure_ascii=False))，
  校验必须"解析→键排序→py-dumps(非转义)"重算，不能拿原始字节直接 HMAC（详见 contract）

## 其他 agent 接入
A2A 是开放标准（Google/Linux Foundation v1.0）：任何 A2A 客户端可用同一 card 发现协议接入；
MCP 桥方面任意 MCP 客户端（Claude/Cursor/…）均可指向 :39480。
