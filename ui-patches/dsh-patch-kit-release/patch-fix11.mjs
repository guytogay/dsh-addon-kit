// patch-fix11.mjs — whale button: corner position, translucent idle, clear on press
// Usage: node patch-fix11.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix11.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) button style: left 8px (corner), idle opacity .45 + transition
{
  const from = 'btn.style.cssText="position:fixed;left:14px;top:max(env(safe-area-inset-top,0px) + 8px,44px);width:44px;height:44px;border-radius:12px;background:rgba(28,28,34,.88);border:1px solid rgba(255,255,255,.12);color:#d5d9e0;display:none;align-items:center;justify-content:center;z-index:1195;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);touch-action:manipulation"';
  const to = 'btn.style.cssText="position:fixed;left:8px;top:max(env(safe-area-inset-top,0px) + 8px,44px);width:44px;height:44px;border-radius:12px;background:rgba(28,28,34,.88);border:1px solid rgba(255,255,255,.12);color:#d5d9e0;display:none;align-items:center;justify-content:center;z-index:1195;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);touch-action:manipulation;opacity:.45;transition:opacity .18s"';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('style: corner + opacity .45'); }
  else log.push('button style: NOT FOUND');
}
// 2) clear on press, fade back after release
{
  const from = 'btn.addEventListener("pointerdown",openDr);';
  const to = 'btn.addEventListener("pointerdown",function(){btn.style.opacity="1"});btn.addEventListener("pointerup",function(){setTimeout(function(){btn.style.opacity=".45"},500)});btn.addEventListener("pointerleave",function(){btn.style.opacity=".45"});btn.addEventListener("pointerdown",openDr);';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('opacity interactions: added'); }
  else log.push('pointerdown hook: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
