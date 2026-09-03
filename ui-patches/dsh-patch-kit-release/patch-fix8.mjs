// patch-fix8.mjs — recognize the REAL settings panel (.VOzbGW_overlay) and fullscreen it
// Usage: node patch-fix8.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix8.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) observer: also match .VOzbGW_overlay (the real settings panel root; role=presentation)
{
  const from = 'document.querySelector("[role=dialog],[aria-modal=true],.VOzbGW_panel")';
  const to = 'document.querySelector("[role=dialog],[aria-modal=true],.VOzbGW_panel,.VOzbGW_overlay")';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('observer: +.VOzbGW_overlay'); }
  else log.push('observer: NOT FOUND');
}
// 2) fullscreen the overlay (viewport-relative once sidebar transform is none)
{
  const anchor = '.VOzbGW_panel{position:fixed;inset:0;width:100%;height:100%;max-width:100vw;max-height:100vh;max-height:100dvh;border-radius:0;flex-direction:column;z-index:1300}';
  const add = 'html .pI_x6G_sidebarCol .VOzbGW_overlay{position:fixed!important;left:0!important;right:0!important;top:0!important;bottom:0!important;width:auto!important;max-width:none!important;z-index:1300!important}';
  if (h.includes(anchor)) {
    if (h.includes('.VOzbGW_overlay{position:fixed;inset:0;width:100%')) { log.push('overlay css: already present'); }
    else { h = h.split(anchor).join(anchor + add); log.push('overlay css: fullscreen'); }
  } else log.push('panel anchor: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
