// patch-fix18.mjs — whale button fixed at logo position always (no jumping), nudge -1,-1
// Usage: node patch-fix18.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix18.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) inline position: fixed at (5,13) — logo spot, nudged -1/-1
{
  const from = 'position:fixed;left:8px;top:max(env(safe-area-inset-top,0px) + 4px,8px);width:44px;height:44px';
  const to = 'position:fixed;left:5px;top:max(env(safe-area-inset-top,0px) + 4px,13px);width:44px;height:44px';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('inline pos: (5,13)'); }
  else log.push('inline pos: NOT FOUND');
}
// 2) sync: never touch position, only aria-label
{
  const from = 'function sync(){if(document.documentElement.hasAttribute("data-dsh-drawer")){btn.style.left="6px";btn.style.top="14px";btn.setAttribute("aria-label","收起侧边栏")}else{btn.style.left="8px";btn.style.top="8px";btn.setAttribute("aria-label","展开侧边栏")}btn.style.display="flex"}';
  const to = 'function sync(){btn.style.display="flex";btn.setAttribute("aria-label",document.documentElement.hasAttribute("data-dsh-drawer")?"收起侧边栏":"展开侧边栏")}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('sync: position-free'); }
  else log.push('sync: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
