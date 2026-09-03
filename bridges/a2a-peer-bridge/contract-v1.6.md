# Peer 互联契约纪要（v1.3 → v1.6.1，本机实绩）

## 协议分派
- **A2A**（Agent2Agent Protocol v1.0，Google/Linux Foundation）：独立 Agent 任务、结果封装、
  异步推送回调；`@a2a-js/sdk@1.1.0` 官方实现（明确否决私有包 @dpskh/a2a）。
- **MCP**：工具/资源调用（跨机桥 peer-mcp-server.mjs）。
- 原则：**协议只负责连接，不改变授权层**；MCP/A2A 消息不得绕过知识治理/审批。

## A2A 端点（本机 PC）
- `http://<PC_TAILSCALE_IP>:39481`（Tailscale）：card `/.well-known/agent-card.json` ·
  get_status · query_sessions · run_task（执行 headless DSH）· message/send · `POST /a2a/push`
- 回调鉴权（fail-closed，三路任一即过）：
  - A) `Authorization: Bearer <PUSH_TOKEN>`
  - B) `X-A2A-Notification-Token: <PUSH_TOKEN>`
  - C) `X-A2A-Signature: HMAC-SHA256(secret, body)`（body = 解析后对象
    `json.dumps(..., sort_keys=True, ensure_ascii=False)` 的 UTF-8 字节；不能用原始字节直接 HMAC）
- 幂等：按 taskId 落盘 push-inbox/<taskId>.json（首次终态置 done）；空负载 403

## MCP 桥
- `http://<PC_TAILSCALE_IP>:39480/mcp`（Bearer，同 token 体系）；DSH 侧 serverName=peer
  （mcp__peer__get_status / query_sessions / run_task）

## 对端矩阵（实测）
| 对端 | A2A | MCP | 备注 |
|---|---|---|---|
| LXC <peer-dsh>（<PEER_TAILSCALE_IP>） | <PEER_TAILSCALE_IP>:39481 | :39480/mcp | 双向闭环 v1.6.1；三 skills |
| peer agent（<THIRD_TAILSCALE_IP>） | :9900（回环侧） | :39481/mcp（10 工具） | <peer-model>；33 skills |
| PC 本机 | :39481 | :39480 | 本包 |

## 阻塞/异步语义勘误（重要）
A2A v1.0 官方字段为 `SendMessageConfiguration.blocking`（默认 true=阻塞）；`blocking:false`
才是异步。官方 .NET/Python SDK 误用 `Blocking`/`return_immediately` 变体名（google/A2A #329、
a2a-python #874）；本实现两者都接受为安全网。

## 唤醒语义（三方实测）
A2A 入站 message/send 唤醒**独立 agent 实例**执行并回传（执行/会话/事件三层证据）；
执行实例 ≠ 当前活跃会话（多 Agent 标准分层，非缺陷）。run_task 在 PC 侧产生的 headless
会话落在 a2a-agent 进程 cwd 且未注册 workspace → GUI「未分组」是正常现象。
