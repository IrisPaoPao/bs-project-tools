# JDBC MCP Tool 设计文档

## 目标

在 `bs-jdbc-tool` 下新增一个本地 Claude Code MCP Server，让 agent 可以根据数据库别名执行 JDBC SQL。该工具需要支持 MySQL、TDSQL、Oracle，并为后续支持人大金仓、达梦等 JDBC 兼容数据库预留扩展能力。

## 已确认决策

- 使用 Node.js 实现 MCP stdio server，作为 agent 侧入口。
- 使用 Java JDBC executor 负责数据库连接和 SQL 执行。
- 数据库别名、连接信息和驱动配置写入本地配置文件。
- 数据库密码直接明文写入本地配置文件。
- 允许执行 DML，但是否允许由配置控制。
- 初始配置包含一个 MySQL 库和一个 Oracle 库，密码用占位符预留，由用户手动填写。
- JDBC 驱动优先从 DataGrip 本地驱动目录复制最新版本使用：`/Users/zhangzhengqing/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers`。
- 工具定位为本地 Claude Code 使用，不作为高并发服务。

## 整体架构

```text
Claude Code / Agent
        │
        │ MCP stdio
        ▼
bs-jdbc-tool Node MCP Server
        │
        ├─ 读取 config.local.json
        ├─ 根据 alias 命中数据库配置
        ├─ 校验 tool 参数、行数限制、超时限制
        └─ 调用 Java JDBC executor 子进程
                  │
                  ├─ 加载 JDBC driver jar
                  ├─ 通过 DriverManager 建立连接
                  ├─ 执行 SQL / PreparedStatement
                  └─ 向 stdout 输出 JSON 结果
        │
        ▼
MCP tool result 返回给 agent
```

### Node MCP Server 职责

- 注册 MCP tools：
  - `list_databases`
  - `describe_database`
  - `jdbc_test_connection`
  - `jdbc_query`
- 加载和校验配置文件。
- 根据 `alias` 查找数据库配置。
- 所有返回给 agent 的内容都隐藏密码。
- 调用 Java 前校验 SQL、最大行数和超时时间。
- 启动 Java executor 子进程，并传递 JSON 请求。
- 解析 Java executor 的 JSON 输出。
- 将进程错误、配置错误、执行错误包装成结构化 MCP 结果。

### Java JDBC Executor 职责

- 从 stdin 或进程参数读取一份 JSON 请求。
- 加载 `driverJars` 和 `driverClass`。
- 使用 `jdbcUrl`、`username`、`password` 建立 JDBC 连接。
- 执行连接测试、查询语句和更新语句。
- 绑定 `PreparedStatement` 参数。
- 设置查询超时。
- 返回查询元数据、行数据、更新行数、执行耗时和结构化错误。

## 目录结构

```text
bs-jdbc-tool/
  package.json
  README.md
  .gitignore
  config.example.json
  config.local.json          # 本地真实配置，忽略提交
  src/
    server.js
    config.js
    java-runner.js
    tools/
      list-databases.js
      describe-database.js
      test-connection.js
      jdbc-query.js
  java/
    JdbcExecutor.java
  drivers/
    .gitkeep
```

`drivers/` 用于存放用户自行提供的 JDBC 驱动 jar。驱动 jar 不提交到版本库。

实现时优先从以下 DataGrip 本地驱动目录查找并复制驱动：

```text
/Users/zhangzhengqing/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers
```

复制规则：

- MySQL 驱动选择该目录下最新版本的 MySQL Connector/J jar，复制到 `bs-jdbc-tool/drivers/mysql-connector-j.jar`。
- Oracle 驱动选择该目录下最新版本的 `ojdbc` jar，复制到 `bs-jdbc-tool/drivers/ojdbc.jar`。
- 复制后配置文件使用稳定文件名，避免配置里绑定具体版本号。
- 如果无法自动判断最新版本，实施时列出候选 jar 并让用户确认。

