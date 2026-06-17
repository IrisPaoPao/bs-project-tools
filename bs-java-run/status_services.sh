#!/bin/bash
# ============================================================
# 服务状态查询脚本
#
# 从 JAVARUN.md 解析服务列表，查询 PID、端口、日志状态。
#
# 使用:
#   ./status_services.sh                         # 查询所有服务
#   ./status_services.sh --service <name|all>    # 指定服务
#
# 环境变量: LOG_DIR
# ============================================================
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
LOG_DIR="${LOG_DIR:-${SCRIPT_DIR}/logs}"
JAVARUN_MD="${SCRIPT_DIR}/JAVARUN.md"

_SVC_NAMES=()
_SVC_PORTS=()

# 从 JAVARUN.md 解析服务定义
parse_services() {
    if [ ! -f "$JAVARUN_MD" ]; then
        echo "JAVARUN.md 不存在: $JAVARUN_MD"
        exit 1
    fi

    local in_table=false
    while IFS= read -r line; do
        [[ "$line" =~ ^\|[[:space:]]*服务名 ]] && { in_table=true; continue; }
        [[ "$line" =~ ^\|[-[:space:]]+\| ]] && continue
        [ "$in_table" = true ] || continue
        [[ "$line" =~ ^\| ]] || break

        IFS='|' read -r _ name_raw path_raw port_raw _ <<< "$line"

        local name
        name=$(echo "$name_raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/`//g')
        [ -z "$name" ] && continue

        local port
        port=$(echo "$port_raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        [ -z "$port" ] && continue   # 端口为空，跳过

        _SVC_NAMES+=("$name")
        _SVC_PORTS+=("$port")
    done < "$JAVARUN_MD"

    if [ ${#_SVC_NAMES[@]} -eq 0 ]; then
        echo "JAVARUN.md 中没有配置端口的服务"
        exit 1
    fi
}

# 查找服务索引
find_svc_idx() {
    local target=$1
    for i in "${!_SVC_NAMES[@]}"; do
        [ "${_SVC_NAMES[$i]}" = "$target" ] && { _SVC_IDX=$i; return 0; }
    done
    return 1
}

# 获取 PID 状态
get_pid_state() {
    local name=$1
    local pid_file="${LOG_DIR}/${name}.pid"

    if [ ! -f "$pid_file" ]; then
        echo "no-pid-file"
        return
    fi

    local pid
    pid=$(tr -d '[:space:]' < "$pid_file")
    if [ -z "$pid" ]; then
        echo "empty-pid-file"
        return
    fi

    if kill -0 "$pid" 2>/dev/null; then
        echo "alive:$pid"
    else
        echo "dead:$pid"
    fi
}

# 获取端口状态
get_port_state() {
    local port=$1
    local listener_pids
    listener_pids=$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)

    if [ -z "${listener_pids:-}" ]; then
        echo "not-listening"
    else
        local flat_listener_pids
        flat_listener_pids=$(echo "$listener_pids" | tr '\n' ',' | sed 's/,$//')
        echo "listening:$flat_listener_pids"
    fi
}

# 获取日志文件路径
get_log_path() {
    local name=$1
    local log_file="${LOG_DIR}/${name}.log"

    if [ -f "$log_file" ]; then
        echo "$log_file"
    else
        echo "N/A"
    fi
}

# ==================== 参数解析 ====================
SERVICE="all"

while [ $# -gt 0 ]; do
    case "$1" in
        --service)  SERVICE="$2"; shift ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
    shift
done

parse_services

if [ "$SERVICE" != "all" ]; then
    if ! find_svc_idx "$SERVICE"; then
        echo "无效 --service=$SERVICE"
        echo -n "可用值: all"
        for name in "${_SVC_NAMES[@]}"; do echo -n ", $name"; done
        echo ""; exit 1
    fi
fi

# ==================== 输出表格 ====================
printf "%-30s %-6s %-20s %-25s %s\n" "SERVICE" "PORT" "PID" "PORT_STATE" "LOG"
printf "%s\n" "----------------------------------------------------------------------------------------------------"

for i in "${!_SVC_NAMES[@]}"; do
    [ "$SERVICE" != "all" ] && [ "${_SVC_NAMES[$i]}" != "$SERVICE" ] && continue

    name="${_SVC_NAMES[$i]}"
    port="${_SVC_PORTS[$i]}"

    pid_state=$(get_pid_state "$name")
    port_state=$(get_port_state "$port")
    log_path=$(get_log_path "$name")

    printf "%-30s %-6s %-20s %-25s %s\n" "$name" "$port" "$pid_state" "$port_state" "$log_path"
done
