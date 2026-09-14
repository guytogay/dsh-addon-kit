# Peer 互联契约纪要（v1.3 → v1.6.2，本机实绩）
> 本文件为**契约纪要**（含现场记录），不是规范源。版本号即 `addon-manifest.yaml` 中
> `a2a-peer-bridge` 的版本；实现镜像见 `peer-goal.mjs`（投递保真层，唯一被双方通道共用的一份）。

## v1.6.2 —— 投递上限可见化 + 过滤前原文落盘（唯一新增面）
现场失败（真实观测，2026-09-13，<peer-dsh> → pc-dsh）：长任务卡被**静默**截断——原文 3056 字符
（5994 B），接收侧只看到开头 2000 字符，切口落在词中间，接收方无法判断是原文如此还是被截。
两处静默变更叠加：① 过滤器改写内容（`" ` ^ < > & | ; % !` 与换行 → 空格；**CRLF 对整体变一个空格**，
每处换行净 −1 字符——"CRLF 变两个空格"是错的，2026-09-13 由扇出会话独立复核纠正，我方已自证）；
② `goal` 的 2000 个 UTF-16 字符硬切片（**按字符，不按字节**；"4096 字节墙"是误判）。

- 语义**未变**：过滤 + 切片逐字保持 v1.6.1 行为（mirror `peer-goal.mjs` 里有对旧实现的逐字断言）。
- 新增可见字段（附加在 `run_task` 返回体上，纯增量）：`goalSourceChars`（收到的原文长度）、
  `goalCharsIn`/`goalCharsKept`/`goalTruncated`/`goalFilterApplied`（过滤器是否改动了内容）、
  `goalFilteredBytes`、`goalSpillPath`/`goalSpillError`/`goalSpillReason`。
- 落盘判据 = **原文**超上限（不是"过滤后是否被切"）：过滤器能把超长原文压到上限以内，
  只按 truncated 落盘会漏掉那一支。副本 = `$DSH_HOME/peer-inbox/<taskId>.md`，
  存**过滤前**原文（存过滤后的串保真度仍然丢失）；只读、不执行、不参与 prompt。
- `context`（4000 字符，仅写 `DSH_PEER_CONTEXT`）**仍无消费者、不进 prompt**——已在
  MCP tool 描述与 A2A skill 描述里明说，不再是一个"看起来能用"的静默参数。
- 操作口径（双方 2026-09-13 约定）：长文只发 ≤2000 字符任务卡 + spill 取件；**不要依赖
  反引号与换行做结构**（它们会变空格）；跨机文本里避免反引号。
- 覆盖：MCP `run_task`（39480）与 A2A `message/send` 的 run_task 路径（39481）同一条
  `runHeadless`，同值同形（goal 2000 / context 4000 / workspace 500）。

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
| LXC <peer-dsh>（<PEER_TAILSCALE_IP>） | <PEER_TAILSCALE_IP>:39481 | :39480/mcp | 双向闭环 v1.6.1；三 skills（v1.6.2 投递保真层为 PC 侧先落地，LXC 侧待其自行采用） |
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
