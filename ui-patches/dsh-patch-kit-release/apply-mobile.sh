#!/bin/bash
# dsh-patch-kit / apply-mobile.sh — 应用移动端层（兜底手搓方案 05；PWA-only 用 04）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/05-mobile-injection.sh"
echo MOBILE-LAYER-DONE
