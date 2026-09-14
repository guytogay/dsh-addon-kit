# A2A Delivery Gap (PC ↔ LXC-DSH) — 2026-09-08 findings

> 审计人：PC-DSH 排障会话；处理人：DSH 优化 session（本文为工作依据）。
> 触发：run_task 投递长任务 → 客户端 `-32001 Request timed out`；LXC 侧任务继续；用户裁定"异步消息没修好"类问题转本 session 处理。

## 1. 两条通道的语义对比（证据=当前线上源码）

| 通道 | 端点 | 执行语义 | 完成投递 | 持久性 |
|---|---|---|---|---|
| MCP peer | LXC `:39480/mcp`（peer-mcp-server.mjs） | execFile 同步阻塞至完成 | HTTP 响应（客户端超时=丢失会话层投递） | **audit.jsonl 落盘**（ts/taskId/goal/status/exitCode/result/cwd）→ 可审计回捞 |
| A2A v1.0 | LXC `:39481`（a2a-agent.mjs, @a2a-js/sdk@1.1.0） | executor 阻塞执行 → publish(artifactUpdate+statusUpdate) | 事件总线 + InMemoryTaskStore | **纯内存，无落盘**；进程重启即失 |

- A2A 客户端若不**订阅 `/task/{id}/event`（SSE）**或**轮询 `/task/{id}`** → B 的完成回复无任何路径可达 A（fire-and-forget 即丢）。
- 线上 LXC 版 a2a-agent.mjs（08-31, 6908B）：无 push 接收端点、无 capabilities 声明。
- addon-kit 版 `a2a-agent.mjs`：已有 push 接收端点 + events 记录（messagePreview≤3000）+ `capabilities: {streaming:true, pushNotifications:false}` —— **未部署**。
- 已验证的正确形态（PC↔peer agent, 2026-09-01）：`returnImmediately=true` + `taskPushNotificationConfig{url}` + `X-A2A-Signature` + 幂等落盘 `push-inbox/`。**LXC-DSH 侧缺同类接收方。**

## 2. 待决策的修复方向（未执行）

1. **最小**：A2A executor 结束时落盘一行审计（对齐 MCP audit.jsonl 模式：taskId/status/exitCode/result）→ 任何调用方可审计回捞。
2. **交付语义统一**：调用方超时后轮询/审计回捞；或工具拆两段（submit + result-by-id）。
3. **真异步**：部署 addon-kit 新版 a2a-agent 到 LXC；与 PC 侧 `push-inbox`（DshA2a.vbs / `/a2a/push` / X-A2A-Signature）对齐，复用 peer agent 已验证模式。

## 3. 同源坑（已定论，建议一并处理）

- **EACCES 迷案**：`run_task` 传 `workspace:'/root'` → `existsSync` true（stat 不需 /root x）→ `execFile{cwd:'/root'}` → chdir 失败 → Node 报 `spawn /usr/bin/node EACCES`。audit 反证：26×`cwd='/'` completed 0；2×`cwd='/root'` failed。**调用方规则：不传 workspace 或先校验可 chdir。**
- **双 peer 单元**：`peer-mcp.service`（旧，无 env，cwd=/, 在跑）vs `dsh-peer-mcp.service`（完整 env，EADDRINUSE 崩溃循环）→ 收敛为一个。
- **孤儿 dsh-web**（PID 451793，0.0.0.0:3080，手工启动，unit inactive，位于 peer-mcp.service cgroup）→ 先归位 unit 再动旧单元。
- **白名单定调**：内网访问目的保留；**<LAN_IP_2> 动态地址不入白名单**；入口 = `<LXC_LAN_IP>`（LXC 固定 LAN IP）+ `<YOUR_DOMAIN>.ts.net`。

## 4. 证据位置

- LXC：`/home/dsh/peer-mcp-server/{audit.jsonl,server.log,peer-mcp-server.mjs}`；`/home/dsh/peer-a2a/{a2a-agent.mjs,a2a.log}`
- 本仓库：`bridges/a2a-peer-bridge/{a2a-agent.mjs(.bak-push),contract-v1.6.md,README.md}`
- vault：`20 技术与运维/2026-09-01-peer agent-A2A-Push-签名路径重测.md`（peer agent 模式参照）

