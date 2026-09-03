// patch-fix3.mjs — whale button/edge: use pointerdown + retry fallback for reliable expand
// Usage: node patch-fix3.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix3.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) openSide(): pointerdown + verify-retry fallback
{
  const from = 'function openSide(){var s=document.querySelector(".pI_x6G_sidebarCol");var t=document.querySelector(".hHd-Xa_toggle");if(s&&t&&s.querySelector(".hHd-Xa_collapsed")){t.click()}}';
  const to = 'function openSide(){var s=document.querySelector(".pI_x6G_sidebarCol");var t=document.querySelector(".hHd-Xa_toggle");if(!s||!t)return;if(!s.querySelector(".hHd-Xa_collapsed"))return;t.click();setTimeout(function(){var s2=document.querySelector(".pI_x6G_sidebarCol");if(s2&&s2.querySelector(".hHd-Xa_collapsed")){var t2=document.querySelector(".hHd-Xa_toggle");if(t2)t2.click()}},250)}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('openSide retry: applied'); }
  else log.push('openSide retry: NOT FOUND');
}
// 2) bind pointerdown instead of click on both handlers
{
  const from = 'btn.addEventListener("click",openSide);var edge=document.createElement("div");edge.style.cssText="position:fixed;left:0;top:0;bottom:0;width:18px;z-index:1190;background:transparent";edge.setAttribute("aria-hidden","true");edge.addEventListener("click",openSide);';
  const to = 'btn.addEventListener("pointerdown",openSide);var edge=document.createElement("div");edge.style.cssText="position:fixed;left:0;top:0;bottom:0;width:18px;z-index:1190;background:transparent";edge.setAttribute("aria-hidden","true");edge.addEventListener("pointerdown",openSide);';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('pointerdown: applied'); }
  else log.push('pointerdown: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
