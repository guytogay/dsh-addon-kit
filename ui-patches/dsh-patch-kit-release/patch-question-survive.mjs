#!/usr/bin/env node
// patch-question-survive.mjs — 提问框刷新/慢回复生存补丁（USER 2026-09-07）
// 用法: node patch-question-survive.mjs <client.js-path>
// 效果: handleDisconnected 不再删除 question/requested 帧（保留 approval 原逻辑），
//       使刷新/网络抖动后待答提问卡可由缓冲帧重建（服务端 mux 重放为补充）。
// 幂等: 已含 dsh-q-survive 标记则跳过。变化仅一行 filter + 注释；node --check 通过。
import { readFileSync, writeFileSync } from "node:fs";
const target = process.argv[2];
if (!target) { console.error("usage: node patch-question-survive.mjs <client.js>"); process.exit(1); }
const raw = readFileSync(target, "utf8");
if (raw.includes("dsh-q-survive")) { console.log("already patched, skip"); process.exit(0); }
const old = 'const kept = buffer.filter((item) => item.payload.type !== "approval/requested" && item.payload.type !== "question/requested");';
const marker = "/* dsh-q-survive: keep question/requested frames across disconnect (refresh/slow-reply survival for the ask-user card); approval still dropped as before — mux-open replay re-adds both while the run lives. */\n";
const count = raw.split(old).length - 1;
if (count !== 1) { console.error(`ABORT: expected 1 occurrence, got ${count}`); process.exit(1); }
const next = raw.replace(old, marker + 'const kept = buffer.filter((item) => item.payload.type !== "approval/requested");');
writeFileSync(target, next);
console.log("patched OK");