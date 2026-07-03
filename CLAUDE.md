# 🤖 Claude Code 项目能力总览

> **自动加载**: 本文件在打开 `bs-project-tools` 项目时自动注入 Agent 上下文，让 AI 第一时间知道有哪些工具可用。

---

## 📦 项目结构

```
bs-project-tools/
├── bs-jdbc-tool/    # JDBC 数据库操作 MCP 服务 ✅ 已启用
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

```bash
# 有头模式（可看到浏览器）
cd bs-java-run && ./login.sh

# 无头模式（后台运行）
cd bs-java-run && ./login.sh --headless
```

登录成功后会输出 JWT Token，`authorization` 请求头直接使用（无需加 Bearer 前缀）。

> ⚠️ 登录接口参数经过前端加密，无法用 curl 明文调用，必须通过 Playwright 脚本。

---

## 🔧 可用工具（MCP）

### bs-jdbc-tool — JDBC 数据库操作

**当前配置状态**: ✅ 已配置、可直接调用

| 工具 | 功能 | 最佳实践 |
|------|------|---------|
| `list_databases` | 列出所有数据库别名 | **先调用它**，确认有哪些库可用 |
| `describe_database` | 查看数据库配置详情 | 检查连接信息、驱动、参数 |
| `jdbc_test_connection` | 测试数据库连接 | 操作前先确认连接正常 |
| `jdbc_query` | 执行**单条** SQL | SELECT / INSERT / UPDATE / DELETE / DDL |
| `jdbc_batch` | ✨ 执行**多条** SQL；abort 模式同一事务，continue 模式逐条尽力执行 | **多条 SQL 永远优先用这个，不要循环调用 `jdbc_query`** |

---

## 🎯 工具选择决策树

```
要操作数据库吗？
  │
  ├─ 先确认别名 → 调用 list_databases
  ├─ 先确认连接 → 调用 jdbc_test_connection
  └─ 执行 SQL：
      ├─ 1 条 → jdbc_query
      └─ ≥2 条 → jdbc_batch
           ├─ 需要原子性（失败全回滚）→ onError: "abort"（默认）
           └─ 允许部分成功 → onError: "continue"
```

---

## ⚠️ Agent 安全守则

1. **DML 默认开启**：`allowDml: true`，可以执行 INSERT/UPDATE/DELETE
2. **批量限制**：`jdbc_batch` 单次最多 200 条（`maxBatchSize`）
3. **单语句强制**：每条 SQL 只能是单语句（不允许多个 `;` 分隔）
4. **密码保护**：永远不要输出 `config.local.json` 中的真实密码
5. **批量优先**：凡是 N 条相关 SQL（导入、修复、迁移），**必须用 `jdbc_batch`**，不要逐条调用 `jdbc_query`

---

## 🗄️ 预置数据库别名

| 别名 | 类型 | 说明 |
|------|------|------|
| `dev-mysql` | MySQL | 运营平台开发库 |
| `dev-oracle` | Oracle | 核心业务开发库 |

密码已在本地配置中，无需询问。

---

## ✅ 快速验证清单

新会话开始时，如果要操作数据库，先跑这三步：

1. `list_databases` → 确认别名
2. `jdbc_test_connection` (alias: "dev-mysql") → 确认 MySQL 连接
3. `jdbc_test_connection` (alias: "dev-oracle") → 确认 Oracle 连接

三步都通过后再执行业务 SQL。

---

## 📋 工具使用示例

### jdbc_query（单条 SQL）

```json
{
  "alias": "dev-mysql",
  "sql": "SELECT * FROM auth_function WHERE code = ?",
  "params": ["reconciliation:config"],
  "timeoutSeconds": 10
}
```

- SELECT：返回 `columns` + `rows` + `rowCount`
- INSERT/UPDATE/DELETE：返回 `affectedRows`（影响行数）
- params 是可选的，没有参数可以不传

---

### jdbc_batch（多条 SQL + 事务）

```json
{
  "alias": "dev-mysql",
  "statements": [
    { "sql": "INSERT INTO t (id, name) VALUES (?, ?)", "params": [1, "a"] },
    { "sql": "UPDATE t SET name = ? WHERE id = ?", "params": ["b", 1] },
    { "sql": "DELETE FROM t WHERE id = ?", "params": [2] }
  ],
  "onError": "abort"
}
```

| onError 值 | 事务行为 | 适用场景 |
|-----------|---------|---------|
| `"abort"`（默认） | 任意一条失败 → 全部回滚 | 数据导入、批量变更、需要原子性的操作 |
| `"continue"` | 逐条自动提交，失败记录，后续继续执行 | 数据修复、清理脚本，允许部分成功 |

返回结构：
- `total/succeeded/failed`：总数/成功数/失败数
- `committed`：true/false（abort 模式下如果有失败就是 false）
- `results`：每条的 `index/success/affectedRows/error` 详情

---

## 📝 最后更新

- 2026-06-17: 新增 `jdbc_batch` 批量事务工具，更新本能力说明
