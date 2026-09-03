// patch-edge.mjs — mobile: fully hide sidebar off-screen + left-edge hotspot to restore
// Usage: node patch-edge.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-edge.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) replace collapsed-state CSS: 54px rail -> fully off-screen
{
  const from = '.pI_x6G_sidebarCol:has(.hHd-Xa_collapsed){width:54px!important;box-shadow:none}';
  const to = '.pI_x6G_sidebarCol:has(.hHd-Xa_collapsed){transform:translateX(-100%)!important;width:0!important;box-shadow:none}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('css: full-hide'); }
  else log.push('css full-hide: NOT FOUND');
}
// 2) center column no longer needs rail padding when collapsed
{
  const from = '.pI_x6G_frame:has(.pI_x6G_sidebarCol .hHd-Xa_collapsed) .pI_x6G_centerCol{padding-left:56px!important}';
  const to = '.pI_x6G_frame:has(.pI_x6G_sidebarCol .hHd-Xa_collapsed) .pI_x6G_centerCol{padding-left:0!important}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('css: full-width'); }
  else log.push('css full-width: NOT FOUND');
}
// 3) slide transition on the drawer itself
{
  const from = '.pI_x6G_sidebarCol{position:fixed!important;top:0;bottom:0;left:0;z-index:1200;width:min(84vw,320px)!important;box-shadow:0 0 24px rgba(0,0,0,.35)}';
  const to = '.pI_x6G_sidebarCol{position:fixed!important;top:0;bottom:0;left:0;z-index:1200;width:min(84vw,320px)!important;box-shadow:0 0 24px rgba(0,0,0,.35);transition:transform .18s ease}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('css: slide transition'); }
  else log.push('css transition: NOT FOUND');
}
// 4) replace the old auto-collapse script with observer version + left-edge hotspot
{
  const start = '<!-- dsh-auto-collapse -->';
  const end = '<!-- /dsh-auto-collapse -->';
  const s = h.indexOf(start);
  const e = h.indexOf(end);
  if (s === -1 || e === -1) { log.push('old script: NOT FOUND'); }
  else {
    const snippet = `<!-- dsh-auto-collapse --><script>(function(){if(window.innerWidth>768)return;var done=false;function tc(){if(done)return;var s=document.querySelector(".pI_x6G_sidebarCol");var t=document.querySelector(".hHd-Xa_toggle");if(!s||!t)return;if(!s.querySelector(".hHd-Xa_collapsed")){t.click();done=true}}setTimeout(tc,800);setTimeout(tc,3000);setTimeout(tc,8000);setTimeout(tc,15000);var mo=new MutationObserver(tc);mo.observe(document.documentElement,{childList:true,subtree:true});setTimeout(function(){mo.disconnect()},20000);var e=document.createElement("div");e.style.cssText="position:fixed;left:0;top:0;bottom:0;width:18px;z-index:1190;background:transparent";e.setAttribute("aria-hidden","true");e.addEventListener("click",function(){var s=document.querySelector(".pI_x6G_sidebarCol");var t=document.querySelector(".hHd-Xa_toggle");if(s&&t&&s.querySelector(".hHd-Xa_collapsed")){t.click()}});document.body.appendChild(e)})();</script><!-- /dsh-auto-collapse -->`;
    h = h.slice(0, s) + snippet + h.slice(e + end.length);
    log.push('script: observer + edge hotspot');
  }
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
