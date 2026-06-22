#!/bin/bash
# ============================================================
# 服务启动脚本（PropertiesLauncher 方式）
#
# 从 JAVARUN.md 的「服务定义」表自动解析服务列表。
# 使用 java -cp + PropertiesLauncher 从 WAR 包启动。
#
# 使用:
#   ./start_services.sh                         # 交互式选择
#   ./start_services.sh --service <name|all>    # 指定服务
#   ./start_services.sh --skip-build            # 跳过 mvn package
#   ./start_services.sh --nacos-host HOST
#   ./start_services.sh --nacos-ns NS
#
# 环境变量（优先级: 命令行 > 环境变量 > 默认值）:
#   LOG_DIR, NACOS_HOST, NACOS_NAMESPACE
# ============================================================
set -euo pipefail

# ==================== 项目配置 ====================
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
LOG_DIR="${LOG_DIR:-${SCRIPT_DIR}/logs}"
JAVARUN_MD="${SCRIPT_DIR}/JAVARUN.md"

# 公共 JVM 参数（所有服务共享）
COMMON_JVM_ARGS="-Dsaas.feign.context-path="

_SVC_NAMES=()
_SVC_ROOTS=()
_SVC_PORTS=()
_DEFAULT_NACOS_HOST=""
_DEFAULT_NACOS_NAMESPACE=""
_JAVA_HOME=""

# 展开 $HOME
expand_path() { local p="$1"; echo "${p/\$HOME/$HOME}"; }

# 从 JAVARUN.md 解析环境配置（Nacos 等，KEY=value 格式）
parse_env_config() {
    [ ! -f "$JAVARUN_MD" ] && return

    local next_is_java=false
    while IFS= read -r line; do
        # 解析 java 环境地址（标题后第一个非空行）
        if $next_is_java; then
            local jp=$(echo "$line" | xargs)
            if [[ -n "$jp" ]]; then
                _JAVA_HOME="$jp"
                next_is_java=false
            fi
            continue
        fi
        [[ "$line" =~ java.*环境地址 ]] && { next_is_java=true; continue; }

        line=$(echo "$line" | xargs)
        [[ -z "$line" ]] && continue
        case "$line" in
            NACOS_HOST=*)     _DEFAULT_NACOS_HOST="${line#NACOS_HOST=}" ;;
            NACOS_NAMESPACE=*) _DEFAULT_NACOS_NAMESPACE="${line#NACOS_NAMESPACE=}" ;;
        esac
    done < "$JAVARUN_MD"
}

