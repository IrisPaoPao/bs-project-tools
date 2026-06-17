#!/bin/bash
# ============================================================
# SAAS Industry 登录脚本
# 供 Agent 调用，自动完成登录并返回 Authorization Token
#
# 使用方式:
#   ./login.sh              # 有头模式（默认）
#   ./login.sh --headless   # 无头模式
#
# 输出:
#   JSON 格式的登录结果到 stdout
#   {
#     "success": true,
#     "token": "eyJ...",
#     "authorization": "eyJ...",
#     "lastLoginTime": "2026-06-10 21:09:38",
#     "pageUrl": "http://...#/portal",
#     "timestamp": "2026-06-10T..."
#   }
#
# 退出码:
#   0 - 登录成功
#   1 - 登录失败
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 运行 Node.js 登录脚本
node "$SCRIPT_DIR/login-script.js" "$@"
