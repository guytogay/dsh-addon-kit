// probe-fidelity.mjs — 投递保真探针（无 spawn、无网络）
// 目的：证明 prepareGoal 的【过滤+切片】结果与线上既有实现逐字相同（行为未变），
// 且新增的可见性字段/保真副本满足现场侧 2026-09-13 第 3 通的三条细化。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// 直接引用**线上同一份**模块（不是副本）：探针若引用副本，就只是自证副本一致。
import { prepareGoal, filterGoal, GOAL_CHAR_LIMIT, spillDir } from '../../upstream/peer-mcp/peer-goal.mjs';

// —— 参照实现：线上 v1.6.1 的逐字副本（改动前行为） ——
const legacy = (goal) => String(goal || '')
  .replace(/["`^<>&|;%!]/g, ' ')
  .replace(/\r?\n/g, ' ')
  .slice(0, 2000);

const cases = {
  // 现场第 5 条实测：3250 字符含 CRLF/反引号/竖线 → 2000 字符 / 4184 字节
  'mixed-crlf-backtick-pipe': Array.from({ length: 50 }, (_, i) => `现场观测回执 #${i} \`code\` |x|`).join('\r\n'),
  // 3000 汉字 → 2000 字符 / 6000 字节（探针用例 A）
  'cjk-3000': '现场观测回执'.repeat(500),
  // 3000 ASCII → 2000 字符（探针用例 B）
  'ascii-3000': 'x'.repeat(3000),
  // 控制符把超长原文压到上限以内（旧落盘判据会漏掉这一支）
  'filter-shrinks-below-limit': ('a"'.repeat(1200)),
  // 短文本但都含结构字符（不应落盘，但过滤可见性必须报 true）
  'short-filtered': 'task: use `goal` and\nnewline',
  // 恰好等于上限（不应报截断）
  'exactly-2000': 'y'.repeat(2000),
  // 空 / null
  'empty': '',
  'null': null,
};

const results = [];
const taskId = 'probe-' + Date.now().toString(36);
for (const [name, input] of Object.entries(cases)) {
  const { safe, meta } = prepareGoal(taskId, input);
  // ① 行为不变：与旧实现逐字相同
  assert.equal(safe, legacy(input), `filter+slice drifted for case ${name}`);
  // ② 可见性字段与事实一致
  const raw = String(input ?? '');
  const filtered = filterGoal(raw);
  assert.equal(meta.goalSourceChars, raw.length, `${name}: goalSourceChars`);
  assert.equal(meta.goalCharsIn, filtered.length, `${name}: goalCharsIn`);
  assert.equal(meta.goalCharsKept, safe.length, `${name}: goalCharsKept`);
  assert.equal(meta.goalTruncated, filtered.length > GOAL_CHAR_LIMIT, `${name}: goalTruncated`);
  assert.equal(meta.goalFilterApplied, filtered !== raw, `${name}: goalFilterApplied`);
  // ③ 保真副本：原文超上限必有（含被过滤压到上限以内的那一支）
  if (raw.length > GOAL_CHAR_LIMIT) {
    assert.ok(meta.goalSpillPath, `${name}: expected spill for raw ${raw.length} chars`);
    assert.equal(meta.goalSpillError, null, `${name}: spill error`);
    const text = fs.readFileSync(meta.goalSpillPath, 'utf8');
    // 头部与正文之间的空行会在写盘时变成 CRLF，正文保持原文的换行风格：
    // 先统一切成 \n 再取 marker 行的下一行起，避免把空行当正文首行（首版探针在此处差一行）。
    const lines = text.split(/\r?\n/);
    const markerIdx = lines.findIndex((l) => l.startsWith('--- 原文开始'));
    if (markerIdx < 0) throw new Error(`${name}: spill marker not found`);
    const body = lines.slice(markerIdx + 1).join('\n').replace(/\n$/, '');
    assert.equal(body, raw, `${name}: spill body must equal pre-filter raw verbatim`);
  } else {
    assert.equal(meta.goalSpillPath, null, `${name}: no spill expected`);
  }
  results.push({
    case: name,
    rawChars: raw.length,
    rawBytes: Buffer.byteLength(raw, 'utf8'),
    filteredChars: filtered.length,
    filteredBytes: Buffer.byteLength(filtered, 'utf8'),
    keptChars: safe.length,
    truncated: meta.goalTruncated,
    filterApplied: meta.goalFilterApplied,
    spillReason: meta.goalSpillReason,
    spill: meta.goalSpillPath ? path.basename(meta.goalSpillPath) : null,
  });
}

console.log(JSON.stringify({
  ok: true,
  verdict: 'prepareGoal filter+slice byte-identical to legacy; visibility fields and pre-filter spill verified',
  goalCharLimit: GOAL_CHAR_LIMIT,
  spillDir: spillDir(),
  legacyCheck: 'assert.equal(safe, legacy(input)) passed for all cases',
  cases: results,
}, null, 2));
