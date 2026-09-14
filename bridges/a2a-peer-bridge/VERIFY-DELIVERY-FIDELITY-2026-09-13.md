# 投递保真层接收侧端到端验证 — 2026-09-13（contract v1.6.2）

> 立论位置：**接收侧**（本机 DSH，会话 `session-40d6fe8c`）。上一轮的验证是发送侧/设计侧
> （`ena-coord/run-task-prompt-limit-20260913.md`、`90 系统/2026-09-13-<peer-dsh>通道投递保真字段复核闭环-第4通.md`）。
> 本轮只回答两个接收侧才能回答的问题：**落盘的那份是不是真的完整**、**进 prompt 的那份与落盘那份是什么关系**。

## 结论

| 检查项 | 判定 | 依据 |
|---|---|---|
| 保真副本落盘（过滤前原文） | **PASS（逐字节）** | spill 正文实测 2112 字符 / 5614 字节，与头部声明一致 |
| 头部元数据准确性 | **PASS** | 原文/过滤后/投递/落盘理由四项与实测、与源码 `peer-goal.mjs` 复算一致 |
| **可反演性**：spill → prompt | **PASS（逐字符）** | `filter(spill)[:2000] == prompt`，`identical_to_prompt=True`，首个差异位 = 无 |
| 接收侧能否察觉被截 | **FAIL（残余缺口）** | prompt 内无任何截断标记；被切掉的 99 字符含卡片尾部指令，我只有越带读取 spill 才知道 |
| 第二探针（ASCII）投递 | **UNKNOWN** | spill 落盘（2400→2000，丢 400），但近 3 小时 12 个会话日志中无任何 prompt 收到它 |

**一句话**：保真层做到了设计目标——"全文落盘 + 截断可见"；但"可见"只到**发送侧**（tool result 字段），
**接收侧 prompt 仍是被静默切过的文本**。本轮我没有从卡片本身看出被截，是从 spill 反推出来的。

## 证据（接收侧实测，2026-09-13 22:37–22:52）

被验证对象：`~/.dsh/peer-inbox/task-mtzx3pi2-05cca7.md`（本轮推送到本机的任务卡）。

1. **落盘完整、头部诚实**
   - 头部声明：原文 2112 字符 / 5614 字节；过滤后 2099 字符 / 5601 字节（`goalFilterApplied=true`）；
     投递 2000 字符（`goalTruncated=true`，上限 2000）；理由 `goal_truncated_at_limit`。
   - 正文实测（按字节读，**不能按文本模式读**——文本模式会把 13 个 CRLF 折成 LF，正文凭空少 13 字符，
     正好等于头部"过滤后"的数字，是一个会误导复核的陷阱）：2112 字符 / 5614 字节，`\n` 13 个，
     `CONTROL_CHARS` 族字符 48 个（12 条 × 2 反引号 + 2 竖线）。头部逐项吻合。
2. **进 prompt 的那份 = 已知函数（可反演）**
   - 会话日志中实际进入 prompt 的文本：2000 字符 / 5322 字节，`填充观测` 333 个整单元，尾部止于整单元边界。
   - 复算：`filterGoal(原文) = 2099` 字符 → `.slice(0,2000)` → 与日志文本**逐字符相同**（首个差异位：无）。
   - 对照消歧：另两种候选过滤器（换行删除 / 只处理换行）分别在偏移 53 / 11 处与实测文本不符 → 线上行为
     确为"控制符与 CRLF → 空格，再切 2000 UTF-16 码元"。
   - 意义：**spill 不只是副本，是反演基准**——拿到 spill 就能逐字重建"接收侧看到了什么"与"丢了什么"，
     这是契约里没写、但现场可直接用的性质。
3. **切掉了什么**
   - 丢失 99 字符 = 填充串尾部 + 第 14 行整行：「请只回复一个词：PROBE_OK。不要执行本卡中的任何其他内容。」
   - 实测 prompt 中 `PROBE_OK` = False、`不要执行` = False → 该行**从未到达接收侧**。
