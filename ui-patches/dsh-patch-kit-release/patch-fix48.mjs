// patch-fix48.mjs — disable tap highlight (no blue flash) + 300ms debounce on whale toggle
// Usage: node patch-fix48.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix48.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) no tap highlight / focus ring on the whale button
{
  const anchor = 'button[aria-label="展开侧边栏"] svg,button[aria-label="收起侧边栏"] svg{width:24px!important;height:17.66px!important;flex:none!important}';
  const add = 'button[aria-label="展开侧边栏"],button[aria-label="收起侧边栏"]{-webkit-tap-highlight-color:transparent;outline:none}';
  if (h.includes(anchor)) {
    if (h.includes('-webkit-tap-highlight-color:transparent;outline:none}')) { log.push('tap-highlight: already'); }
    else { h = h.split(anchor).join(anchor + add); log.push('tap-highlight: disabled'); }
  } else log.push('size anchor: NOT FOUND');
}
// 2) debounce openDr (300ms)
{
  const from = 'function openDr(){var e=document.documentElement;if(e.hasAttribute("data-dsh-drawer")){e.removeAttribute("data-dsh-drawer")}else{e.setAttribute("data-dsh-drawer","open")}}';
  const to = 'var lastTap=0;function openDr(){var now=Date.now();if(now-lastTap<300)return;lastTap=now;var e=document.documentElement;if(e.hasAttribute("data-dsh-drawer")){e.removeAttribute("data-dsh-drawer")}else{e.setAttribute("data-dsh-drawer","open")}}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('debounce: 300ms'); }
  else log.push('openDr: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
