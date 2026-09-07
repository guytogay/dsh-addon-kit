#!/usr/bin/env node
// patch-lan-mode.mjs — 内网模式：客户端 isLoopback 白名单 + crypto.randomUUID 安全兜底
// Usage: node patch-lan-mode.mjs <dsh-client-connection/lib/client.js> <host-or-ip> [more hosts...]
// USER 2026-09-07；幂等（dsh-lan-uuid 标记检查 + host 去重）；host 值不入补丁库（运行时传入）。
import { readFileSync, writeFileSync } from "node:fs";
const [target, ...hosts] = process.argv.slice(2);
if (!target || hosts.length === 0) { console.error("usage: node patch-lan-mode.mjs <client.js> <host> [more...]"); process.exit(1); }
let c = readFileSync(target, "utf8");
let changed = false;
// 1) isLoopback 白名单（在已有的 <domain> 追加行上扩展；兼容已有标记）
const linePat = /pageLocation\.hostname === "([^"]+)"$/m;
const lines = c.split("\n");
let foundLine = -1;
for (let i = lines.length - 1; i >= 0; i--) {
  if (/isLoopback:/.test(lines[i]) && /pageLocation\.hostname ===/.test(lines[i])) { foundLine = i; break; }
}
if (foundLine === -1) { console.error("ABORT: isLoopback line not found"); process.exit(1); }
const line = lines[foundLine];
let newLine = line;
for (const h of hosts) {
  if (!line.includes(JSON.stringify(h))) {
    newLine = newLine.replace(/(\.hostname\s*=== "[^"]+",)$/m, (mm, g) => `${mm.slice(0, -1)} || pageLocation.hostname === ${JSON.stringify(h)},`.slice(0, -0));
  }
}
// 上面写法易错，改明确拼接：
newLine = line;
for (const h of hosts) {
  const quoted = JSON.stringify(h);
  if (!newLine.includes(quoted)) {
    newLine = newLine.replace(/,$/, ` || pageLocation.hostname === ${quoted},`);
  }
}
if (newLine !== line) { lines[foundLine] = newLine; changed = true; }
c = lines.join("\n");
// 2) crypto.randomUUID -> randomUuid()（非安全上下文兜底）
if (!c.includes("dsh-lan-uuid")) {
  const a = 'id: MessageId(crypto.randomUUID())';
  const b = 'return RpcId(crypto.randomUUID());';
  let n = (c.split(a).length - 1) + (c.split(b).length - 1);
  if (n !== 2) { console.error(`ABORT: randomUUID sites find=${n} (expected 2)`); process.exit(1); }
  c = c.replace(a, "/* dsh-lan-uuid */ id: MessageId(randomUuid())").replace(b, "return RpcId(randomUuid());");
  changed = true;
}
if (!changed) { console.log("no change needed"); process.exit(0); }
writeFileSync(target, c);
console.log("patched OK (hosts: " + hosts.join(", ") + ")");
