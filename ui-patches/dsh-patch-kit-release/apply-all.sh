#!/bin/bash
# dsh-patch-kit / apply-all.sh — 一键重打全部补丁（幂等），随后重启 dsh-web 并验证
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

for p in "$DIR"/0[1-3]-*.sh; do
  echo "=== $(basename "$p") ==="
  bash "$p"
done

echo '=== 重启 dsh-web ==='
systemctl restart dsh-web
sleep 6
systemctl is-active dsh-web

echo '=== 验证 ==='
bash "$DIR/verify.sh"
echo APPLY-ALL-DONE
