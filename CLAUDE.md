# 🤖 Claude Code 项目能力总览

> **自动加载**: 本文件在打开 `bs-project-tools` 项目时自动注入 Agent 上下文，让 AI 第一时间知道有哪些工具可用。

---

## 📦 项目结构

```
bs-project-tools/
├── bs-jdbc-tool/    # 历史 JDBC 实现（数据库操作已迁至 usql）
├── bs-java-run/     # Java 服务运行管理（Node.js CLI + Playwright）
└── .mcp.json        # MCP 服务配置
```

---

## bs-java-run — Java 服务运行管理

服务启动、停止、构建、状态及 Token 操作遵循 `../zzq-agent-skills/bs-project-run/SKILL.md`，使用 `bs-java-run` CLI 或目标工作区的 `./javarun`。

- 服务、端口、依赖、环境和账号以目标工作区 `.bs-java-run/JAVARUN.md` 与 `JAVARUN.local.md` 为准，不使用本文中的历史清单或猜测值。
- `start` 默认只启动已有产物；需要构建时显式使用 `--build` 或 `up`。启动与重启须明确 `--env`。
- 登录和 Token 经 `login` / `token` 获取；不输出凭据或 Token，不直接读取 Token 缓存。
- 旧 `*_services.sh` 仅用于兼容，不作为 Agent 的推荐入口。配置缺失或目标环境不明确时，按 Skill 初始化/核对。

```bash
./javarun status
./javarun up <service> --env <env> --yes
./javarun restart <service> --env <env> --yes --build
```

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