## 5. 2026-09-08 现场修复（已验证，建议本仓库同改）

- **会话僵滞已修复**：LXC 线上 `peer-mcp-server.mjs` 改为**无状态模式**（`sessionIdGenerator: undefined`）——SDK `webStandardStreamableHttp.js` L727-729：generator 未设置时跳过会话/初始化校验 → 客户端旧 session-id 不再引发 "Server not initialized"；Bearer 认证不变；run_task 端到端验证 `A2A-CLEANUP-OK`。
- 教训：注释不得写在与 `}` 同行的代码之内（本次 `//` 吞闭合括号致 SyntaxError 一次，已修正）。
- 部署注意：本仓库公开副本 `peer-mcp-server.mjs` 目前仍是 stateful 形态，**建议与本仓库同改 stateless**（或客户端实现"400/404 后重新 initialize"）；`a2a-agent.mjs` 仍是 InMemory 异步语义（见 §1 缺陷），push 雏形未部署。
- LXC 清理已执行：双 peer 单元收敛为 `dsh-peer-mcp.service`；web 由 `dsh-web.service` 托管（patch 提供 0.0.0.0 + trustedHosts 三元组，unit 已同步补 <PEER_TAILSCALE_IP>；`--host 0.0.0.0` 被 CLI 拒绝因此勿加——见 R1）。

## 6. LXC-DSH 回执复核（12:34Z，deployed 已与 kit 对齐）

- **kit 规范版本就是 stateless**（L126-127：无 generator + 每请求独立 transport + 无 Map）——deployed 修复是向 kit 对齐，kit 无需同改（纠前文 §5 的猜测）。
- **残差 1（建议修）**：deployed 版在 stateless 下 `transports` Map 仍 `set(randomUUID(), t)` 且重定位分支永不执行 → 每请求泄漏 transport+McpServer；kit 版无 Map。建议 deployed 对齐（stateless 分支不落 Map），一行级。
- **残差 2（知悉）**：39481 a2a-agent 无 audit 落盘；InMemoryTaskStore（重启丢状态）为既有设计。
- **残差 3（PC 复测定论）**：`Host: evil.example.com` → 200，trustedHosts **非 Host 层门禁**（"移出+重启"≠"被拦截"）；边界=监听地址+来源网络。DSH web 的 trustedHosts 语义待优化 session 定义（或被上游收紧）。
- **残差 4**：回滚口径——前态含 .197 的备份 = `cordis.patch.yml.bak-202609080324-cleanup`；`bak-20260908-cleanup` 是现状镜像；04:00 `ena-selfkit/rescue.sh` 全量快照兜底。
- **反向提示**：PC 侧 peer-mcp-server（<PC_TAILSCALE_IP>:39480）如仍 stateful，LXC web 的 dsh-mcp-client 将遇同款会话僵滞——建议双边对称 stateless 或客户端幂等重联（本仓库可出对称更新）。
- **死代码**：LXC `run-mcp.sh` 已被 dsh-peer-mcp.service 取代，建议删除或标注防误启动双实例抢 39480。

## 7. A2A v1.0 线协议实测发现（2026-09-08，未经 SDK 官方文档，均为实测）

