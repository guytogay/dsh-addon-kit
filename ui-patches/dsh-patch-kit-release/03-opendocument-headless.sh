#!/bin/bash
# dsh-patch-kit / 03-opendocument-headless.sh（跨平台版）
# settings.openDocument 无头降级（无 DISPLAY/WSL 时返回 ok）。桌面环境不需要此补丁。
set -e
PKG="${DSH_PKG_ROOT:-}"
if [ -z "$PKG" ]; then
  if [ -d /usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai ]; then
    PKG=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules
  else
    PKG=/usr/lib/node_modules
  fi
fi
F="$PKG/@deepseek-ai/dsh-host-apiproxy/lib/index.js"

[ -f "$F" ] || { echo "FATAL: $F not found"; exit 1; }

ALREADY='if (!canOpenPaths()) return ok(request, { opened: true });'
if grep -qF "$ALREADY" "$F"; then
  echo 'already patched, skipping'
  exit 0
fi
grep -qF 'return openTextFile(request, path, signal);' "$F" || { echo "FATAL: openTextFile call not found — DSH version changed, manual review needed"; exit 1; }

cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"
sed -i 's/return openTextFile(request, path, signal);/if (!canOpenPaths()) return ok(request, { opened: true });\n                return openTextFile(request, path, signal);/' "$F"
grep -qF "$ALREADY" "$F" || { echo 'FATAL: patch verify failed'; exit 1; }
echo "patched: $F"