## 配置文件

默认读取：

```text
bs-jdbc-tool/config.local.json
```

支持通过环境变量覆盖：

```bash
BS_JDBC_TOOL_CONFIG=/path/to/config.json
```

示例：

```json
{
  "defaults": {
    "maxRows": 500,
    "maxRowsLimit": 5000,
    "timeoutSeconds": 30,
    "timeoutSecondsLimit": 120,
    "allowDml": true
  },
  "databases": {
    "dev-operations": {
      "type": "mysql",
      "description": "运营平台开发库",
      "jdbcUrl": "jdbc:mysql://127.0.0.1:3306/dev_operations?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai",
      "driverClass": "com.mysql.cj.jdbc.Driver",
      "driverJars": ["drivers/mysql-connector-j.jar"],
      "username": "root",
      "password": "password",
      "defaults": {
        "maxRows": 500,
        "timeoutSeconds": 30,
        "allowDml": true
      }
    },
    "dev-oracle-sid": {
      "type": "oracle",
      "description": "Oracle SID 方式连接",
      "jdbcUrl": "jdbc:oracle:thin:@127.0.0.1:1521:ORCL",
      "driverClass": "oracle.jdbc.OracleDriver",
      "driverJars": ["drivers/ojdbc11.jar"],
      "username": "app_user",
      "password": "password"
    },
    "dev-oracle-service": {
      "type": "oracle",
      "description": "Oracle Service Name 方式连接",
      "jdbcUrl": "jdbc:oracle:thin:@127.0.0.1:1521/ORCLPDB1",
      "driverClass": "oracle.jdbc.OracleDriver",
      "driverJars": ["drivers/ojdbc11.jar"],
      "username": "app_user",
      "password": "password"
    }
  }
}
```

### Oracle SID 和 Service Name

Oracle SID 或 Service Name 不单独建字段，统一写在 `jdbcUrl` 中。工具保持通用 JDBC 模型，把 URL 原样交给 JDBC 驱动处理。

- SID 写法：`jdbc:oracle:thin:@host:1521:ORCL`
- Service Name 写法：`jdbc:oracle:thin:@host:1521/ORCLPDB1`

### 配置字段规则

每个数据库配置项包含：

- `type`：展示和兼容性标识，例如 `mysql`、`tdsql`、`oracle`、`kingbase`、`dm`。
- `description`：给 agent 看的数据库说明，帮助选择正确别名。
- `jdbcUrl`：JDBC URL，原样传递给驱动。
- `driverClass`：JDBC 驱动类名。
- `driverJars`：JDBC 驱动 jar 路径；相对路径以 `bs-jdbc-tool` 为基准，绝对路径直接使用。
- `username`：数据库用户名。
- `password`：数据库密码，本地明文保存。
- `defaults`：可选的单库默认值覆盖。

所有 agent 可见的配置摘要都不包含 `password`。`describe_database` 可以返回 `jdbcUrl` 和 `username`，但密码只返回 `hasPassword: true`。

## MCP Tools

### `list_databases`

列出可用数据库别名，不返回敏感连接信息。

入参：无。

出参：

```json
{
  "databases": [
    {
      "alias": "dev-operations",
      "type": "mysql",
      "description": "运营平台开发库",
      "defaults": {
        "maxRows": 500,
        "timeoutSeconds": 30,
        "allowDml": true
      }
    }
  ]
}
```

### `describe_database`

查看某个别名的脱敏配置摘要。

入参：

```json
{
  "alias": "dev-operations"
}
```

出参：

```json
{
  "alias": "dev-operations",
  "type": "mysql",
  "description": "运营平台开发库",
  "jdbcUrl": "jdbc:mysql://127.0.0.1:3306/dev_operations?...",
  "driverClass": "com.mysql.cj.jdbc.Driver",
  "driverJars": ["drivers/mysql-connector-j.jar"],
  "username": "root",
  "hasPassword": true,
  "defaults": {
    "maxRows": 500,
    "timeoutSeconds": 30,
    "allowDml": true
  }
}
```

