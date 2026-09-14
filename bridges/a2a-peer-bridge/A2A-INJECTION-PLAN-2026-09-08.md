# A2A 注入通路实施方案（P0 结论 + P1-B/P1-C 设计）— 2026-09-08

> 承接 `A2A-DELIVERY-GAP-2026-09-08.md`（工作单 §10）；作者：DSH 优化 session；状态：**方案已出，待用户批准后实施**。

## 1. P0 决定性实验结论：CLI resume 通路不存在

**实验/调研证据（本 session 实测，2026-09-08）：**

| 检查项 | 结果 |
|---|---|
| `dsh --profile tui --resume <session>` | **tui profile 不存在**；`PROFILE_TEMPLATES`（dsh-app-boot L323-326）只含 `web` / `headless` 两个 shipped 模板 |
| npm registry `@deepseek-ai/dsh-tui` | **404 不存在**（官方无此包） |
| `dsh --help` 中的 tui 示例 | 只是"arguments after the launcher flags reach the app"的**通用示例**（bin.js L16/L34 注释），并非承诺存在该 app |
| `--resume` 是否为 dsh CLI 选项 | **否**（grep bin.js：仅示例文本，无解析代码） |
| headless `run()`（dsh-headless/lib/index.js L94-96） | 每次 `agents.create({ sessionId: SessionId(\`session-${randomUUID()}\`) })` ——**新会话，无续写** |
| `AgentRegistry.resume()`（dsh-agent lib/index.js L556-561 → factory.resume；type L123-195） | **官方 API 存在**：`resume({ resumeSessionId, agentOptions, setup })` → 从持久化加载会话 → 恢复为 live agent/session 身份 → 可 `agent.followup()` 续写 |

**P0 结论（非官方命名的推论，但证据充分）**：`tui --resume` 是文档层幻觉；**注入通路必须走进程内 API**（`ctx.agents.resume()`），即 P1-B 插件路径。

## 2. P1-B 设计：`dsh-async-inbox` 插件

### 2.1 目标

外部（A2A 桥/任务代理）向 DSH 投递一条消息，使其被某个**既有会话**（sessionRef）执行、轮次写回同一会话文件、GUI 打开即可见——不依赖外挂库、不依赖用户手动操作。

### 2.2 主机面（宿主进程内插件，dsh 模块内）

**名称**：`@deepseek-ai/dsh-async-inbox`（cordis 插件，`name: "async-inbox"`）

**接口**：注册 webserver 路由 `POST /api/async/inject`（经 dsh-host-webserver 的 `webServer.register({kind:"exact", path:"/api/async/inject", handler})`；复用 browser-trust 栅栏——与 /api 其余路由同源同信任面）。

**请求体**（JSON）：
```json
{
  "sessionRef": "session-<uuid>",
  "message": "回话体（自包含模板见 §4）",
  "token": "<shared-token>"   // 可选；与 a2a 桥同 token 池，防越权
}
```

**处理序**（handler）：
1. 校验 token（若配置）+ 解析 sessionRef；
2. `await ctx.agents.resume({ resumeSessionId: SessionId(sessionRef), agentOptions: ctx.get("agentDefaultModel")?.currentSelection() ... })` ——注意：resume 要求**本进程 factory 已注册**（web profile 已组合 dsh-agent-loop / factory；实施时先确认 web profile 组合，若 web 进程无 factory，则改由独立 headless 子进程执行"注入"——见 2.3 变体）；
3. `agent.followup(createUserMessage({ content:[{type:"text", text:message}], source:{kind:"user"} }))` → `await agent.whenIdle()`（新轮次执行完成）；
4. `await ctx.sessions.flush(agent.session)`（持久化 checkpoint → 同一 session 文件追加）；
5. 返回 `{ ok:true, sessionRef, appendedSeq }`。

**GUI 可见性**：flush 后 Web 客户端依赖 `session/event`（若客户端已打开该会话，界面通过既有事件流自动出现新轮次——评估期以"刷新后可见"为准验收；实时推送若 sse 已接 events 通道则天然可见）。

### 2.3 变体 A（若 web 进程中无 `agents`/factory —— 调研待确认）

改为**独立子进程**：`dsh --profile headless --patch <async-inbox-overlay>` 由插件钩子拉起，overlay 注入 `resume` 驱动的 runner（等价于给 headless 加一个 `--resume <id>` 模式：把 headless-runner 的 `agents.create` 换成 `agents.resume`，用 `cmdlineArgs` 透传 sessionRef）。代价：一次独立的 host 树启动（~1-2s），不占 web 进程；结果仍写回同一 session 文件（持久化按 id 追加）——**这是 P1-B 的落地兜底，且完全不改官方包**（patch 走 kit 参数化脚本）。

### 2.4 任务卡（$DSH_HOME/async-inbox/）

