#!/bin/bash
# ============================================================
# 服务停止脚本
#
# 从 JAVARUN.md 解析服务列表，支持 PID 文件停止 + 端口兜底。
#
# 使用:
#   ./stop_services.sh                         # 交互式选择
#   ./stop_services.sh --service <name|all>    # 指定服务
#   ./stop_services.sh --skip-pid              # 跳过 PID 文件，直接按端口清理
#
# 环境变量: LOG_DIR
# ============================================================
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
LOG_DIR="${LOG_DIR:-${SCRIPT_DIR}/logs}"

_SVC_NAMES=()
_SVC_PORTS=()

# 从 JAVARUN.md 解析服务定义（与 start_services.sh 一致）
parse_services() {
    local src="${SCRIPT_DIR}/JAVARUN.md"
    if [ ! -f "$src" ]; then
        echo "JAVARUN.md 不存在: $src"
        exit 1
    fi

    local in_table=false
    while IFS= read -r line; do
        [[ "$line" =~ ^\|[[:space:]]*服务名 ]] && { in_table=true; continue; }
        [[ "$line" =~ ^\|[-[:space:]]+\| ]] && continue
        $in_table || continue
        [[ "$line" =~ ^\| ]] || break

        IFS='|' read -r _ name_raw path_raw port_raw _ <<< "$line"

        local name=$(echo "$name_raw" | xargs | sed 's/`//g')
        [ -z "$name" ] && continue

        local port=$(echo "$port_raw" | xargs)
        [ -z "$port" ] && continue   # 基础组件，可跳过

        _SVC_NAMES+=("$name")
        _SVC_PORTS+=("$port")
    done < "$src"

    if [ ${#_SVC_NAMES[@]} -eq 0 ]; then
        echo "JAVARUN.md 中没有配置端口的服务"
        exit 1
    fi
}

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info()  { echo -e "${YELLOW}[INFO]${NC}  $*"; }
log_pass()  { echo -e "${GREEN}[OK]${NC}    $*"; }
log_fail()  { echo -e "${RED}[FAIL]${NC}  $*"; }

# ==================== 参数解析 ====================
SKIP_PID=false
SERVICE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-pid) SKIP_PID=true ;;
        --service)  SERVICE="$2"; shift ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
    shift
done

find_svc_idx() {
    local target=$1
    for i in "${!_SVC_NAMES[@]}"; do
        [ "${_SVC_NAMES[$i]}" = "$target" ] && { _SVC_IDX=$i; return 0; }
    done
    return 1
}

stop_by_pid() {
    local name=$1
    local pid_file="${LOG_DIR}/${name}.pid"
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null && log_pass "$name (PID $pid) 已停止"
        else
            log_info "$name (PID $pid) 进程不存在"
        fi
        rm -f "$pid_file"
    else
        log_info "$name: 无 pid 文件"
    fi
}

stop_by_port() {
    local name=$1 port=$2
    local pids=$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)
    if [ -n "${pids:-}" ]; then
        log_info "$name 端口 $port 仍有进程: ${pids}，发送 SIGTERM ..."
        echo "$pids" | xargs kill 2>/dev/null || true
        sleep 3
        # 还没死的用 SIGKILL
        pids=$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)
        if [ -n "${pids:-}" ]; then
            log_info "  进程仍存活，发送 SIGKILL ..."
            echo "$pids" | xargs kill -9 2>/dev/null || true
        fi
    fi
}

# ==================== 交互式选择 ====================
parse_services

if [ -z "$SERVICE" ]; then
    echo ""
    echo "=========================================================="
    echo "  停止服务"
    echo "=========================================================="
    for i in "${!_SVC_NAMES[@]}"; do
        printf "  %s) %-30s  端口: %s\n" \
            "$((i+1))" "${_SVC_NAMES[$i]}" "${_SVC_PORTS[$i]}"
    done
    echo "  a)  全部服务"
    echo "  q)  退出"
    echo ""
    read -r -p "请选择: " choice

    case "$choice" in
        q|Q) echo "已取消"; exit 0 ;;
        a|A) SERVICE="all" ;;
        *)  if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#_SVC_NAMES[@]}" ]; then
                SERVICE="${_SVC_NAMES[$((choice-1))]}"
            else
                echo "无效选择: $choice"; exit 1
            fi ;;
    esac
fi

if [ "$SERVICE" != "all" ]; then
    if ! find_svc_idx "$SERVICE"; then
        echo "无效 --service=$SERVICE"
        echo -n "可用值: all"
        for name in "${_SVC_NAMES[@]}"; do echo -n ", $name"; done
        echo ""; exit 1
    fi
fi

# ==================== 主流程 ====================

echo "停止服务 ..."
echo ""

for i in "${!_SVC_NAMES[@]}"; do
    [ "$SERVICE" != "all" ] && [ "${_SVC_NAMES[$i]}" != "$SERVICE" ] && continue
    name="${_SVC_NAMES[$i]}"
    port="${_SVC_PORTS[$i]}"

    # 先按 PID 文件停止
    if [ "$SKIP_PID" != "true" ]; then
        stop_by_pid "$name"
    fi
    # 兜底：按端口清理
    stop_by_port "$name" "$port"
done

echo ""
echo "完成"
