#!/bin/bash
# dsh-patch-kit / 04-mobile-pwa.sh（可选）— 移动端 PWA 小件注入：apple-touch-icon / theme-color / viewport-fit。
# 用途：当选定的移动端轮子不提供 PWA 时补上（dsh-mobile、dsh-web-mobile 均无 PWA；dsh-ui-mobile 自带）。
# 内容锚定：单行标记注入 dist/index.html（绝不使用 sed 区间；落盘前校验 <body> 完整性；改后重启）。
# 幂等：标记存在则跳过。
set -e
D=/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist
F=$D/index.html
MARKER='dsh-mobile-pwa'

[ -f "$F" ] || { echo "FATAL: $F not found"; exit 1; }
if grep -q "$MARKER" "$F"; then
  echo 'already injected, skipping'
  exit 0
fi

cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)"

# 图标（upstream/apple-touch-icon.png 需先上传到 /root/）
if [ -f /root/apple-touch-icon.png ]; then
  cp /root/apple-touch-icon.png "$D/apple-touch-icon.png"
fi

cat > /tmp/mobile-pwa-block.html <<'EOF'
<!-- dsh-mobile-pwa --><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><meta name="theme-color" content="#0e1116" /><meta name="apple-mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" /><meta name="apple-mobile-web-app-title" content="DSH" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><!-- /dsh-mobile-pwa -->
EOF

LINE=$(grep -n '</head>' "$F" | head -1 | cut -d: -f1)
{ head -n $((LINE-1)) "$F"; cat /tmp/mobile-pwa-block.html; tail -n +"$LINE" "$F"; } > "$F.new"

grep -q '<body' "$F.new" || { echo 'FATAL: body missing, aborting'; exit 1; }
grep -q "$MARKER" "$F.new" || { echo 'FATAL: marker missing, aborting'; exit 1; }
mv "$F.new" "$F"

systemctl restart dsh-web
sleep 6
systemctl is-active dsh-web
echo "injected: $F"