`{taskId}.json`（outgoing/incoming 共用目录，字段：taskId/sessionRef/goal/ts/status/result）：
- **接单侧（B→A 回话到达）**：A 侧收到 A2A 回话 → 落 incoming 卡 → resume 注入原会话；
- **发起侧（A→B）**：出站即落 outgoing 卡（goal 摘要 + sessionRef + 回话条款），供后续对账/审计。
- `$DSH_HOME/async-inbox/` 属 DSH 自身目录，**不落外挂库**（分层原则 §4，USER 2026-09-08 裁定）。

## 3. P1-C 配套（与 P1-B 并行可做）

| 项 | 内容 | 验收 |
|---|---|---|
| B 侧 a2a-agent 落盘 | LXC `39481` a2a-agent.mjs 补 audit 行（对齐 MCP audit.jsonl：ts/taskId/status/exitCode/result） | 一次任务后文件追加可查 |
| 长任务超时 | `dsh-peer-mcp.service` 加 `Environment=PEER_HEADLESS_TIMEOUT_MS=86400000`；A 侧（PC a2a-agent / client）runHeadless timeout 参数化 | 长任务（>30min）不撞墙 |
| 幂等重联 | PC `<PC_TAILSCALE_IP>:39480` peer server 对称 stateless（或 mcp-client 幂等重 init） | 服务重启后客户端不重 init 仍 200 |
| Map 泄漏 | LXC deployed 版 stateless 分支不落 `transports` Map（对齐 kit） | 每请求不泄漏 |

## 4. 回话自包含模板（双方互操作契约）

```json
{
  "taskId": "<uuid>",
  "goal": "<发起时 goal 摘要 ≤200字>",
  "sessionRef": "<发起方会话 id，B 原样回传>",
  "result": "<结论，可长>",
  "ts": "<ISO8601>"
}
```

A 侧接单即据此重建上下文，命中 `sessionRef` 则 resume 注入；无 sessionRef 或已失效 → 落 incoming 卡并**新建** headless 会话执行（仅结果落盘+双库，不冒充原会话）。

## 5. 实施顺序与闭环要求

1. **调研确认**（P1-B 前置，1 次 pass）：web profile 组合是否已含 agent loop factory（`ctx.agents` 在 web 进程可用否）；`dsh-session-persistence-jsonl` 的 `storage` 服务是否提供按 id 读回持久化事件。
2. **打样**：本地先做一次**手工 resume 实验**（临时 overlay + headless：用测试会话 id 注入一条消息 → 检查 session jsonl 追加 + GUI 刷新可见）——**这是 P0 的替代验证，必须先行**（评估"轮次写回同文件"与"GUI 可见"两个验收点）。
3. **闭环**：插件/脚本进 kit 走参数化（无硬编码 IP/主机名/路径）；本机应用遵守 lease+txn 制度（`evolution/lease-manager.ps1` + begin/end-transaction）；对 LXC 的部署经 A2A 且由 LXC-DSH 自查后回执。
4. **发布**：验证通过 → addon-manifest.yaml 登记 → publish_public → ci-scan → push。
5. **回滚**：插件卸载 + overlay 移除即恢复原状；resume 实验对 session 文件的追加可通过"先快照 session jsonl"规避。

## 6. 风险与边界

- resume 到**正在活跃**的会话（同一 id 已在 web 进程 live）：agents.resume 会因 id 重复/占用而拒绝（`SESSION_ALREADY_EXISTS`/live 冲突）——设计上**只对空闲/已关闭会话注入**；活跃会话改由既有客户端事件流自然送达（同步性不等）。
- resume 消耗模型 token：注入即一轮 agent 执行，与 headless 同价——token 即边界，token 保护沿用 a2a 桥现状。
- 双进程并发写同一 session 文件：持久化层按 append + 锁（jsonl 实现）处理；以 flush 为序，A2A 路径与 web 路径不应同时写同一会话（约定：A2A 只注入"已被放弃/关闭"的会话，活跃会话不入注入面）。
- web 路由 `/api/async/inject` 是**宿主面扩展点**，安全上等价 `/api` 其余方法：browser-trust 栅栏 + 可选 token 双因素；**不对外开放公网**（0.0.0.0 监听为内网/tailnet 边界，与现有 trustedHosts 讨论一致）。

## 7. 交付物清单（预计）

- `dsh-async-inbox` 插件包（cordis 插件 + 路由 + resume 驱动逻辑；源码入 kit `plugins/` 或 `bridges/a2a-peer-bridge/`）
- 手工 resume 实验报告（P0 替代验证结果，回注本文件）
- LXC a2a-agent audit 落盘补丁（kit 参数化）
- `PEER_HEADLESS_TIMEOUT_MS` 环境化 + 客户端超时参数化（kit 脚本）
- addon-manifest.yaml 登记 + 双库记录
