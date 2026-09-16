# 🤖 Claude Code 项目能力总览

> **自动加载**: 本文件在打开 `bs-project-tools` 项目时自动注入 Agent 上下文，让 AI 第一时间知道有哪些工具可用。

---

## 📦 项目结构

```
bs-project-tools/
├── bs-jdbc-tool/    # 历史 JDBC 实现（数据库操作已迁至 usql）
├── bs-java-run/     # Java 服务运行管理（Shell 脚本 + Playwright）
└── .mcp.json        # MCP 服务配置
```

---

## 🚀 bs-java-run — Java 服务运行管理

**不是 MCP 工具**，需通过 Bash 直接调用脚本。

### 可做的事情

| 操作 | 脚本 | 说明 |
|------|------|------|
| 构建服务 | `bs-java-run/build_services.sh` | Maven 打包所有本地 Java 服务 |
| 启动服务 | `bs-java-run/start_services.sh` | 启动所有本地 Java 服务（默认不构建） |
| 停止服务 | `bs-java-run/stop_services.sh` | 停止所有本地 Java 服务 |
| 重启服务 | `bs-java-run/restart_services.sh` | 重启所有本地 Java 服务（默认不构建） |
| 查看状态 | `bs-java-run/status_services.sh` | 查看服务运行状态 |
| 自动登录 | `bs-java-run/login.sh` | Playwright 模拟浏览器登录，获取 Token |

### 本地服务列表

| 服务名 | 路径 | 端口 |
|--------|------|------|
| `saas-data-gateway` | `../vasService/saas-data-gateway/` | 81 |
| `saas-reconciliation-business` | `../vasService/saas-reconciliation-business/` | 82 |
| `saas-ybld-rpa` | `../vasService/saas-ybld-rpa/` | 83 |

### 登录使用方式

支持多环境、多账户，配置在 `bs-java-run/JAVARUN.md`（共享）或 `JAVARUN.local.md`（本机私有）的「登录环境」+「登录账户」表。

```bash
# 有头模式，交互选择账户
cd bs-java-run && ./login.sh

# 无头模式 + 指定账户
cd bs-java-run && ./login.sh --headless --account dev-001

# 快速获取 token（用上次账户，免交互，每次重新登录不缓存）
cd bs-java-run && node bin/bs-java-run.js token --quiet
```

登录成功后会输出 JWT Token 并自动复制到剪贴板，`authorization` 请求头直接使用（无需加 Bearer 前缀）。

> ⚠️ 登录接口参数经过前端加密，无法用 curl 明文调用，必须通过 Playwright 脚本。

---

## 数据库操作 — usql

数据库操作统一使用源 Skill `../zzq-agent-skills/bs-database-query/SKILL.md` 和上游 `usql`。业务 Skill 负责表关系和过滤范围；数据库 Skill 负责环境定位、连接及结果核对，支持查询与已授权的 DML/DDL。

- 未指定连接时，按运行环境 → Nacos 数据源 → usql 连接 → 当前库/schema → 表归属定位，不能按历史别名猜库。旧别名中的连字符迁为下划线，以实际映射为准。
- 非交互查询使用 `usql -X -w -q -J -v ON_ERROR_STOP=1 '<已核对连接名>' -c 'SELECT ...'`；复杂单条查询使用 `-f`。行数限制写在目标方言 SQL 中。
- 凭据使用本机 usql 原生私有配置，文件权限 0600；不输出账号、密码或完整连接串，连接清单只展示别名与驱动。
- 单条 SELECT 的 `-J` 结果为行对象数组；同时检查退出码与输出，不能把失败当作空结果。大整数 ID 和精确金额在 SQL 中转为字符列。
- 每次 CLI 调用是独立连接。多语句事务使用 `-1 -v ON_ERROR_STOP=1` 并通过标准输入传入脚本；0.21.4 的 `-1 -f` 已复现事务失效，禁止用于原子执行。事务范围还须核对目标数据库、表引擎、跨分片与 DDL 隐式提交行为。
- 查询示例和排查不构成写入授权；已授权的建表、改表、索引及数据变更按实际方言执行并核对结果。
- `bs-jdbc-tool/` 仅保留历史源码和原配置，不再作为默认数据库入口，也不继续新增功能。IRIS 使用 ODBC 版 usql、`libirisodbcuw35.so` 和命名 DSN，调用时设置 `ODBCINI="$HOME/.odbc.ini"`；namespace 使用 `SELECT $NAMESPACE` 核对。网络或驱动错误按实际证据报告，不自动回退或伪装类型。

项目内旧 JDBC MCP 注册已停用。全局客户端配置及已安装 Skills 由用户同步；移除旧 `bs-jdbc-query` 安装入口，安装 `bs-database-query` 及关联业务 Skills 后在新任务验证触发。
