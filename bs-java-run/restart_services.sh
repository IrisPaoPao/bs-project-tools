#!/bin/bash
# ============================================================
# 服务重启脚本
#
# 先调用 stop_services.sh 停止服务，再调用 start_services.sh 启动服务。
#
# 使用:
#   ./restart_services.sh --service <name|all>        # 指定服务
#   ./restart_services.sh --service <name|all> --skip-build
#   ./restart_services.sh --service <name|all> --nacos-host HOST --nacos-ns NS
#
# 环境变量（透传给子脚本）:
#   LOG_DIR, NACOS_HOST, NACOS_NAMESPACE
# ============================================================
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info()  { echo -e "${YELLOW}[INFO]${NC}  $*"; }
log_pass()  { echo -e "${GREEN}[OK]${NC}    $*"; }
log_fail()  { echo -e "${RED}[FAIL]${NC}  $*"; }

# ==================== 参数解析 ====================
SKIP_BUILD=false
SERVICE=""
NACOS_HOST=""
NACOS_NAMESPACE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --nacos-host) NACOS_HOST="$2"; shift ;;
        --nacos-ns)   NACOS_NAMESPACE="$2"; shift ;;
        --skip-build) SKIP_BUILD=true ;;
        --service)    SERVICE="$2"; shift ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
    shift
done

# --service 必填
if [ -z "$SERVICE" ]; then
    echo ""
    echo "错误: 必须指定 --service 参数"
    echo ""
    echo "使用方法:"
    echo "  ./restart_services.sh --service <name|all>"
    echo "  ./restart_services.sh --service <name|all> --skip-build"
    echo "  ./restart_services.sh --service <name|all> --nacos-host HOST --nacos-ns NS"
    echo ""
    exit 1
fi

# ==================== 主流程 ====================

echo "=========================================================="
echo "  重启服务: $SERVICE"
echo "  跳过构建: $SKIP_BUILD"
[ -n "$NACOS_HOST" ] && echo "  Nacos 主机: $NACOS_HOST"
[ -n "$NACOS_NAMESPACE" ] && echo "  Nacos 命名空间: $NACOS_NAMESPACE"
echo "=========================================================="
echo ""

# 1. 停止服务
log_info "停止服务 ..."
"${SCRIPT_DIR}/stop_services.sh" --service "$SERVICE"
log_pass "服务停止完成"

echo ""

# 2. 启动服务（透传 --skip-build, --nacos-host, --nacos-ns）
log_info "启动服务 ..."
START_ARGS=(--service "$SERVICE")
[ "$SKIP_BUILD" = true ] && START_ARGS+=(--skip-build)
[ -n "$NACOS_HOST" ] && START_ARGS+=(--nacos-host "$NACOS_HOST")
[ -n "$NACOS_NAMESPACE" ] && START_ARGS+=(--nacos-ns "$NACOS_NAMESPACE")
"${SCRIPT_DIR}/start_services.sh" "${START_ARGS[@]}"

echo ""
log_pass "重启流程完成"
