#!/bin/bash
# dsh-patch-kit / 05-mobile-injection.sh（跨平台版，兜底移动端层）
# 环境变量：DSH_PKG_ROOT、ICON_SRC（默认 /root/apple-touch-icon.png）、
#          DSH_APP_TITLE（默认 DSH）、DSH_THEME（默认 #0e1116）
# 安全规范：单行标记删除（绝不 sed 区间）、落盘前 <body> 完整性守卫、systemctl 可用则重启。
set -e
PKG="${DSH_PKG_ROOT:-}"
if [ -z "$PKG" ]; then
  if [ -d /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai ]; then
    PKG=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules
  else
    PKG=/usr/lib/node_modules
  fi
fi
D="$PKG/@deepseek-ai/dsh-web-frontend/dist"
F=$D/index.html
ICON_SRC="${ICON_SRC:-/root/apple-touch-icon.png}"
TITLE="${DSH_APP_TITLE:-DSH}"
THEME="${DSH_THEME:-#0e1116}"
MARKER='dsh-mobile-opt'

[ -f "$F" ] || { echo "FATAL: $F not found"; exit 1; }
if grep -q "$MARKER" "$F" && [ "${FORCE:-0}" != "1" ]; then
  echo 'already injected, skipping (FORCE=1 强制重注入)'
  exit 0
fi

cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"

if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$D/apple-touch-icon.png"
fi

sed -i '/dsh-mobile-opt/d' "$F"
sed -i '/dsh-mobile-settings/d' "$F"

cat > /tmp/mobile-v4-block.html <<'EOF'
<!-- dsh-mobile-opt --><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><meta name="theme-color" content="__THEME__" /><meta name="apple-mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" /><meta name="apple-mobile-web-app-title" content="__TITLE__" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><style>html{-webkit-text-size-adjust:100%}html,body{touch-action:manipulation}@media(max-width:768px){body{overflow-x:hidden;padding-bottom:env(safe-area-inset-bottom,0px)}input,textarea,select{font-size:16px!important}}@media(display-mode:standalone){body{padding-top:env(safe-area-inset-top,0px)}}@media(max-width:768px){.pI_x6G_frame{grid-template-columns:100%!important}.pI_x6G_sidebarCol{position:fixed!important;top:0;bottom:0;left:0;z-index:1200;width:min(84vw,320px)!important;box-shadow:0 0 24px rgba(0,0,0,.35)}.pI_x6G_sidebarCol:has(.hHd-Xa_collapsed){width:54px!important;box-shadow:none}.pI_x6G_frame:has(.pI_x6G_sidebarCol .hHd-Xa_collapsed) .pI_x6G_centerCol{padding-left:56px!important}.pI_x6G_sidebarCol .hHd-Xa_root{width:100%!important}.pI_x6G_detailsCol,.pI_x6G_handle{display:none!important}.pI_x6G_sidebarCol .hHd-Xa_toggle+[role=tooltip]{left:auto!important;right:10px!important;top:14px!important;max-width:calc(100vw - 20px)!important}._portal_19372_43{z-index:1300!important}.VOzbGW_panel{position:fixed;inset:0;width:100%;height:100%;max-width:100vw;max-height:100vh;max-height:100dvh;border-radius:0;flex-direction:column}.VOzbGW_nav{width:100%;flex-direction:row;gap:6px;padding:8px 10px;overflow-x:auto;flex:none}.VOzbGW_navTitle{display:none}.VOzbGW_navList{flex-direction:row;gap:4px;flex:none}.VOzbGW_navCell{height:36px;padding:0 12px;white-space:nowrap;flex:none}.VOzbGW_content{min-width:0;width:100%;min-height:0;overflow:hidden}.VOzbGW_header{position:absolute;top:0;right:0;height:auto;padding:6px 10px;z-index:6}.VOzbGW_options{padding:0 14px 20px;overscroll-behavior:contain}}</style><script>(function(){if(window.innerWidth>768)return;function sb(){return document.querySelector(".pI_x6G_sidebarCol")}function open(){var s=sb();return !!s&&!s.querySelector(".hHd-Xa_collapsed")}function closeDrawer(){var t=document.querySelector(".hHd-Xa_toggle");if(t)t.click()}document.addEventListener("click",function(e){if(!open())return;var s=sb();if(s&&s.contains(e.target))return;if(e.target.closest&&e.target.closest("[role=dialog],[role=menu],[role=listbox],[role=alertdialog],[aria-modal=true]"))return;closeDrawer()},true);new MutationObserver(function(){var dlg=document.querySelector("[role=dialog],[aria-modal=true]");var s=sb();if(dlg){if(s)s.style.zIndex="50"}else if(s){s.style.zIndex="";s.style.display=""}}).observe(document.documentElement,{childList:true,subtree:true})})();</script><!-- /dsh-mobile-opt -->
EOF

# 注入品牌参数（标题/主题色）
sed -i "s|__TITLE__|$TITLE|g; s|__THEME__|$THEME|g" /tmp/mobile-v4-block.html

LINE=$(grep -n '</head>' "$F" | head -1 | cut -d: -f1)
{ head -n $((LINE-1)) "$F"; cat /tmp/mobile-v4-block.html; tail -n +"$LINE" "$F"; } > "$F.new"

grep -q '<body' "$F.new" || { echo 'FATAL: body missing, aborting'; exit 1; }
grep -q "$MARKER" "$F.new" || { echo 'FATAL: marker missing, aborting'; exit 1; }
mv "$F.new" "$F"
echo "injected: $F"

if command -v systemctl >/dev/null 2>&1; then
  systemctl restart dsh-web 2>/dev/null || systemctl restart dsh 2>/dev/null || true
  sleep 6
  echo "service active: $(systemctl is-active dsh-web 2>/dev/null || echo n/a)"
else
  echo 'systemctl 不可用（桌面/WSL 环境），跳过自动重启 — 请手动重启 dsh web 使注入生效'
fi
