#!/bin/bash
# ============================================================
# 服务构建脚本（兼容包装）
# ============================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/bin/bs-java-run.js" build "$@"