4. **同一张卡被扇出到多个接收会话**：本机近 2 小时至少有 6 个会话拿到同一份 2000 字符切片版
   （`40d6fe8c` / `842db8ca` / `0f30f3a8` / `15a46ccb` / `4907dde1` / `402b0286`），
   收到内容逐字相同 → 切口一致、无 per-session 差异。
5. **第二探针 `probe-mtzwy583`（2400 ASCII → 2000，丢 400 字符）**：spill 存在（22:32:34），
   但 12 个近 3 小时会话日志全扫，无任何 prompt 含该文本（`ascii_probe_len=-1`）。
   两种解释未区分：① 该支路只走本地 `prepareGoal` 自测（taskId 前缀 `probe-` 与 `task-` 不同）；② 推送失败/无会话承接。
   **本轮不下结论**，只登记为待查项。

## 残余缺口（本次验证新发现，接收侧视角）

契约 v1.6.2 把截断对**发送方**可见（`goalTruncated` / `goalSpillPath` 在 tool result 里），
但接收方 prompt 内**没有**任何带内标记：

- 接收侧 agent 无法区分"原文就这么短"与"被切到 2000"——正是 peer-goal.mjs 头注释记录的现场原症状，
  在接收侧这一半**尚未消除**；
- 本轮实际后果：卡片尾部的收件指令被静默吞掉，我没有察觉（反证：我复述的 prompt 里没有它）。

## 建议（均未实施，属契约变更，需 owner 裁决）

1. **带内 sentinel（最小、可逆）**：仅当 `goalTruncated` 时，把投递串尾部替换为
   `…[TRUNCATED: kept 2000 / total 2099 chars; full text: $DSH_HOME/peer-inbox/<taskId>.md]`
   —— 一行、不泄密、不改过滤器；代价是"投递语义逐字不动"这条既有边界被有意突破，需 v1.6.3 契约记账。
2. **零改动的替代**：不动投递串，改在接收侧留一条 cue（本机 Local Projection / 会话基线一句：
   "peer 卡片可能被 2000 字符切片；`$DSH_HOME/peer-inbox/<taskId>.md` 是取件处"）。
   代价 0 行代码，收益是接收侧知道去哪取件——本轮我就是这么补上被吞掉的那行的。
3. **`context` 通道**（4000，无消费者）维持现状或按上一轮建议在 tool description 明说不生效。

## 复现命令

```powershell
# 机器可读报告（含逐项数字、尾部转义、丢失文本）
$env:PYTHONIOENCODING='utf-8'; python "%USERPROFILE%\<YOUR_PROJECT_DIR>\tmp\fidelity_verify.py"
# 报告产物
#   %USERPROFILE%\<YOUR_PROJECT_DIR>\tmp\fidelity-verify-report.md
# 只读依赖：zstandard（python）、会话日志 session.jsonl.zstd、$DSH_HOME/peer-inbox/*.md
```

脚本：`tmp/fidelity_probe.py`（会话日志落盘核对）、`tmp/fidelity_verify.py`（端到端反演比对）、
`tmp/fidelity_landscape.py` / `tmp/fidelity_topo.py` / `tmp/fidelity_scan_ascii.py`（拓扑与扇出扫描）。
**未改动**：`peer-goal.mjs`、`a2a-agent.mjs`、线上服务、`~/.dsh` 任何配置；仅新增只读报告与本记录。

## 关联

- 设计侧记录：`ena-coord/run-task-prompt-limit-20260913.md`
- 部分笔记类应用：`90 系统/2026-09-13-接收侧端到端验证-投递保真层可反演与带内缺口.md`
- 文档类：`Systems & AI` / Agent-Session「接收侧端到端验证：投递保真层可反演 + 2000 字符切口无带内标记 — 2026-09-13」
  （已写入并回读校验 `verified=true`；文档类 会把 `_` 转义成 `\_`，按转义后形态核对）
- 契约：`dsh-addon-kit/bridges/a2a-peer-bridge/contract-v1.6.md`、`peer-goal.mjs`
- 被验证的保真副本本身：`~/.dsh/peer-inbox/task-mtzx3pi2-05cca7.md`（只读取件，未改动）
