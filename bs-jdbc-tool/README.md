# bs-jdbc-tool

---

## 🤖 Agent 能力说明

**给 Claude / AI Agent 的快速指引：**

本项目是一个 **JDBC 数据库操作工具**，通过 MCP 协议暴露给 Claude Code。你可以直接调用以下工具操作数据库：

### ✅ 你可以用这些工具做什么

| 工具 | 适用场景 | 示例 |
|------|---------|------|
| `list_databases` | 先调用这个！查看有哪些数据库别名可用 | "看看现在配了哪些库" |
| `describe_database` | 查看某个数据库的详细配置（连接信息、驱动等） | "dev-oracle 连的是哪个地址？" |
| `jdbc_test_connection` | 验证数据库连接是否正常 | "先确认 Oracle 能连上" |
| `jdbc_query` | **单条 SQL 执行** — 查询、DML、DDL 都可以 | "查一下这张表有多少条数据" |
| `jdbc_batch` | ✨ **批量/事务执行** — 多条 SQL 在同一个事务里原子执行 | "跑 88 条幂等导入，失败整体回滚" |

### 🎯 选择工具的决策树

```
要执行 SQL 吗？
  ├─ 只有 1 条 → 用 jdbc_query
  └─ N 条 SQL（N ≥ 2）
      ├─ 需要原子性（一条失败全回滚）→ jdbc_batch onError: "abort"（默认）
      └─ 允许部分成功部分失败 → jdbc_batch onError: "continue"
```

### ⚠️ Agent 重要提醒

1. **DML 默认开启**：当前配置 `allowDml: true`，`INSERT/UPDATE/DELETE` 都可以执行
2. **批量保护**：`jdbc_batch` 一次最多 200 条（可配置 `maxBatchSize`）
3. **单语句强制**：每条 SQL 只能是单语句（`;` 只能有一个末尾的），多语句会在校验层被拒绝
4. **有密码保护**：不要把 `config.local.json` 里的真实密码输出到对话中
5. **优先用 batch**：凡是多条相关 SQL（同一次导入、同一次修复），优先用 `jdbc_batch` 而不是循环调用 `jdbc_query`

---

## 工具说明

本地 Claude Code MCP Server，根据数据库别名执行 JDBC SQL。

## 架构

- **Node.js MCP Server**: 基于 Model Context Protocol SDK 实现的 MCP 服务器，提供工具注册和标准输入输出通信
- **Java JDBC Executor**: 后端使用 Java 执行 JDBC 操作，支持 MySQL、Oracle 等数据库

## 前置要求

- Node.js (支持 ESM)
- Java 17+
  - **注意**: Oracle ojdbc17 驱动需要 Java 17 或更高版本
- JDBC driver jar 文件

### 依赖验证命令

```bash
node -v
/usr/libexec/java_home -v 17+  # 或 java -version
npm test
npm run compile:java
```

## 安装

```bash
npm install
```

## 驱动

当前本机已复制以下 JDBC 驱动到 `drivers/` 目录：

- `drivers/mysql-connector-j.jar` - MySQL Connector/J 9.7.0
- `drivers/ojdbc.jar` - Oracle ojdbc17 23.26.2.0.0

> **注意**: 这些 jar 文件被 `.gitignore` 忽略，不会提交到仓库。新机器需从 DataGrip 或其他来源自行放置相同文件名。

## 配置

1. 复制 `config.example.json` 为 `config.local.json`
2. 编辑 `config.local.json` 替换数据库密码占位符

配置说明：
- **安全提醒**: `config.local.json` 含明文密码，绝不能分享、提交、贴到公开渠道；真实密码由用户本机手动填写。
- `config.local.json` 已被 `.gitignore` 忽略，不会提交到仓库
- 预置数据库别名: `dev-mysql`、`dev-oracle`
- **重要**: 请手动替换 `请在此处填写MySQL密码` 和 `请在此处填写Oracle密码` 占位符为真实密码
- **环境说明**: `dev-mysql`、`dev-oracle` 的 IP、用户名是当前环境初始配置，其他环境需替换为实际值。

配置示例结构：
```json
{
  "defaults": { ... },
  "databases": {
    "dev-mysql": {
      "type": "mysql",
      "description": "MySQL 开发库",
      "jdbcUrl": "jdbc:mysql://...",
      "driverClass": "com.mysql.cj.jdbc.Driver",
      "driverJars": ["drivers/mysql-connector-j.jar"],
      "username": "root",
      "password": "真实密码"
    },
    "dev-oracle": { ... }
  }
}
```

## 启动

```bash
npm start
```

## Claude Code MCP 配置

在 Claude Code 的 MCP 配置中添加以下 JSON 配置：

```json
{
  "mcpServers": {
    "bs-jdbc-tool": {
      "command": "node",
      "args": [
        "/Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/src/server.js"
      ]
    }
  }
}
```

> **路径说明**: 上述绝对路径是当前机器路径，其他机器需替换为实际路径；也可用 `pwd` 获取 bs-jdbc-tool 路径。

## Tools

MCP 服务器提供以下工具：

| 工具名称 | 功能说明 |
|---------|---------|
| `list_databases` | 列出所有配置的数据库别名及描述 |
| `describe_database` | 查看指定数据库的详细配置信息 |
| `jdbc_test_connection` | 测试指定数据库连接是否正常 |
| `jdbc_query` | 执行单条 SQL（SELECT、INSERT、UPDATE、DELETE、CREATE TABLE 等） |
| `jdbc_batch` | ✨ 批量执行多条 SQL，同一事务。支持两种错误模式：<br>`abort`（默认）：任意失败整体回滚<br>`continue`：失败记录、成功提交 |

### jdbc_batch 使用示例

```json
{
  "alias": "dev-mysql",
  "statements": [
    { "sql": "INSERT INTO t (id, name) VALUES (?, ?)", "params": [1, "a"] },
    { "sql": "UPDATE t SET name = ? WHERE id = ?", "params": ["b", 1] }
  ],
  "onError": "abort"
}
```

## 验证命令

### 运行测试
```bash
npm test
```

### 编译 Java Executor
```bash
npm run compile:java
```

## 手工验证

配置完成后，可通过以下步骤验证功能正常：

1. **列出数据库**
   - 调用 `list_databases` 工具，确认返回 `dev-mysql` 和 `dev-oracle` 配置

2. **测试连接**
   - 调用 `jdbc_test_connection` 工具，参数 `alias: "dev-mysql"`
   - 调用 `jdbc_test_connection` 工具，参数 `alias: "dev-oracle"`

3. **执行简单查询**
   - MySQL: 调用 `jdbc_query`，参数 `alias: "dev-mysql"`, `sql: "select 1"`
   - Oracle: 调用 `jdbc_query`，参数 `alias: "dev-oracle"`, `sql: "select 1 from dual"`

如果以上验证均成功返回结果，则说明 JDBC 工具配置正确。
