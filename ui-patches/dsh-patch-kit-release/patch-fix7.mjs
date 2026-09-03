// patch-fix7.mjs — open = translateX(0) (transition-safe); dialog open = kill transition + transform none
// Usage: node patch-fix7.mjs <index.html>
import fs from 'node:fs';

const [, , htmlPath] = process.argv;
if (!htmlPath) { console.error('usage: node patch-fix7.mjs <index.html>'); process.exit(1); }

let h = fs.readFileSync(htmlPath, 'utf8');
const log = [];

// 1) open rule: translateX(0) instead of none (transition to none is broken in Chrome)
{
  const from = 'html[data-dsh-drawer="open"] .pI_x6G_sidebarCol{transform:none!important}';
  const to = 'html[data-dsh-drawer="open"] .pI_x6G_sidebarCol{transform:translateX(0)!important}';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('open rule: translateX(0)'); }
  else log.push('open rule: NOT FOUND');
}
// 2) dialog observer: include settings panel class; kill transition while dialog open
{
  const from = 'new MutationObserver(function(){var dlg=document.querySelector("[role=dialog],[aria-modal=true]");var s=sb();if(dlg){if(s)s.style.transform="none"}else if(s){s.style.transform="";s.style.zIndex="";s.style.display=""}}).observe(document.documentElement,{childList:true,subtree:true})';
  const to = 'new MutationObserver(function(){var dlg=document.querySelector("[role=dialog],[aria-modal=true],.VOzbGW_panel");var s=sb();if(dlg){if(s){s.style.transition="none";s.style.transform="none"}}else if(s){s.style.transform="";s.style.zIndex="";s.style.display="";s.style.transition=""}}).observe(document.documentElement,{childList:true,subtree:true})';
  if (h.includes(from)) { h = h.split(from).join(to); log.push('dialog observer: +panel class, transition kill'); }
  else log.push('dialog observer: NOT FOUND');
}
fs.writeFileSync(htmlPath, h);
console.log('index.html:', log.join(' | '));