# 从 JAVARUN.md 解析服务定义
parse_services() {
    local src="$JAVARUN_MD"
    if [ ! -f "$src" ]; then
        log_fail "JAVARUN.md 不存在: $src"
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

        local path=$(echo "$path_raw" | sed -n 's/.*`\(.*\)`.*/\1/p')
        [ -z "$path" ] && continue
        path=$(expand_path "$path")

        local port=$(echo "$port_raw" | xargs)
        [ -z "$port" ] && continue   # 基础组件，跳过

        _SVC_NAMES+=("$name")
        _SVC_ROOTS+=("$path")
        _SVC_PORTS+=("$port")
    done < "$src"

    if [ ${#_SVC_NAMES[@]} -eq 0 ]; then
        log_fail "JAVARUN.md 中没有配置端口的服务"
        exit 1
    fi
}

mkdir -p "$LOG_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info()  { echo -e "${YELLOW}[INFO]${NC}  $*"; }
log_pass()  { echo -e "${GREEN}[OK]${NC}    $*"; }
log_fail()  { echo -e "${RED}[FAIL]${NC}  $*"; }

# ==================== 参数解析 ====================
parse_env_config

# 优先级: 命令行 > 环境变量 > JAVARUN.md
NACOS_HOST="${NACOS_HOST:-$_DEFAULT_NACOS_HOST}"
NACOS_NAMESPACE="${NACOS_NAMESPACE:-$_DEFAULT_NACOS_NAMESPACE}"
SKIP_BUILD=false
SERVICE=""

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

# ==================== 工具函数 ====================

find_svc_idx() {
    local target=$1
    for i in "${!_SVC_NAMES[@]}"; do
        [ "${_SVC_NAMES[$i]}" = "$target" ] && { _SVC_IDX=$i; return 0; }
    done
    return 1
}

check_port() { lsof -i ":$1" -sTCP:LISTEN >/dev/null 2>&1; }

# 在项目根目录下自动发现 server 模块目录
find_server_module() {
    local root=$1 name=$2
    local default="${root}/${name}-server"
    [ -d "$default" ] && { echo "$name-server"; return 0; }
    # 兜底：找第一个 *-server 目录
    local found=$(ls -d "${root}/"*-server 2>/dev/null | head -1)
    [ -n "$found" ] && { basename "$found"; return 0; }
    echo ""
}

# ==================== 交互式选择 ====================
parse_services

if [ -z "$SERVICE" ]; then
    echo ""
    echo "=========================================================="
    echo "  可用服务"
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

# ==================== 核心函数 ====================

resolve_war() {
    local name=$1 server=$2 root=$3
    local war_glob="${root}/${server}/target/"*.war

    local matches=()
    for f in $war_glob; do
        [ -f "$f" ] && matches+=("$f")
    done

    if [ ${#matches[@]} -eq 0 ]; then
        log_fail "$name: 未找到 WAR 文件 (${root}/${server}/target/*.war)"
        return 1
    fi
    if [ ${#matches[@]} -gt 1 ]; then
        log_fail "$name: 找到多个 WAR 文件: ${matches[*]}"
        return 1
    fi

    _WAR_PATH="${matches[0]}"
    _WAR_DIR=$(cd "$(dirname "$_WAR_PATH")" && pwd)
    _WAR_NAME=$(basename "$_WAR_PATH")
    _EXPLODED="${_WAR_NAME%.war}"
}

build_service() {
    local name=$1 root=$2
    log_info "打包 $name (mvn clean package -DskipTests) ..."
    cd "$root"
    mvn -q -DskipTests clean package 2>&1 | tail -5
    log_pass "$name 打包完成"
}

start_service() {
    local name=$1 port=$2 root=$3

    local server=$(find_server_module "$root" "$name")
    [ -z "$server" ] && { log_fail "$name: 未找到 server 模块目录"; return 1; }

    resolve_war "$name" "$server" "$root" || return 1

    local war_dir="$_WAR_DIR" war_name="$_WAR_NAME" exploded="$_EXPLODED"
    local log_file="${LOG_DIR}/${name}.log"
    local pid_file="${LOG_DIR}/${name}.pid"

    if [ ! -d "${war_dir}/${exploded}" ]; then
        log_fail "exploded 目录不存在: ${war_dir}/${exploded}"
        return 1
    fi

    local java_bin="java"
    if [ -n "$_JAVA_HOME" ]; then
        java_bin="${_JAVA_HOME}/bin/java"
        if [ ! -x "$java_bin" ]; then
            log_fail "Java 不存在或不可执行: $java_bin"
            return 1
        fi
    fi

    log_info "启动 $name (端口 $port, Java: $java_bin) ..."
    cd "$war_dir"

    # 记录当前日志行数，用于 wait_ready 只检查本次启动的新内容
    _SVC_LOG_BASELINE=$(wc -l < "$log_file" 2>/dev/null || echo 0)

    nohup "$java_bin" -cp "$war_name" \
        -Dloader.path="${exploded}/WEB-INF/classes/,${exploded}/WEB-INF/lib/" \
        -Dserver.port="$port" \
        -Dfile.encoding=utf-8 \
        -DNACOS_HOST="$NACOS_HOST" \
        -DNACOS_NAMESPACE="$NACOS_NAMESPACE" \
        $COMMON_JVM_ARGS \
        org.springframework.boot.loader.PropertiesLauncher \
        >> "$log_file" 2>&1 &

    local pid=$!
    echo "$pid" > "$pid_file"
    log_info "  PID: $pid, 日志: $log_file"
}

wait_ready() {
    local name=$1 port=$2 max_wait=${3:-180} elapsed=0
    local pid_file="${LOG_DIR}/${name}.pid"
    local log_file="${LOG_DIR}/${name}.log"
    local baseline=${_SVC_LOG_BASELINE:-0}
    local pid=$(cat "$pid_file" 2>/dev/null || echo "")
    local stable_after_ready=5  # 端口+日志都满足后，再稳定多少秒

    log_info "等待 $name 就绪（端口监听 + Spring 容器就绪 + 稳定 ${stable_after_ready}s）..."

    # 错误标志：Spring Boot 装配中途失败的典型关键词
    local fatal_pattern='Application run failed|APPLICATION FAILED TO START|UnsatisfiedDependencyException|Exception encountered during context initialization|BeanCreationException'

    local ready_at=-1
    while [ $elapsed -lt $max_wait ]; do
        # 1. 进程必须活着
        if [ -n "$pid" ] && ! ps -p "$pid" >/dev/null 2>&1; then
            log_fail "$name 进程已退出 (PID $pid)，最近日志:"
            tail -30 "$log_file" | sed 's/^/    /'
            return 1
        fi

        # 2. 本次启动新日志中是否出现致命错误
        if [ -f "$log_file" ]; then
            local fatal=$(tail -n +$((baseline + 1)) "$log_file" | grep -E "$fatal_pattern" | head -1)
            if [ -n "$fatal" ]; then
                log_fail "$name 启动失败（日志中检测到致命错误）:"
                echo "    $fatal"
                return 1
            fi
        fi

        # 3. 端口 listening + 日志出现 Started ... → 进入"稳定观察"窗口
        local port_ok=false started_ok=false
        check_port "$port" && port_ok=true
        if [ -f "$log_file" ]; then
            tail -n +$((baseline + 1)) "$log_file" | grep -q "Started .* in [0-9.]* seconds" && started_ok=true
        fi

        if $port_ok && $started_ok; then
            if [ $ready_at -lt 0 ]; then
                ready_at=$elapsed
                log_info "  ${elapsed}s: 端口+Spring 容器就绪，观察 ${stable_after_ready}s 稳定性 ..."
            elif [ $((elapsed - ready_at)) -ge $stable_after_ready ]; then
                log_pass "$name 已就绪 (端口 $port, 总耗时 ${elapsed}s)"
                return 0
            fi
        else
            ready_at=-1  # 任一条件回退则重新计时
        fi

        sleep 2
        elapsed=$((elapsed + 2))
        [ $((elapsed % 10)) -eq 0 ] && log_info "  已等待 ${elapsed}s ... (port=$port_ok started=$started_ok)"
    done
    log_fail "$name 启动超时 (${max_wait}s)，请查看日志: $log_file"
    return 1
}

# ==================== 主流程 ====================

echo "=========================================================="
echo "  启动配置"
echo "  Nacos:       $NACOS_HOST / $NACOS_NAMESPACE"
echo "  Java:        ${_JAVA_HOME:-系统默认}"
echo "  启动服务:    $SERVICE"
echo "  日志目录:    $LOG_DIR"
echo "=========================================================="

# 1. 端口检查
log_info "检查端口占用 ..."
for i in "${!_SVC_NAMES[@]}"; do
    [ "$SERVICE" != "all" ] && [ "${_SVC_NAMES[$i]}" != "$SERVICE" ] && continue
    port="${_SVC_PORTS[$i]}"
    if check_port "$port"; then
        log_fail "端口 $port (${_SVC_NAMES[$i]}) 已被占用"
        lsof -i ":$port" -sTCP:LISTEN
        exit 1
    fi
done
log_pass "端口检查通过"

# 2. 构建
if [ "$SKIP_BUILD" != "true" ]; then
    echo ""
    for i in "${!_SVC_NAMES[@]}"; do
        [ "$SERVICE" != "all" ] && [ "${_SVC_NAMES[$i]}" != "$SERVICE" ] && continue
        build_service "${_SVC_NAMES[$i]}" "${_SVC_ROOTS[$i]}"
    done
else
    log_info "跳过构建 (--skip-build)"
fi

# 3. 启动
for i in "${!_SVC_NAMES[@]}"; do
    [ "$SERVICE" != "all" ] && [ "${_SVC_NAMES[$i]}" != "$SERVICE" ] && continue
    echo ""
    start_service "${_SVC_NAMES[$i]}" "${_SVC_PORTS[$i]}" "${_SVC_ROOTS[$i]}"
    wait_ready "${_SVC_NAMES[$i]}" "${_SVC_PORTS[$i]}"
done

# 4. 完成
echo ""
echo "=========================================================="
echo -e "  ${GREEN}服务启动完成!${NC}"
for i in "${!_SVC_NAMES[@]}"; do
    [ "$SERVICE" != "all" ] && [ "${_SVC_NAMES[$i]}" != "$SERVICE" ] && continue
    echo "  ${_SVC_NAMES[$i]}: http://127.0.0.1:${_SVC_PORTS[$i]}"
done
echo "  日志目录: $LOG_DIR"
echo ""
echo "  停止服务: ./stop_services.sh"
echo "=========================================================="