### `jdbc_test_connection`

测试某个数据库别名能否连接。

入参：

```json
{
  "alias": "dev-operations",
  "timeoutSeconds": 10
}
```

成功出参：

```json
{
  "success": true,
  "alias": "dev-operations",
  "type": "mysql",
  "elapsedMs": 238,
  "databaseProductName": "MySQL",
  "databaseProductVersion": "8.0.33",
  "driverName": "MySQL Connector/J",
  "driverVersion": "8.0.33"
}
```

失败出参：

```json
{
  "success": false,
  "alias": "dev-operations",
  "error": {
    "type": "SQLException",
    "message": "Access denied for user ...",
    "sqlState": "28000",
    "vendorCode": 1045
  }
}
```

### `jdbc_query`

根据数据库别名执行单条 SQL。配置允许时支持查询和 DML。

入参：

```json
{
  "alias": "dev-operations",
  "sql": "select id, name from auth_temp_function where code = ?",
  "params": ["reconciliation:xxx"],
  "maxRows": 100,
  "timeoutSeconds": 30
}
```

规则：

- `alias` 必填。
- `sql` 必填。
- `params` 可选，对应 `PreparedStatement` 参数。
- `maxRows` 可选，只对结果集生效。
- `timeoutSeconds` 可选。
- `allowDml` 只从配置读取，不能通过 tool 入参覆盖。

查询出参：

```json
{
  "success": true,
  "alias": "dev-operations",
  "type": "mysql",
  "sqlKind": "query",
  "elapsedMs": 41,
  "truncated": false,
  "columns": [
    {
      "name": "id",
      "label": "id",
      "typeName": "BIGINT",
      "jdbcType": -5,
      "nullable": true
    }
  ],
  "rows": [
    {
      "id": 1,
      "name": "菜单名称"
    }
  ],
  "rowCount": 1,
  "maxRows": 100
}
```

DML 出参：

```json
{
  "success": true,
  "alias": "dev-operations",
  "type": "mysql",
  "sqlKind": "update",
  "elapsedMs": 55,
  "affectedRows": 1
}
```

SQL 失败出参：

```json
{
  "success": false,
  "alias": "dev-operations",
  "sqlKind": "unknown",
  "error": {
    "type": "SQLException",
    "message": "Table 'xxx' doesn't exist",
    "sqlState": "42S02",
    "vendorCode": 1146
  }
}
```

## SQL 执行规则

1. `jdbc_query` 每次只允许执行一条 SQL。
2. 允许 SQL 末尾有一个分号。
3. 字符串字面量中的分号不视为多语句分隔符。
4. 查询语句包括 `SELECT`、`WITH`、`SHOW`、`DESC`、`EXPLAIN`。
5. DML 和非查询语句包括 `INSERT`、`UPDATE`、`DELETE`、`MERGE`、`CALL` 和 DDL，这些都需要 `allowDml: true`。
6. 每次 tool 调用使用独立 JDBC 连接。
7. 初版使用 `autoCommit=true`。
8. executor 只返回单条 SQL 的第一个结果集或更新行数。
9. 返回行数受有效 `maxRows` 限制。
10. 超时由 JDBC 层和 Node 子进程层共同控制。

## 限制合并规则

有效限制按以下顺序确定：

1. Tool 入参。
2. 数据库级 `defaults`。
3. 全局 `defaults`。
4. 内置默认值。

然后再受以下上限约束：

- `maxRowsLimit`
- `timeoutSecondsLimit`

建议内置默认值：

- `maxRows`: 500
- `maxRowsLimit`: 5000
- `timeoutSeconds`: 30
- `timeoutSecondsLimit`: 120
- `allowDml`: true

