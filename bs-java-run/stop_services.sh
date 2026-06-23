#!/bin/bash
# ============================================================
# 服务停止脚本（兼容包装）
# 已迁移至 bs-java-run CLI，此脚本为向后兼容保留
# ============================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/bin/bs-java-run.js" stop "$@"
