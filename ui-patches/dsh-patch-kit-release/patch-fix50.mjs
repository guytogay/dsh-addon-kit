// patch-fix50.mjs — precise session-item match: aria-label exactly 会话"…"的操作 (no false positives)
// Usage: node patch-fix50.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix50.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'if(t&&t.closest&&t.closest("[aria-label^=\\"会话\\"]")){document.documentElement.removeAttribute("data-dsh-drawer")}';
const to = 'if(t&&t.closest){var sel=t.closest("[aria-label]");if(sel&&/^会话".*"的操作$/.test(sel.getAttribute("aria-label")||"")){document.documentElement.removeAttribute("data-dsh-drawer")}}';
if (!h.includes(from)) { console.error('session matcher NOT FOUND'); process.exit(1); }
if (h.includes('sel.getAttribute("aria-label")||""')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('precise session match: applied');