对 LXC `39481`（@a2a-js/sdk@1.1.0 jsonRpcHandler）裸调用的**必需四要素**（缺一即错）：
1. **Header `A2A-Version: 1.0`**（`A2A_VERSION_HEADER = "A2A-Version"`，express/index.js L1351；缺失→默认 0.3 → `-32009 VERSION_NOT_SUPPORTED`；`A2A-Protocol-Version`/params.protocolVersion/message.protocolVersion **均无效**）；
2. **方法名 PascalCase 而非 legacy**：`SendMessage` / `GetTask` / `ListTasks` / `CancelTask` / `*TaskPushNotificationConfig`（`message/send`、`tasks/get` 是 0.3 别名 → v1.0 报 `-32601 Invalid method`）；
3. **Message 必须含 `messageId`**（uuid；缺失 → `-32602 message.messageId is required`）；
4. `role: "user"` 回显为 `UNRECOGNIZED`（SDK 角色映射小怪癖，无害）。
- **实测语义**：SendMessage（returnImmediately:true）→ 请求内同步执行完并返回 `TASK_STATE_COMPLETED`（result 内嵌 `{taskId,status,result,exitCode}`）；`GetTask` 可随时从 InMemoryTaskStore 取回；**无 audit 落盘**（39481 区别 39480）。
- 安全语义提醒：A2A 触发 = headless DSH **danger-full-access** 执行（与 MCP run_task 同权），持 token 即可触发——token 保管即边界（现状：shared token 存于 LXC `/home/dsh/peer-mcp/token.txt` 与 PC 侧配置，均为 64 字符）。
- 与 PC 侧旧客户端（09-01 前的 `message/send` 形态）兼容性：**不兼容**（需升级为 v1.0 四要素+版本头），kit 如有旧客户端脚本请同步更新。

## 8. 对称回话已验证 + "零人工"交付设计（2026-09-08 12:48）

- **双向实测**：A→B（LXC 39481）A2A-POKE-OK；B→A（PC <PC_TAILSCALE_IP>:39481）SYM-OK（PC a2a-agent 接单 → Windows headless DSH 全权限执行 → COMPLETED）。两端均为**常驻服务器**——B 无论 30 分钟还是 2 天后回话，A 都照接，时间跨度不影响。
- **结论**：audit 监控（PWSH 轮询 job）只是"MCP 同步通道超时丢响应"的修补，**非架构必需**。真正的"等待"应由常驻端点承担；回话的投递走 A2A 而非 HTTP response。
- **零人工标准流（建议采纳为 SOP）**：A 发起长任务改走 A2A `SendMessage`（returnImmediately 拿 taskId），goal 带条款「完成后：① 结论写共享 部分笔记类应用/文档类；② 回话 A（SendMessage→<PC_TAILSCALE_IP>:39481）」→ B 完成（无论何时）→ 条款执行 → A 接单自动反应 → 用户经共享库可见。**无轮询、无手动 job、无超时丢失**。
- **服务端自动回话（更优，优化 session 可做）**：B 的 peer/a2a 服务器在 execFile 回调处（完成审计后）自动向 A 发回话（仅当调用方 goal 含约定标记时）——把"条款"从任务文本移到机制层。
- **残差（诚实声明）**：A 的"反应"= headless 新会话执行，无 DSH-host 级消息注入（不会自动出现在 GUI 活会话——属优化清单）；audit.jsonl 保留作请求侧取证，不再承担投递。

## 9. 分层原则修正（USER 2026-09-08 裁定）：投递/唤醒必须 DSH 内生

- **部分笔记类应用/文档类 = 外挂知识层**：只用于人类可读的记录/溯源/离线咀嚼（双库本职），**不作为** DSH 系统内的投递/唤醒/控制通道。此前"共享库收件箱约定"类方案**降级为记录层约定**，不作交付机制。
- **DSH 原生注入面（已知）**：
  1. 会话持久化 = DSH 自身：`$DSH_HOME/sessions/<key>/session-*.jsonl`（本轮实测：sesions 目录存在且按 app 写轮次）；
  2. **`dsh --profile tui --resume <session> [args...]`** = DSH 自带的 resume 通路（CLI help 证实；待实验：resume 后能否带消息、轮次是否写回同一会话文件、GUI 是否可见）；
  3. **扩展点 = cordis 插件 + webserver 路由注册插件**（dsh-host-webserver 包自述 "HTTP and upgrade routes" 注册；candidate：`/api/inject` + events 监听）——插件里再确认"向会话注入消息+唤醒 agent"的 host 内部服务/钩子是否存在；
  4. A2A 回话（桥）本身算 DSH 生态内部通道（B→A 用），负责"到达"，不负责"唤醒会话"。