## 错误处理

### 配置错误

例如：

- 配置文件不存在。
- alias 不存在。
- 必填字段缺失。
- 驱动 jar 文件不存在。

出参：

```json
{
  "success": false,
  "alias": "dev-operations",
  "error": {
    "type": "ConfigError",
    "message": "Database alias not found: dev-operations",
    "hint": "Call list_databases to see available aliases."
  }
}
```

### 执行器错误

例如：

- 本机没有 Java。
- Java 编译或运行失败。
- 子进程超时。
- executor 输出不是合法 JSON。

出参：

```json
{
  "success": false,
  "alias": "dev-oracle",
  "error": {
    "type": "ExecutorError",
    "message": "Java executor timed out after 35 seconds",
    "hint": "Increase timeoutSeconds or check whether the database is reachable."
  }
}
```

### JDBC 错误

例如：

- 用户名或密码错误。
- 网络不可达。
- SQL 语法错误。
- 表不存在。
- 权限不足。

出参：

```json
{
  "success": false,
  "alias": "dev-operations",
  "error": {
    "type": "SQLException",
    "message": "Table 'xxx' doesn't exist",
    "sqlState": "42S02",
    "vendorCode": 1146
  }
}
```

## 安全边界

- 按用户要求，真实密码明文保存在 `config.local.json`。
- `config.local.json` 默认加入 `.gitignore`。
- `drivers/*.jar` 默认加入 `.gitignore`。
- Tool 返回结果永远不包含 `password`。
- 错误信息不主动拼接或回显密码。
- `jdbc_query` 入参不能覆盖配置中的 `allowDml`。
- 单条 SQL 限制降低一次执行不可控多语句的风险。
- 行数限制和超时限制避免误拉大量数据或长时间占用数据库。

## 测试方案

### Node 单元测试

覆盖：

- 配置路径解析。
- 配置字段校验。
- 密码脱敏。
- alias 查询成功和失败。
- 单条 SQL 检测：
  - `select 1`
  - `select 1;`
  - `select ';' as semi`
  - `select 1; select 2` 应拒绝
- 限制合并和上限裁剪。
- Java 子进程成功、失败、超时和非法 JSON 输出处理。

### Java 单元测试

覆盖：

- JSON 请求解析。
- `string`、`number`、`boolean`、`null` 参数绑定。
- 字符串、数字、日期时间、空值等 ResultSet 转 JSON。
- `SQLException` 转结构化 JSON。

### 集成测试

使用 H2 内存数据库测试 JDBC executor 主流程：

```text
jdbc:h2:mem:test
```

覆盖：

- 连接测试。
- SELECT。
- INSERT。
- UPDATE。
- DELETE。
- 查询结果截断。
- 可选的超时行为。

### 手工验证

针对真实 MySQL、TDSQL、Oracle 环境：

1. 将对应 JDBC driver jar 放入 `drivers/`。
2. 在 `config.local.json` 中添加别名。
3. 在 Claude Code 中启动 MCP server。
4. 调用 `list_databases`。
5. 对每个别名调用 `jdbc_test_connection`。
6. 使用 `jdbc_query` 执行 `select 1` 或数据库对应的简单查询。
7. 在非生产测试表上执行一条 insert/update/delete 验证 DML。

## 实现备注

- 初版不实现连接池。
- 每次 tool 调用创建并关闭自己的 JDBC 连接。
- Java executor 可以在安装时编译，也可以首次运行时编译；优先保持实现简单。
- Node 和 Java 之间只使用 JSON 通信。
- 后续新增数据库时，通过 JDBC URL、driver class 和 driver jars 配置扩展。

## 初版不做的内容

- 连接池。
- 多语句脚本执行。
- 批量执行工具。
- 跨多次 tool 调用的事务会话。
- 密码加密或系统钥匙串存储。
- Web 管理界面。
- 自动下载 JDBC 驱动。
