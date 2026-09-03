// patch-fix52.mjs — match the session ROW (role=treeitem containing a 会话… button), not the hidden button
// Usage: node patch-fix52.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix52.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const from = 'if(t&&t.closest){var sel=t.closest("[aria-label]");if(sel&&/^会话.*的操作$/.test(sel.getAttribute("aria-label")||"")){document.documentElement.removeAttribute("data-dsh-drawer")}}';
const to = 'if(t&&t.closest){var row=t.closest("[role=treeitem]");if(row&&row.querySelector("[aria-label^=\\"会话\\"]")){document.documentElement.removeAttribute("data-dsh-drawer")}}';
if (!h.includes(from)) { console.error('session matcher NOT FOUND'); process.exit(1); }
if (h.includes('var row=t.closest("[role=treeitem]")')) { console.log('already patched'); process.exit(0); }
h = h.split(from).join(to);
fs.writeFileSync(htmlPath, h);
console.log('row-based session match: applied');