- **收归后的分层**：记录（双库）· 到达（A2A 桥）· 唤醒/注入（DSH 内生：resume 或插件）· 呈现（GUI 会话本身）。各层解耦，外挂系统永不承载控制面。

## 10. 移交工作单（USER 裁定：本条线整体移交 DSH 优化 session）

> 本 session 不再实施。工程文件 = 本 md（§1-9 全量史实）；以下为带优先级的工作单，每项含验收。

**P0 —— 注入通路决定性实验（~20 分钟）**
- 执行 `dsh --profile tui --resume <session-id> [消息]`（可用测试会话）；观察 ①是否执行消息 ②`$DSH_HOME/sessions/<key>/session-*.jsonl` 是否追加轮次 ③GUI 打开该会话是否可见 ④tui profile 是否存在（缺则视部署决定）。
- 验收：注入消息被 agent 处理且**轮次持久化回同一会话文件** → 注入通路 = CLI resume；失败 → 转 P1-B 插件路径。
- 结果记回本文件。

**P1-A（若 P0 成功）—— resume 接线**
- A 侧接单 headless 收到 B 回话 → 读任务卡 → `dsh --profile tui --resume <sessionRef> "<自包含回话>"`。
- 任务卡：`$DSH_HOME/async-inbox/{taskId}.json`（outgoing/incoming：sessionRef/goal/ts/状态/结果——**DSH 自身目录，不落外挂库**）。
- 回话自包含模板：`{taskId, goal摘要, sessionRef, 结论}`（B 侧条款 + A 侧 join）。

**P1-B（若 P0 失败）—— cordis 插件注入**
- 新插件（如 `dsh-async-inbox`）：注册路由（复用 webserver 路由注册插件 + /api browser-trust 栅栏 + token）→ POST `/api/async/inject {sessionRef, message}` → 调 host 会话服务注入+唤醒+写回（需在插件内确认 host 暴露的会话服务/hook；未暴露则按最小扩展向上游申请或走 session 文件+唤醒等价实现）。
- 验收：与 P1-A 同。

**P1-C —— 配套（与 P0 并行可做）**
- B 侧 a2a-agent（LXC 39481）补 audit 落盘（对齐 MCP；否则 1 天后 taskId 失联——InMemoryTaskStore 实测重启即失）。
- `dsh-peer-mcp.service` 加 `Environment=PEER_HEADLESS_TIMEOUT_MS=86400000`（长任务不撞 30min 墙；A 侧 PC a2a-agent runHeadless timeout 参数化）。
- 超时/落盘/任务卡三者与现场已修（stateless + 清理）一起构成"B 长任务可跑、结果可回放、回话可注入"的最小闭环。

**P2 —— 机制层补齐（有资源再做）**
- B 服务器 execFile 回调（完成审计处）自动向 A 发回话（goal 含约定标记时）——把条款从任务文本移到机制层。
- PC 侧 `<PC_TAILSCALE_IP>:39480` peer server 对称 stateless（或 dsh-mcp-client 幂等重联）。
- deployed 版 `transports` Map 占位键泄漏一行修复（对齐 kit：stateless 分支不落 Map）。
- A2A v1.0 四要素客户端模板（§7）供 kit 旧脚本升级；`run-mcp.sh` 死代码标注/移除；token 环境变量化（`DSH_PEER_TOKEN`）与脱敏。
- trustedHosts 语义文档定性：`/api` 浏览器信任栅栏（web --help 原文；非 Host 头拦截；SPA 对任意 Host 均 200 属预期）。

**SOP 模板（建议同步落 addon-kit 文本）**
- A 发起长任务：goal 尾部固定条款「完成后：① 写本机双库记录 ② 回话 A（SendMessage→<PC_TAILSCALE_IP>:39481，体=任务卡+结论）」；A 出站即写任务卡。
- 回话体：`{taskId, goal 摘要, sessionRef, result}`——自包含，A 收单即重建上下文。
