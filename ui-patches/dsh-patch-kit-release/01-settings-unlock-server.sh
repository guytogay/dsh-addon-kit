#!/bin/bash
# dsh-patch-kit / 01-settings-unlock-server.sh（跨平台版）
# 服务端特权方法门解锁：PRIVILEGED_METHODS 门从空信任表改为部署 trustedHosts。
# 环境变量：DSH_PKG_ROOT（默认 /usr/lib/node_modules，兼容服务器与桌面两种布局）
set -e
PKG="${DSH_PKG_ROOT:-}"
if [ -z "$PKG" ]; then
  if [ -d /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai ]; then
    PKG=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules
  else
    PKG=/usr/lib/node_modules
  fi
fi
F="$PKG/@deepseek-ai/dsh-client-connection/lib/index.js"

[ -f "$F" ] || { echo "FATAL: $F not found (DSH_PKG_ROOT=$PKG)"; exit 1; }

ALREADY='PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, trustedHosts)'
if grep -qF "$ALREADY" "$F"; then
  echo 'already patched, skipping'
  exit 0
fi

ORIG='PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, [])'
grep -qF "$ORIG" "$F" || { echo "FATAL: gate line not found in original form — DSH version changed, manual review needed"; exit 1; }

cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
# 注意：替换必须保留 ! 逻辑取反（\1!isTrustedApiRequest...），否则门控语义反转
sed -i 's/\(PRIVILEGED_METHODS.has(method) && \)!isTrustedApiRequest(request, \[\])/\1!isTrustedApiRequest(request, trustedHosts)/' "$F"
grep -qF "$ALREADY" "$F" || { echo 'FATAL: patch verify failed'; exit 1; }
echo "patched: $F"
