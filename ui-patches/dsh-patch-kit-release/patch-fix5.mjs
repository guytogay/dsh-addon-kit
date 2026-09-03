// patch-fix5.mjs — bigger/inward whale button (avoid edge gesture zone) + fullscreen settings panel
// Usage: node patch-fix5.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix5.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) whale button: inward + larger + touch-action (keep below status bar)
{
  const from = 'btn.style.cssText="position:fixed;left:4px;top:max(env(safe-area-inset-top,0px) + 8px,44px);width:38px;height:38px;border-radius:10px;background:rgba(28,28,34,.88);border:1px solid rgba(255,255,255,.12);color:#d5d9e0;display:none;align-items:center;justify-content:center;z-index:1195;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35)"';
  const to = 'btn.style.cssText="position:fixed;left:14px;top:max(env(safe-area-inset-top,0px) + 8px,44px);width:44px;height:44px;border-radius:12px;background:rgba(28,28,34,.88);border:1px solid rgba(255,255,255,.12);color:#d5d9e0;display:none;align-items:center;justify-content:center;z-index:1195;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);touch-action:manipulation"';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('button: 44px inward'); }
  else log.push('button style: NOT FOUND');
}
// 2) remove the edge hotspot element entirely
{
  const from = 'var edge=document.createElement("div");edge.style.cssText="position:fixed;left:0;top:0;bottom:0;width:18px;z-index:1190;background:transparent";edge.setAttribute("aria-hidden","true");edge.addEventListener("pointerdown",openDr);';
  if (h.includes(from)) { h = h.split(from).join(''); log.push('edge hotspot: removed'); }
  else log.push('edge hotspot: NOT FOUND');
  const from2 = '(function mount(){var b=document.body;if(!b){return setTimeout(mount,50)}b.appendChild(btn);b.appendChild(edge)})()';
  const to2 = '(function mount(){var b=document.body;if(!b){return setTimeout(mount,50)}b.appendChild(btn)})()';
  if (h.includes(from2)) { h = h.split(from2).join(to2); log.push('mount: btn only'); }
  else log.push('mount: NOT FOUND');
}
// 3) settings/dialog open: sidebar transform none (restore fixed children to viewport)
{
  const from = 'if(dlg){if(s)s.style.zIndex="50"}else if(s){s.style.zIndex="";s.style.display=""}';
  const to = 'if(dlg){if(s)s.style.transform="none"}else if(s){s.style.transform="";s.style.zIndex="";s.style.display=""}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('dialog: sidebar transform none'); }
  else log.push('dialog observer: NOT FOUND');
}
// 4) settings panel above sidebar
{
  const from = '.VOzbGW_panel{position:fixed;inset:0;width:100%;height:100%;max-width:100vw;max-height:100vh;max-height:100dvh;border-radius:0;flex-direction:column}';
  const to = '.VOzbGW_panel{position:fixed;inset:0;width:100%;height:100%;max-width:100vw;max-height:100vh;max-height:100dvh;border-radius:0;flex-direction:column;z-index:1300}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('panel: z-index 1300'); }
  else log.push('panel css: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
