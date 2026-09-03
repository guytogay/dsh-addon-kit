#!/bin/bash
# dsh-patch-kit / 02-settings-unlock-client.sh（跨平台版）
# 客户端 isLoopback 门：让 settings 镜像在 trusted-host 域名下也读取配置文档。
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
F="$PKG/@deepseek-ai/dsh-client-connection/lib/client.js"
HOST="${DSH_TRUSTED_HOST:-<YOUR_DOMAIN>.ts.net}"

[ -f "$F" ] || { echo "FATAL: $F not found"; exit 1; }

ORIG='isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'
PATCHED="isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname) || pageLocation.hostname === \"$HOST\","
if grep -qF "$PATCHED" "$F"; then
  echo 'already patched, skipping'
  exit 0
fi
grep -qF "$ORIG" "$F" || { echo "FATAL: isLoopback line not found — DSH version changed, manual review needed"; exit 1; }

cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
sed -i "s|isLoopbackHostname(pageLocation.hostname),|isLoopbackHostname(pageLocation.hostname) || pageLocation.hostname === \"$HOST\",|" "$F"
grep -qF "$PATCHED" "$F" || { echo 'FATAL: patch verify failed'; exit 1; }
echo "patched: $F (trusted host: $HOST)"
