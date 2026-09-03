#!/bin/bash
# dsh-patch-kit / verify.sh（跨平台版）— 校验全部补丁 + 移动端选择器漂移检查
# 环境变量：DSH_PKG_ROOT、DSH_TRUSTED_HOST
set -e
PKG="${DSH_PKG_ROOT:-}"
if [ -z "$PKG" ]; then
  if [ -d /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai ]; then
    PKG=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules
  else
    PKG=/usr/lib/node_modules
  fi
fi
N="$PKG/@deepseek-ai"
HOST="${DSH_TRUSTED_HOST:-<YOUR_DOMAIN>.ts.net}"

check() { # name expected-file expected-pattern
  if grep -qF "$3" "$2" 2>/dev/null; then echo "[OK]   $1"; else echo "[MISS] $1 (pattern not found — DSH 升级或版本漂移，需重打或人工审查)"; return 1; fi
}

FAIL=0
check "01 服务端特权门解锁" "$N/dsh-client-connection/lib/index.js" 'PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, trustedHosts)' || FAIL=1
check "01b 237行loopback拦截器保持原样" "$N/dsh-client-connection/lib/index.js" 'interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, [])' || FAIL=1
check "02 客户端isLoopback" "$N/dsh-client-connection/lib/client.js" "pageLocation.hostname === \"$HOST\"" || FAIL=1
if [ "${DSH_NO_HEADLESS:-0}" = "1" ]; then
  echo "[SKIP] 03 openDocument无头降级（DSH_NO_HEADLESS=1：桌面环境不需要）"
else
  check "03 openDocument无头降级" "$N/dsh-host-apiproxy/lib/index.js" 'if (!canOpenPaths()) return ok(request, { opened: true });' || FAIL=1
fi

echo
echo '=== 移动端选择器漂移检查（05 注入依赖的哈希类名）==='
MOBILE_TOKENS=(
  "pI_x6G_sidebarCol|框架·侧边栏列(JS+CSS)"
  "pI_x6G_centerCol|框架·内容列(CSS)"
  "hHd-Xa_collapsed|侧边栏·折叠态(CSS :has + JS)"
  "hHd-Xa_toggle|侧边栏·收起按钮(JS)"
  "VOzbGW_panel|设置面板(CSS)"
  "VOzbGW_nav|设置面板·导航(CSS)"
  "VOzbGW_content|设置面板·内容(CSS)"
  "VOzbGW_header|设置面板·头部(CSS)"
  "VOzbGW_options|设置面板·滚动区(CSS)"
  "_portal_19372_43|菜单portal层级(CSS)"
)
for entry in "${MOBILE_TOKENS[@]}"; do
  token="${entry%%|*}"; label="${entry#*|}"
  if grep -rlF "$token" "$N" --include='*.js' --include='*.css' 2>/dev/null | head -1 >/dev/null; then
    echo "[OK]   $label ($token)"
  else
    echo "[DRIFT] $label ($token) 未找到 — 05-mobile-injection.sh 需重新适配该类名"
    FAIL=1
  fi
done

if [ "$FAIL" = "0" ]; then
  echo; echo 'ALL PATCHES IN PLACE — 服务端补丁在位，移动端选择器未漂移'
else
  echo; echo 'SOME CHECKS FAILED — 见上方 [MISS]/[DRIFT] 项处理'
fi
exit $FAIL
