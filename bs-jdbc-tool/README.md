# bs-jdbc-tool

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
| `jdbc_query` | 执行 SQL 查询（支持 SELECT、INSERT、UPDATE、DELETE、CREATE TABLE 等） |

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
