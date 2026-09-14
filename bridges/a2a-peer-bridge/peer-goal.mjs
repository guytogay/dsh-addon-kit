// peer-goal.mjs — run_task / message goal 投递保真层
//
// 现场失败（真实观测，2026-09-13，<peer-dsh> → pc-dsh 通道）：
//   长任务卡被静默截断——原文 3056 字符（5994 B），接收侧只看到开头 2000 字符，
//   且切口落在词中间（"止于 8. **"），接收方无法判断是原文如此还是被截。
//   两处静默变更叠加：① 过滤器改写内容（反引号/换行 → 空格）；② 2000 字符硬切片。
//
// 本模块只做两件事，且都不改变既有投递语义（过滤器+切片逐字保持原行为）：
//   ① 让截断可见：报告 goalSourceChars（收到的原始长度）/ goalCharsKept /
//      goalTruncated / goalFilterApplied（过滤器是否改动了内容）；
//   ② 保真副本：原文（【过滤前】）落盘到 $DSH_HOME/peer-inbox/<taskId>.md，
//      只读、不执行、不参与 prompt；prompt 走的仍是过滤+切片那一份。
//
// 边界：spill 存过滤前原文——若存过滤后的串，反引号与换行已经变成空格，
// 保真度仍然丢失（现场侧 2026-09-13 第 3 通细化 a）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 上限与过滤器：与线上既有实现同值同形（契约 v1.3→v1.6.1 实绩）。
// 切片按 UTF-16 code unit 计（JS String.prototype.slice 语义），与字节数无关。
export const GOAL_CHAR_LIMIT = 2000;
export const CONTEXT_CHAR_LIMIT = 4000;
export const WORKSPACE_CHAR_LIMIT = 500;

const CONTROL_CHARS = /["`^<>&|;%!]/g;
const NEWLINES = /\r?\n/g;

// 过滤器：命令控制符 → 空格；换行 → 空格。行为与线上完全一致。
// 注意（2026-09-13 由扇出会话独立复核纠正，我方已自证）：`/\r?\n/` 把 CRLF **对**整体匹配成
// **一个**空格 —— 每处换行净 **−1** 字符（不是"CRLF 变两个空格"）。实测：49 处 CRLF 的 388 字符
// → 339 字符（−49，空格数 +49）；`"a\r\nb"` → `"a b"`（3 字符）。控制符替换是 1:1，不改长度。
// 故"过滤后同长"只可能出现在文本已被 LF 归一化（如文本模式读盘）之后。
export function filterGoal(text) {
  return String(text ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(NEWLINES, ' ');
}

export function spillDir() {
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
  return path.join(home, 'peer-inbox');
}

// 只读保真副本。写失败必须可见（返回 error，绝不静默吞掉）。
export function writeGoalSpill(taskId, rawGoal, meta = {}) {
  const file = path.join(spillDir(), `${String(taskId).replace(/[^A-Za-z0-9_.-]/g, '_')}.md`);
  const raw = String(rawGoal ?? '');
  const header = [
    '# peer run_task spill —— 过滤前原文（保真副本）',
    '',
    '本文件是投递方所发 goal 的**过滤前**原文，供接收侧取件核对。',
    '它**不是**指令来源、不参与 prompt、不被执行：进 prompt 的那一份经过',
    '命令控制符过滤与 2000 字符切片（见 peer-goal.mjs）。',
    '',
    `- taskId: ${taskId}`,
    `- 原文: ${raw.length} 字符 / ${Buffer.byteLength(raw, 'utf8')} 字节`,
    `- 过滤后: ${meta.filteredChars} 字符 / ${meta.filteredBytes} 字节 (goalFilterApplied=${meta.filterApplied})`,
    `- 投递: ${meta.keptChars} 字符 (goalTruncated=${meta.truncated}, 上限 ${GOAL_CHAR_LIMIT})`,
    `- 落盘理由: ${meta.spillReason}`,
    `- 落盘: ${new Date().toISOString()}`,
    '',
    '--- 原文开始（逐字，未过滤） ---',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(spillDir(), { recursive: true });
    fs.writeFileSync(file, header + raw + '\n', 'utf8');
    return { file, error: null };
  } catch (e) {
    return { file, error: String(e && e.message ? e.message : e) };
  }
}

// 投递准备：过滤 → 切片 → 计算可见性字段 → （需要时）落盘保真副本。
// 返回值里的 safe 就是交给 `dsh` 的那一份。
export function prepareGoal(taskId, rawGoal, { spill = true } = {}) {
  const raw = String(rawGoal ?? '');
  const filtered = filterGoal(raw);
  const kept = filtered.slice(0, GOAL_CHAR_LIMIT);
  const filteredBytes = Buffer.byteLength(filtered, 'utf8');
  const truncated = filtered.length > GOAL_CHAR_LIMIT;
  const meta = {
    goalSourceChars: raw.length,
    goalCharsIn: filtered.length,
    goalCharsKept: kept.length,
    goalTruncated: truncated,
    // 过滤是否改动了内容：控制符替换是 1:1（等长），换行是 CRLF 对 → 一个空格（每处 −1），
    // 所以长度**不能**当判据（等长也可能已被改写，如 `"` → 空格）；必须逐字符比对。
    goalFilterApplied: filtered !== raw,
    goalFilteredBytes: filteredBytes,
    goalSpillPath: null,
    goalSpillError: null,
    goalSpillReason: null,
  };
  // 落盘判据 = **原文**超过上限，不是"过滤后是否被切"：过滤本身（控制符/换行 → 空格）
  // 也能把一条超长原文压到上限以内，此时内容同样已被改写；只按 truncated 落盘会漏掉
  // 这一支，保真副本就出现缺口。原文没超上限则无需副本——进 prompt 的那份已含全文。
  if (spill && raw.length > GOAL_CHAR_LIMIT) {
    meta.goalSpillReason = truncated ? 'goal_truncated_at_limit' : 'filter_rewrote_raw_over_limit';
    const { file, error } = writeGoalSpill(taskId, raw, {
      filteredChars: filtered.length,
      filteredBytes,
      filterApplied: meta.goalFilterApplied,
      keptChars: kept.length,
      truncated,
      spillReason: meta.goalSpillReason,
    });
    if (error) meta.goalSpillError = error;
    else meta.goalSpillPath = file;
  }
  return { safe: kept, meta };
}
