# JDBC MCP Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Claude Code MCP Server in `bs-jdbc-tool` that lets agents execute JDBC SQL against configured database aliases.

**Architecture:** Node.js exposes MCP stdio tools and handles config, validation, and subprocess management. A Java JDBC executor loads configured driver jars, connects to the selected database, executes a single SQL statement, and returns structured JSON.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/sdk`, Java 17+, JDBC, Node built-in `node:test`, DataGrip-provided JDBC jars.

---

## Context

The user needs a local database-querying tool for Claude Code agents. The tool must support MySQL, TDSQL, Oracle, and future JDBC-compatible databases such as Kingbase and Dameng. The design was approved in `docs/superpowers/specs/2026-06-17-jdbc-mcp-tool-design.md`.

Important requirements:

- Database aliases are configured in local JSON.
- Passwords are stored in local plaintext config by user choice.
- Initial config must include:
  - MySQL: `jdbc:mysql://172.18.163.23:3306?useUnicode=true&characterEncoding=utf8&characterSetResults=utf8&serverTimezone=Asia/Shanghai`, user `root`, password placeholder.
  - Oracle: `jdbc:oracle:thin:@172.18.163.10:1521/pdb`, user `YLPZCS0612`, password placeholder.
- JDBC drivers should be copied from DataGrip local driver directory:
  - `/Users/zhangzhengqing/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers`
- Use the latest discovered drivers:
  - MySQL: `mysql-connector-j-9.7.0.jar`
  - Oracle: `ojdbc17-23.26.2.0.0.jar`
- Copy them into stable local names:
  - `bs-jdbc-tool/drivers/mysql-connector-j.jar`
  - `bs-jdbc-tool/drivers/ojdbc.jar`
- `ojdbc17` requires Java 17+, so Java runner must detect and use Java 17+ explicitly.

Current `bs-jdbc-tool` is empty.

## File Structure

Create these files:

- `bs-jdbc-tool/package.json` — Node package metadata, scripts, MCP SDK dependency.
- `bs-jdbc-tool/.gitignore` — ignore local passwords, copied driver jars, build output, dependencies.
- `bs-jdbc-tool/README.md` — usage, Claude Code MCP setup, driver/config instructions.
- `bs-jdbc-tool/config.example.json` — safe template with placeholder values.
- `bs-jdbc-tool/config.local.json` — local config with the two requested aliases and password placeholders.
- `bs-jdbc-tool/src/server.js` — MCP stdio server entrypoint.
- `bs-jdbc-tool/src/config.js` — config loading, validation, defaults, alias lookup, password redaction.
- `bs-jdbc-tool/src/sql-validator.js` — single-statement check and SQL kind detection.
- `bs-jdbc-tool/src/java-runner.js` — Java 17+ detection, compile/run executor, JSON subprocess protocol.
- `bs-jdbc-tool/src/tools/list-databases.js` — `list_databases` tool handler.
- `bs-jdbc-tool/src/tools/describe-database.js` — `describe_database` tool handler.
- `bs-jdbc-tool/src/tools/test-connection.js` — `jdbc_test_connection` tool handler.
- `bs-jdbc-tool/src/tools/jdbc-query.js` — `jdbc_query` tool handler.
- `bs-jdbc-tool/java/JdbcExecutor.java` — Java JDBC executor.
- `bs-jdbc-tool/drivers/.gitkeep` — keep drivers directory.
- `bs-jdbc-tool/test/node/config.test.js` — config tests.
- `bs-jdbc-tool/test/node/sql-validator.test.js` — SQL validation tests.
- `bs-jdbc-tool/test/node/java-runner.test.js` — Java runner tests using mock processes where possible.

Copy these binary files from DataGrip:

- From: `/Users/zhangzhengqing/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers/MySQL ConnectorJ/9.7.0/com/mysql/mysql-connector-j/9.7.0/mysql-connector-j-9.7.0.jar`
- To: `bs-jdbc-tool/drivers/mysql-connector-j.jar`

- From: `/Users/zhangzhengqing/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers/Oracle/23.26.2.0/com/oracle/database/jdbc/ojdbc17/23.26.2.0.0/ojdbc17-23.26.2.0.0.jar`
- To: `bs-jdbc-tool/drivers/ojdbc.jar`

## Task 1: Initialize package and local files

**Files:**
- Create: `bs-jdbc-tool/package.json`
- Create: `bs-jdbc-tool/.gitignore`
- Create: `bs-jdbc-tool/drivers/.gitkeep`

- [ ] **Step 1: Create package.json**

Create `bs-jdbc-tool/package.json`:

```json
{
  "name": "bs-jdbc-tool",
  "version": "1.0.0",
  "description": "Local Claude Code MCP server for JDBC database queries by alias",
  "type": "module",
  "private": true,
  "bin": {
    "bs-jdbc-tool": "./src/server.js"
  },
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/node/*.test.js",
    "compile:java": "node -e \"import('./src/java-runner.js').then(m => m.compileExecutor())\""
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest"
  }
}
```

- [ ] **Step 2: Create .gitignore**

Create `bs-jdbc-tool/.gitignore`:

```gitignore
# local credentials
config.local.json

# copied JDBC drivers
drivers/*.jar

# node
node_modules/
npm-debug.log*

# java build output
java/build/
*.class

# os
.DS_Store
```

- [ ] **Step 3: Create drivers placeholder**

Create `bs-jdbc-tool/drivers/.gitkeep` as an empty file.

- [ ] **Step 4: Install dependencies**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm install
```

Expected: `node_modules/` and `package-lock.json` are created, and install exits successfully.

- [ ] **Step 5: Verify package scripts are visible**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm run
```

Expected: output lists `start`, `test`, and `compile:java`.

## Task 2: Copy latest DataGrip JDBC drivers

**Files:**
- Create binary: `bs-jdbc-tool/drivers/mysql-connector-j.jar`
- Create binary: `bs-jdbc-tool/drivers/ojdbc.jar`

- [ ] **Step 1: Copy MySQL Connector/J 9.7.0**

Run:

```bash
cp "/Users/zhangzhengqing/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers/MySQL ConnectorJ/9.7.0/com/mysql/mysql-connector-j/9.7.0/mysql-connector-j-9.7.0.jar" \
  /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/drivers/mysql-connector-j.jar
```

Expected: command exits successfully.

- [ ] **Step 2: Copy Oracle ojdbc17 23.26.2.0.0**

Run:

```bash
cp "/Users/zhangzhengqing/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers/Oracle/23.26.2.0/com/oracle/database/jdbc/ojdbc17/23.26.2.0.0/ojdbc17-23.26.2.0.0.jar" \
  /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/drivers/ojdbc.jar
```

Expected: command exits successfully.

- [ ] **Step 3: Verify copied jars exist**

Run:

```bash
ls -lh /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/drivers/*.jar
```

Expected: output includes `mysql-connector-j.jar` and `ojdbc.jar` with non-zero sizes.

## Task 3: Add config module and config files

**Files:**
- Create: `bs-jdbc-tool/src/config.js`
- Create: `bs-jdbc-tool/config.example.json`
- Create: `bs-jdbc-tool/config.local.json`
- Test: `bs-jdbc-tool/test/node/config.test.js`

- [ ] **Step 1: Write failing config tests**

Create `bs-jdbc-tool/test/node/config.test.js`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfigFromFile, redactDatabaseConfig, resolveEffectiveOptions } from '../../src/config.js';

function writeTempConfig(content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-jdbc-config-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}

test('loads databases and validates required fields', () => {
  const file = writeTempConfig({
    defaults: { maxRows: 100, maxRowsLimit: 1000, timeoutSeconds: 10, timeoutSecondsLimit: 60, allowDml: true },
    databases: {
      demo: {
        type: 'mysql',
        description: 'demo db',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql-connector-j.jar'],
        username: 'root',
        password: 'secret'
      }
    }
  });

  const config = loadConfigFromFile(file, { checkDriverFiles: false });
  assert.equal(config.databases.demo.username, 'root');
});

test('redacts password from database summary', () => {
  const redacted = redactDatabaseConfig('demo', {
    type: 'mysql',
    description: 'demo db',
    jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
    driverClass: 'com.mysql.cj.jdbc.Driver',
    driverJars: ['drivers/mysql-connector-j.jar'],
    username: 'root',
    password: 'secret',
    defaults: { maxRows: 100 }
  });

  assert.equal(redacted.alias, 'demo');
  assert.equal(redacted.hasPassword, true);
  assert.equal(Object.hasOwn(redacted, 'password'), false);
});

test('resolves options with caps', () => {
  const options = resolveEffectiveOptions(
    { maxRows: 9999, timeoutSeconds: 9999 },
    { defaults: { maxRows: 100, maxRowsLimit: 500, timeoutSeconds: 10, timeoutSecondsLimit: 60, allowDml: true } },
    { maxRows: 200, timeoutSeconds: 20 }
  );

  assert.equal(options.maxRows, 500);
  assert.equal(options.timeoutSeconds, 60);
  assert.equal(options.allowDml, true);
});

test('throws ConfigError for missing required fields', () => {
  const file = writeTempConfig({ databases: { bad: { type: 'mysql' } } });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    /Missing required field databases\.bad\.jdbcUrl/
  );
});
```

- [ ] **Step 2: Run config tests and verify they fail**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
node --test test/node/config.test.js
```

Expected: FAIL because `src/config.js` does not exist or exported functions are missing.

- [ ] **Step 3: Implement config.js**

Create `bs-jdbc-tool/src/config.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, '..');

const BUILTIN_DEFAULTS = {
  maxRows: 500,
  maxRowsLimit: 5000,
  timeoutSeconds: 30,
  timeoutSecondsLimit: 120,
  allowDml: true
};

export class ConfigError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

export function defaultConfigPath() {
  return process.env.BS_JDBC_TOOL_CONFIG || path.join(TOOL_ROOT, 'config.local.json');
}

export function resolveToolPath(value) {
  if (path.isAbsolute(value)) return value;
  return path.join(TOOL_ROOT, value);
}

export function loadConfig() {
  return loadConfigFromFile(defaultConfigPath());
}

export function loadConfigFromFile(filePath, options = {}) {
  const checkDriverFiles = options.checkDriverFiles !== false;
  if (!fs.existsSync(filePath)) {
    throw new ConfigError(`Config file not found: ${filePath}`, 'Create config.local.json or set BS_JDBC_TOOL_CONFIG.');
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw.databases || typeof raw.databases !== 'object') {
    throw new ConfigError('Missing required field databases');
  }

  const defaults = { ...BUILTIN_DEFAULTS, ...(raw.defaults || {}) };
  const databases = {};

  for (const [alias, db] of Object.entries(raw.databases)) {
    validateDatabase(alias, db);
    if (checkDriverFiles) {
      for (const jar of db.driverJars) {
        const jarPath = resolveToolPath(jar);
        if (!fs.existsSync(jarPath)) {
          throw new ConfigError(`Driver jar not found for ${alias}: ${jar}`, 'Copy JDBC driver jars into drivers/ or fix driverJars.');
        }
      }
    }
    databases[alias] = { ...db };
  }

  return { defaults, databases };
}

function validateDatabase(alias, db) {
  const required = ['type', 'jdbcUrl', 'driverClass', 'driverJars', 'username', 'password'];
  for (const field of required) {
    if (db[field] === undefined || db[field] === null || db[field] === '') {
      throw new ConfigError(`Missing required field databases.${alias}.${field}`);
    }
  }
  if (!Array.isArray(db.driverJars) || db.driverJars.length === 0) {
    throw new ConfigError(`databases.${alias}.driverJars must be a non-empty array`);
  }
}

export function getDatabaseConfig(config, alias) {
  const db = config.databases[alias];
  if (!db) {
    throw new ConfigError(`Database alias not found: ${alias}`, 'Call list_databases to see available aliases.');
  }
  return db;
}

export function redactDatabaseConfig(alias, db, defaults = undefined) {
  const result = {
    alias,
    type: db.type,
    description: db.description || '',
    jdbcUrl: db.jdbcUrl,
    driverClass: db.driverClass,
    driverJars: db.driverJars,
    username: db.username,
    hasPassword: Boolean(db.password),
    defaults: { ...(defaults || {}), ...(db.defaults || {}) }
  };
  return result;
}

export function databaseListItem(alias, db, globalDefaults) {
  return {
    alias,
    type: db.type,
    description: db.description || '',
    defaults: {
      maxRows: db.defaults?.maxRows ?? globalDefaults.maxRows,
      timeoutSeconds: db.defaults?.timeoutSeconds ?? globalDefaults.timeoutSeconds,
      allowDml: db.defaults?.allowDml ?? globalDefaults.allowDml
    }
  };
}

export function resolveEffectiveOptions(toolInput, config, db) {
  const dbDefaults = db.defaults || {};
  const globalDefaults = config.defaults || BUILTIN_DEFAULTS;

  const maxRowsLimit = dbDefaults.maxRowsLimit ?? globalDefaults.maxRowsLimit ?? BUILTIN_DEFAULTS.maxRowsLimit;
  const timeoutSecondsLimit = dbDefaults.timeoutSecondsLimit ?? globalDefaults.timeoutSecondsLimit ?? BUILTIN_DEFAULTS.timeoutSecondsLimit;

  const requestedMaxRows = toolInput.maxRows ?? dbDefaults.maxRows ?? globalDefaults.maxRows ?? BUILTIN_DEFAULTS.maxRows;
  const requestedTimeout = toolInput.timeoutSeconds ?? dbDefaults.timeoutSeconds ?? globalDefaults.timeoutSeconds ?? BUILTIN_DEFAULTS.timeoutSeconds;

  return {
    maxRows: Math.min(toPositiveInt(requestedMaxRows, 'maxRows'), toPositiveInt(maxRowsLimit, 'maxRowsLimit')),
    timeoutSeconds: Math.min(toPositiveInt(requestedTimeout, 'timeoutSeconds'), toPositiveInt(timeoutSecondsLimit, 'timeoutSecondsLimit')),
    allowDml: dbDefaults.allowDml ?? globalDefaults.allowDml ?? BUILTIN_DEFAULTS.allowDml
  };
}

function toPositiveInt(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return number;
}

export function configErrorResult(error, alias = undefined) {
  return {
    success: false,
    ...(alias ? { alias } : {}),
    error: {
      type: 'ConfigError',
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {})
    }
  };
}
```

- [ ] **Step 4: Add config files**

Create `bs-jdbc-tool/config.example.json`:

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
    "dev-mysql": {
      "type": "mysql",
      "description": "MySQL 开发库 172.18.163.23:3306",
      "jdbcUrl": "jdbc:mysql://172.18.163.23:3306?useUnicode=true&characterEncoding=utf8&characterSetResults=utf8&serverTimezone=Asia/Shanghai",
      "driverClass": "com.mysql.cj.jdbc.Driver",
      "driverJars": ["drivers/mysql-connector-j.jar"],
      "username": "root",
      "password": "请在此处填写MySQL密码"
    },
    "dev-oracle": {
      "type": "oracle",
      "description": "Oracle 开发库 172.18.163.10:1521/pdb YLPZCS0612",
      "jdbcUrl": "jdbc:oracle:thin:@172.18.163.10:1521/pdb",
      "driverClass": "oracle.jdbc.OracleDriver",
      "driverJars": ["drivers/ojdbc.jar"],
      "username": "YLPZCS0612",
      "password": "请在此处填写Oracle密码"
    }
  }
}
```

Create `bs-jdbc-tool/config.local.json` with the same content. This file is intentionally ignored by `.gitignore` and contains password placeholders for manual editing.

- [ ] **Step 5: Run config tests and verify pass**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
node --test test/node/config.test.js
```

Expected: PASS.

## Task 4: Add SQL validator

**Files:**
- Create: `bs-jdbc-tool/src/sql-validator.js`
- Test: `bs-jdbc-tool/test/node/sql-validator.test.js`

- [ ] **Step 1: Write failing SQL validator tests**

Create `bs-jdbc-tool/test/node/sql-validator.test.js`:

```js
import assert from 'node:assert/strict';
import { ensureSingleStatement, classifySql } from '../../src/sql-validator.js';

test('allows single SQL without semicolon', () => {
  assert.equal(ensureSingleStatement('select 1'), 'select 1');
});

test('allows one trailing semicolon', () => {
  assert.equal(ensureSingleStatement('select 1;'), 'select 1');
});

test('allows semicolon inside single quoted string', () => {
  assert.equal(ensureSingleStatement("select ';' as semi"), "select ';' as semi");
});

test('allows semicolon inside double quoted identifier or string', () => {
  assert.equal(ensureSingleStatement('select ";" as semi'), 'select ";" as semi');
});

test('rejects multiple statements', () => {
  assert.throws(() => ensureSingleStatement('select 1; select 2'), /Only one SQL statement is allowed/);
});

test('classifies query SQL', () => {
  assert.equal(classifySql('select 1'), 'query');
  assert.equal(classifySql('with x as (select 1) select * from x'), 'query');
  assert.equal(classifySql('show tables'), 'query');
  assert.equal(classifySql('desc user_table'), 'query');
  assert.equal(classifySql('explain select 1'), 'query');
});

test('classifies update SQL', () => {
  assert.equal(classifySql('insert into t values (1)'), 'update');
  assert.equal(classifySql('update t set a = 1'), 'update');
  assert.equal(classifySql('delete from t'), 'update');
  assert.equal(classifySql('merge into t using s on (t.id=s.id) when matched then update set t.a=s.a'), 'update');
  assert.equal(classifySql('create table t (id int)'), 'update');
});
```

- [ ] **Step 2: Run SQL validator tests and verify fail**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
node --test test/node/sql-validator.test.js
```

Expected: FAIL because `src/sql-validator.js` does not exist.

- [ ] **Step 3: Implement sql-validator.js**

Create `bs-jdbc-tool/src/sql-validator.js`:

```js
export class SqlValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

export function ensureSingleStatement(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new SqlValidationError('sql must be a non-empty string');
  }

  const trimmed = sql.trim();
  const semicolonPositions = findTopLevelSemicolons(trimmed);
  if (semicolonPositions.length === 0) return trimmed;

  const last = semicolonPositions[semicolonPositions.length - 1];
  const trailingOnly = last === trimmed.length - 1 && semicolonPositions.length === 1;
  if (trailingOnly) {
    return trimmed.slice(0, -1).trim();
  }

  throw new SqlValidationError('Only one SQL statement is allowed. Please split multiple statements into separate calls.');
}

function findTopLevelSemicolons(sql) {
  const positions = [];
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (!inSingle && !inDouble && char === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (!inSingle && !inDouble && char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (!inDouble && char === "'") {
      if (inSingle && next === "'") {
        i += 1;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }

    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && char === ';') {
      positions.push(i);
    }
  }

  return positions;
}

export function classifySql(sql) {
  const normalized = sql.trim().replace(/^\(+/, '').trim().toLowerCase();
  const first = normalized.split(/\s+/)[0];
  if (['select', 'with', 'show', 'desc', 'describe', 'explain'].includes(first)) {
    return 'query';
  }
  return 'update';
}

export function sqlErrorResult(error, alias = undefined) {
  return {
    success: false,
    ...(alias ? { alias } : {}),
    error: {
      type: 'SqlValidationError',
      message: error.message
    }
  };
}
```

- [ ] **Step 4: Run SQL validator tests and verify pass**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
node --test test/node/sql-validator.test.js
```

Expected: PASS.

## Task 5: Implement Java JDBC executor

**Files:**
- Create: `bs-jdbc-tool/java/JdbcExecutor.java`

- [ ] **Step 1: Create JdbcExecutor.java**

Create `bs-jdbc-tool/java/JdbcExecutor.java`:

```java
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.LinkedHashMap;
import java.util.ServiceLoader;

public class JdbcExecutor {
  public static void main(String[] args) throws Exception {
    long started = System.currentTimeMillis();
    String input = readAllStdin();
    try {
      Object parsed = Json.parse(input);
      Map<String, Object> request = castMap(parsed);
      Map<String, Object> result = execute(request, started);
      System.out.println(Json.stringify(result));
    } catch (SQLException e) {
      System.out.println(Json.stringify(sqlExceptionResult(e, started)));
    } catch (Exception e) {
      Map<String, Object> error = new LinkedHashMap<>();
      error.put("success", false);
      error.put("error", Map.of("type", e.getClass().getSimpleName(), "message", String.valueOf(e.getMessage())));
      error.put("elapsedMs", System.currentTimeMillis() - started);
      System.out.println(Json.stringify(error));
    }
  }

  private static Map<String, Object> execute(Map<String, Object> request, long started) throws Exception {
    String action = stringValue(request.get("action"));
    String jdbcUrl = stringValue(request.get("jdbcUrl"));
    String driverClass = stringValue(request.get("driverClass"));
    List<Object> driverJars = castList(request.get("driverJars"));
    String username = stringValue(request.get("username"));
    String password = stringValue(request.get("password"));
    int timeoutSeconds = intValue(request.getOrDefault("timeoutSeconds", 30));

    Driver driver = loadDriver(driverClass, driverJars);
    Properties props = new Properties();
    props.setProperty("user", username);
    props.setProperty("password", password);

    try (Connection connection = driver.connect(jdbcUrl, props)) {
      if (connection == null) {
        throw new SQLException("Driver did not accept jdbcUrl: " + jdbcUrl);
      }
      if ("testConnection".equals(action)) {
        return testConnection(connection, started);
      }
      if ("execute".equals(action)) {
        return executeSql(connection, request, timeoutSeconds, started);
      }
      throw new IllegalArgumentException("Unsupported action: " + action);
    }
  }

  private static Driver loadDriver(String driverClass, List<Object> driverJars) throws Exception {
    URL[] urls = new URL[driverJars.size()];
    for (int i = 0; i < driverJars.size(); i++) {
      urls[i] = new File(stringValue(driverJars.get(i))).toURI().toURL();
    }
    URLClassLoader classLoader = new URLClassLoader(urls, JdbcExecutor.class.getClassLoader());
    Class<?> clazz = Class.forName(driverClass, true, classLoader);
    Object instance = clazz.getDeclaredConstructor().newInstance();
    if (instance instanceof Driver) {
      return (Driver) instance;
    }
    for (Driver driver : ServiceLoader.load(Driver.class, classLoader)) {
      if (driver.getClass().getName().equals(driverClass)) return driver;
    }
    throw new IllegalArgumentException("Class is not a JDBC Driver: " + driverClass);
  }

  private static Map<String, Object> testConnection(Connection connection, long started) throws SQLException {
    DatabaseMetaData meta = connection.getMetaData();
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("success", true);
    result.put("elapsedMs", System.currentTimeMillis() - started);
    result.put("databaseProductName", meta.getDatabaseProductName());
    result.put("databaseProductVersion", meta.getDatabaseProductVersion());
    result.put("driverName", meta.getDriverName());
    result.put("driverVersion", meta.getDriverVersion());
    return result;
  }

  private static Map<String, Object> executeSql(Connection connection, Map<String, Object> request, int timeoutSeconds, long started) throws SQLException {
    String sql = stringValue(request.get("sql"));
    String sqlKind = stringValue(request.get("sqlKind"));
    int maxRows = intValue(request.getOrDefault("maxRows", 500));
    List<Object> params = request.containsKey("params") ? castList(request.get("params")) : List.of();

    connection.setAutoCommit(true);
    try (PreparedStatement statement = connection.prepareStatement(sql)) {
      statement.setQueryTimeout(timeoutSeconds);
      statement.setMaxRows(maxRows + 1);
      bindParams(statement, params);

      boolean hasResultSet = statement.execute();
      if (hasResultSet) {
        try (ResultSet rs = statement.getResultSet()) {
          return resultSetToJson(rs, maxRows, started);
        }
      }

      Map<String, Object> result = new LinkedHashMap<>();
      result.put("success", true);
      result.put("sqlKind", sqlKind == null || sqlKind.isBlank() ? "update" : sqlKind);
      result.put("elapsedMs", System.currentTimeMillis() - started);
      result.put("affectedRows", statement.getUpdateCount());
      return result;
    }
  }

  private static void bindParams(PreparedStatement statement, List<Object> params) throws SQLException {
    for (int i = 0; i < params.size(); i++) {
      statement.setObject(i + 1, params.get(i));
    }
  }

  private static Map<String, Object> resultSetToJson(ResultSet rs, int maxRows, long started) throws SQLException {
    ResultSetMetaData meta = rs.getMetaData();
    int count = meta.getColumnCount();
    List<Map<String, Object>> columns = new ArrayList<>();
    for (int i = 1; i <= count; i++) {
      Map<String, Object> column = new LinkedHashMap<>();
      column.put("name", meta.getColumnName(i));
      column.put("label", meta.getColumnLabel(i));
      column.put("typeName", meta.getColumnTypeName(i));
      column.put("jdbcType", meta.getColumnType(i));
      column.put("nullable", meta.isNullable(i) != ResultSetMetaData.columnNoNulls);
      columns.add(column);
    }

    List<Map<String, Object>> rows = new ArrayList<>();
    boolean truncated = false;
    while (rs.next()) {
      if (rows.size() >= maxRows) {
        truncated = true;
        break;
      }
      Map<String, Object> row = new LinkedHashMap<>();
      for (int i = 1; i <= count; i++) {
        String label = meta.getColumnLabel(i);
        row.put(label, normalizeValue(rs.getObject(i)));
      }
      rows.add(row);
    }

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("success", true);
    result.put("sqlKind", "query");
    result.put("elapsedMs", System.currentTimeMillis() - started);
    result.put("truncated", truncated);
    result.put("columns", columns);
    result.put("rows", rows);
    result.put("rowCount", rows.size());
    result.put("maxRows", maxRows);
    return result;
  }

  private static Object normalizeValue(Object value) {
    if (value == null) return null;
    if (value instanceof Timestamp) return value.toString();
    if (value instanceof java.sql.Date) return value.toString();
    if (value instanceof java.sql.Time) return value.toString();
    if (value instanceof BigDecimal) return value.toString();
    if (value instanceof byte[]) return "<binary " + ((byte[]) value).length + " bytes>";
    if (value instanceof TemporalAccessor) return value.toString();
    return value;
  }

  private static Map<String, Object> sqlExceptionResult(SQLException e, long started) {
    Map<String, Object> error = new LinkedHashMap<>();
    error.put("type", "SQLException");
    error.put("message", e.getMessage());
    error.put("sqlState", e.getSQLState());
    error.put("vendorCode", e.getErrorCode());

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("success", false);
    result.put("elapsedMs", System.currentTimeMillis() - started);
    result.put("error", error);
    return result;
  }

  private static String readAllStdin() throws Exception {
    BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
    StringBuilder builder = new StringBuilder();
    String line;
    while ((line = reader.readLine()) != null) builder.append(line).append('\n');
    return builder.toString();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> castMap(Object value) {
    return (Map<String, Object>) value;
  }

  @SuppressWarnings("unchecked")
  private static List<Object> castList(Object value) {
    return (List<Object>) value;
  }

  private static String stringValue(Object value) {
    return value == null ? null : String.valueOf(value);
  }

  private static int intValue(Object value) {
    if (value instanceof Number) return ((Number) value).intValue();
    return Integer.parseInt(String.valueOf(value));
  }

  static class Json {
    private final String text;
    private int index;

    private Json(String text) {
      this.text = text;
    }

    static Object parse(String text) {
      Json parser = new Json(text);
      Object value = parser.readValue();
      parser.skipWhitespace();
      return value;
    }

    static String stringify(Object value) {
      StringBuilder out = new StringBuilder();
      writeJson(out, value);
      return out.toString();
    }

    private Object readValue() {
      skipWhitespace();
      char c = text.charAt(index);
      if (c == '{') return readObject();
      if (c == '[') return readArray();
      if (c == '"') return readString();
      if (c == 't') { index += 4; return Boolean.TRUE; }
      if (c == 'f') { index += 5; return Boolean.FALSE; }
      if (c == 'n') { index += 4; return null; }
      return readNumber();
    }

    private Map<String, Object> readObject() {
      Map<String, Object> map = new LinkedHashMap<>();
      index++;
      skipWhitespace();
      if (text.charAt(index) == '}') { index++; return map; }
      while (true) {
        String key = readString();
        skipWhitespace();
        index++;
        Object value = readValue();
        map.put(key, value);
        skipWhitespace();
        char c = text.charAt(index++);
        if (c == '}') break;
      }
      return map;
    }

    private List<Object> readArray() {
      List<Object> list = new ArrayList<>();
      index++;
      skipWhitespace();
      if (text.charAt(index) == ']') { index++; return list; }
      while (true) {
        list.add(readValue());
        skipWhitespace();
        char c = text.charAt(index++);
        if (c == ']') break;
      }
      return list;
    }

    private String readString() {
      StringBuilder builder = new StringBuilder();
      index++;
      while (index < text.length()) {
        char c = text.charAt(index++);
        if (c == '"') break;
        if (c == '\\') {
          char escaped = text.charAt(index++);
          switch (escaped) {
            case '"': builder.append('"'); break;
            case '\\': builder.append('\\'); break;
            case '/': builder.append('/'); break;
            case 'b': builder.append('\b'); break;
            case 'f': builder.append('\f'); break;
            case 'n': builder.append('\n'); break;
            case 'r': builder.append('\r'); break;
            case 't': builder.append('\t'); break;
            case 'u':
              String hex = text.substring(index, index + 4);
              builder.append((char) Integer.parseInt(hex, 16));
              index += 4;
              break;
            default: builder.append(escaped);
          }
        } else {
          builder.append(c);
        }
      }
      return builder.toString();
    }

    private Number readNumber() {
      int start = index;
      while (index < text.length()) {
        char c = text.charAt(index);
        if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
          index++;
        } else {
          break;
        }
      }
      String number = text.substring(start, index);
      if (number.contains(".") || number.contains("e") || number.contains("E")) return Double.parseDouble(number);
      return Long.parseLong(number);
    }

    private void skipWhitespace() {
      while (index < text.length() && Character.isWhitespace(text.charAt(index))) index++;
    }

    @SuppressWarnings("unchecked")
    private static void writeJson(StringBuilder out, Object value) {
      if (value == null) { out.append("null"); return; }
      if (value instanceof String) { writeString(out, (String) value); return; }
      if (value instanceof Number || value instanceof Boolean) { out.append(value); return; }
      if (value instanceof Map) {
        out.append('{');
        boolean first = true;
        for (Map.Entry<Object, Object> entry : ((Map<Object, Object>) value).entrySet()) {
          if (!first) out.append(',');
          first = false;
          writeString(out, String.valueOf(entry.getKey()));
          out.append(':');
          writeJson(out, entry.getValue());
        }
        out.append('}');
        return;
      }
      if (value instanceof Iterable) {
        out.append('[');
        boolean first = true;
        for (Object item : (Iterable<?>) value) {
          if (!first) out.append(',');
          first = false;
          writeJson(out, item);
        }
        out.append(']');
        return;
      }
      writeString(out, String.valueOf(value));
    }

    private static void writeString(StringBuilder out, String value) {
      out.append('"');
      for (int i = 0; i < value.length(); i++) {
        char c = value.charAt(i);
        switch (c) {
          case '"': out.append("\\\""); break;
          case '\\': out.append("\\\\"); break;
          case '\b': out.append("\\b"); break;
          case '\f': out.append("\\f"); break;
          case '\n': out.append("\\n"); break;
          case '\r': out.append("\\r"); break;
          case '\t': out.append("\\t"); break;
          default:
            if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
            else out.append(c);
        }
      }
      out.append('"');
    }
  }
}
```

- [ ] **Step 2: Compile with Java 17+**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
JAVA_HOME=$(/usr/libexec/java_home -v 17+)
mkdir -p java/build
"$JAVA_HOME/bin/javac" -encoding UTF-8 -d java/build java/JdbcExecutor.java
```

Expected: command exits successfully and `java/build/JdbcExecutor.class` exists.

## Task 6: Add Java runner

**Files:**
- Create: `bs-jdbc-tool/src/java-runner.js`
- Test: `bs-jdbc-tool/test/node/java-runner.test.js`

- [ ] **Step 1: Write failing Java runner tests**

Create `bs-jdbc-tool/test/node/java-runner.test.js`:

```js
import assert from 'node:assert/strict';
import { javaTimeoutMs, executorErrorResult, buildExecutorRequest } from '../../src/java-runner.js';

test('computes Java timeout with buffer', () => {
  assert.equal(javaTimeoutMs(30), 35000);
});

test('builds executor request with absolute driver paths', () => {
  const request = buildExecutorRequest({
    action: 'testConnection',
    db: {
      jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
      driverClass: 'com.mysql.cj.jdbc.Driver',
      driverJars: ['drivers/mysql-connector-j.jar'],
      username: 'root',
      password: 'secret'
    },
    options: { maxRows: 100, timeoutSeconds: 10 },
    sql: undefined,
    params: undefined,
    sqlKind: undefined
  });

  assert.equal(request.action, 'testConnection');
  assert.equal(request.password, 'secret');
  assert.equal(request.driverJars.length, 1);
  assert.match(request.driverJars[0], /drivers\/mysql-connector-j\.jar$/);
});

test('wraps executor errors', () => {
  const result = executorErrorResult(new Error('boom'), 'demo');
  assert.equal(result.success, false);
  assert.equal(result.alias, 'demo');
  assert.equal(result.error.type, 'ExecutorError');
});
```

- [ ] **Step 2: Run Java runner tests and verify fail**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
node --test test/node/java-runner.test.js
```

Expected: FAIL because `src/java-runner.js` does not exist.

- [ ] **Step 3: Implement java-runner.js**

Create `bs-jdbc-tool/src/java-runner.js`:

```js
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveToolPath } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, '..');
const JAVA_SOURCE = path.join(TOOL_ROOT, 'java', 'JdbcExecutor.java');
const JAVA_BUILD = path.join(TOOL_ROOT, 'java', 'build');

export function javaTimeoutMs(timeoutSeconds) {
  return (Number(timeoutSeconds) + 5) * 1000;
}

export function findJavaHome() {
  if (process.env.JAVA_HOME) {
    const javaBin = path.join(process.env.JAVA_HOME, 'bin', 'java');
    const javacBin = path.join(process.env.JAVA_HOME, 'bin', 'javac');
    if (fs.existsSync(javaBin) && fs.existsSync(javacBin) && javaVersionAtLeast17(javaBin)) return process.env.JAVA_HOME;
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/libexec/java_home', ['-v', '17+'], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }

  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.status === 0 && versionOutputAtLeast17(java.stderr || java.stdout)) return undefined;

  throw new Error('Java 17+ is required. Install JDK 17+ or set JAVA_HOME to a compatible JDK.');
}

function javaVersionAtLeast17(javaBin) {
  const result = spawnSync(javaBin, ['-version'], { encoding: 'utf8' });
  return result.status === 0 && versionOutputAtLeast17(result.stderr || result.stdout);
}

function versionOutputAtLeast17(output) {
  const match = output.match(/version "(\d+)(?:\.|\")/);
  return Boolean(match && Number(match[1]) >= 17);
}

export function javaBin(name) {
  const javaHome = findJavaHome();
  return javaHome ? path.join(javaHome, 'bin', name) : name;
}

export function compileExecutor() {
  fs.mkdirSync(JAVA_BUILD, { recursive: true });
  const classFile = path.join(JAVA_BUILD, 'JdbcExecutor.class');
  if (fs.existsSync(classFile) && fs.statSync(classFile).mtimeMs >= fs.statSync(JAVA_SOURCE).mtimeMs) {
    return;
  }

  const result = spawnSync(javaBin('javac'), ['-encoding', 'UTF-8', '-d', JAVA_BUILD, JAVA_SOURCE], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Failed to compile JdbcExecutor.java: ${result.stderr || result.stdout}`);
  }
}

export function buildExecutorRequest({ action, db, options, sql, params, sqlKind }) {
  return {
    action,
    jdbcUrl: db.jdbcUrl,
    driverClass: db.driverClass,
    driverJars: db.driverJars.map(resolveToolPath),
    username: db.username,
    password: db.password,
    timeoutSeconds: options.timeoutSeconds,
    maxRows: options.maxRows,
    ...(sql ? { sql } : {}),
    ...(params ? { params } : {}),
    ...(sqlKind ? { sqlKind } : {})
  };
}

export async function runExecutor(request, timeoutSeconds) {
  compileExecutor();

  return await new Promise((resolve, reject) => {
    const child = spawn(javaBin('java'), ['-cp', JAVA_BUILD, 'JdbcExecutor'], {
      cwd: TOOL_ROOT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Java executor timed out after ${timeoutSeconds + 5} seconds`));
    }, javaTimeoutMs(timeoutSeconds));

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Java executor exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Java executor returned invalid JSON: ${stdout || stderr}`));
      }
    });

    child.stdin.end(JSON.stringify(request));
  });
}

export function executorErrorResult(error, alias = undefined) {
  return {
    success: false,
    ...(alias ? { alias } : {}),
    error: {
      type: 'ExecutorError',
      message: error.message,
      hint: 'Check Java 17+, driver jars, database network reachability, and timeout settings.'
    }
  };
}
```

- [ ] **Step 4: Run Java runner tests and verify pass**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
node --test test/node/java-runner.test.js
```

Expected: PASS.

- [ ] **Step 5: Compile executor through npm script**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm run compile:java
```

Expected: PASS and Java class files exist under `java/build/`.

## Task 7: Implement MCP tool handlers

**Files:**
- Create: `bs-jdbc-tool/src/tools/list-databases.js`
- Create: `bs-jdbc-tool/src/tools/describe-database.js`
- Create: `bs-jdbc-tool/src/tools/test-connection.js`
- Create: `bs-jdbc-tool/src/tools/jdbc-query.js`

- [ ] **Step 1: Create list-databases handler**

Create `bs-jdbc-tool/src/tools/list-databases.js`:

```js
import { databaseListItem, loadConfig } from '../config.js';

export const listDatabasesTool = {
  name: 'list_databases',
  description: 'List configured JDBC database aliases. Call this before querying when you do not know which alias to use.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  async handler() {
    const config = loadConfig();
    return {
      databases: Object.entries(config.databases).map(([alias, db]) => databaseListItem(alias, db, config.defaults))
    };
  }
};
```

- [ ] **Step 2: Create describe-database handler**

Create `bs-jdbc-tool/src/tools/describe-database.js`:

```js
import { getDatabaseConfig, loadConfig, redactDatabaseConfig } from '../config.js';

export const describeDatabaseTool = {
  name: 'describe_database',
  description: 'Show sanitized connection details for one JDBC database alias. Password is never returned.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Database alias from list_databases.' }
    },
    required: ['alias'],
    additionalProperties: false
  },
  async handler(input) {
    const config = loadConfig();
    const db = getDatabaseConfig(config, input.alias);
    return redactDatabaseConfig(input.alias, db, config.defaults);
  }
};
```

- [ ] **Step 3: Create jdbc_test_connection handler**

Create `bs-jdbc-tool/src/tools/test-connection.js`:

```js
import { getDatabaseConfig, loadConfig, resolveEffectiveOptions } from '../config.js';
import { buildExecutorRequest, runExecutor } from '../java-runner.js';

export const testConnectionTool = {
  name: 'jdbc_test_connection',
  description: 'Test whether a configured JDBC database alias can connect. Use this before the first query for an alias.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Database alias from list_databases.' },
      timeoutSeconds: { type: 'integer', description: 'Optional connection timeout seconds, capped by config.' }
    },
    required: ['alias'],
    additionalProperties: false
  },
  async handler(input) {
    const config = loadConfig();
    const db = getDatabaseConfig(config, input.alias);
    const options = resolveEffectiveOptions(input, config, db);
    const request = buildExecutorRequest({ action: 'testConnection', db, options });
    const result = await runExecutor(request, options.timeoutSeconds);
    return { alias: input.alias, type: db.type, ...result };
  }
};
```

- [ ] **Step 4: Create jdbc_query handler**

Create `bs-jdbc-tool/src/tools/jdbc-query.js`:

```js
import { getDatabaseConfig, loadConfig, resolveEffectiveOptions } from '../config.js';
import { buildExecutorRequest, runExecutor } from '../java-runner.js';
import { classifySql, ensureSingleStatement, SqlValidationError } from '../sql-validator.js';

export const jdbcQueryTool = {
  name: 'jdbc_query',
  description: 'Execute one JDBC SQL statement by database alias. Supports SELECT and, when config allowDml is true, INSERT/UPDATE/DELETE/MERGE/CALL/DDL. Use params for prepared statement placeholders.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: { type: 'string', description: 'Database alias from list_databases.' },
      sql: { type: 'string', description: 'One SQL statement. Use ? placeholders with params when possible.' },
      params: { type: 'array', description: 'PreparedStatement parameters.', items: {} },
      maxRows: { type: 'integer', description: 'Maximum rows to return for result sets, capped by config.' },
      timeoutSeconds: { type: 'integer', description: 'Query timeout seconds, capped by config.' }
    },
    required: ['alias', 'sql'],
    additionalProperties: false
  },
  async handler(input) {
    const config = loadConfig();
    const db = getDatabaseConfig(config, input.alias);
    const sql = ensureSingleStatement(input.sql);
    const sqlKind = classifySql(sql);
    const options = resolveEffectiveOptions(input, config, db);

    if (sqlKind === 'update' && !options.allowDml) {
      throw new SqlValidationError(`DML/DDL is disabled for alias: ${input.alias}`);
    }

    const request = buildExecutorRequest({
      action: 'execute',
      db,
      options,
      sql,
      params: input.params || [],
      sqlKind
    });
    const result = await runExecutor(request, options.timeoutSeconds);
    return { alias: input.alias, type: db.type, ...result };
  }
};
```

## Task 8: Implement MCP server entrypoint

**Files:**
- Create: `bs-jdbc-tool/src/server.js`

- [ ] **Step 1: Create server.js**

Create `bs-jdbc-tool/src/server.js`:

```js
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConfigError, configErrorResult } from './config.js';
import { executorErrorResult } from './java-runner.js';
import { SqlValidationError, sqlErrorResult } from './sql-validator.js';
import { listDatabasesTool } from './tools/list-databases.js';
import { describeDatabaseTool } from './tools/describe-database.js';
import { testConnectionTool } from './tools/test-connection.js';
import { jdbcQueryTool } from './tools/jdbc-query.js';

const tools = [listDatabasesTool, describeDatabaseTool, testConnectionTool, jdbcQueryTool];
const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

const server = new Server(
  { name: 'bs-jdbc-tool', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const tool = toolByName.get(name);
  if (!tool) {
    return jsonContent({ success: false, error: { type: 'ToolNotFound', message: `Unknown tool: ${name}` } }, true);
  }

  try {
    const result = await tool.handler(args);
    return jsonContent(result, false);
  } catch (error) {
    if (error instanceof ConfigError) return jsonContent(configErrorResult(error, args.alias), true);
    if (error instanceof SqlValidationError) return jsonContent(sqlErrorResult(error, args.alias), true);
    return jsonContent(executorErrorResult(error, args.alias), true);
  }
});

function jsonContent(value, isError) {
  return {
    isError,
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Make server executable**

Run:

```bash
chmod +x /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/src/server.js
```

Expected: command exits successfully.

- [ ] **Step 3: Verify server starts**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
node src/server.js
```

Expected: process waits on stdio without crashing. Stop with Ctrl+C.

## Task 9: Run unit tests and compile Java

**Files:**
- Uses all previous files.

- [ ] **Step 1: Run Node tests**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm test
```

Expected: all Node tests PASS.

- [ ] **Step 2: Compile Java executor**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm run compile:java
```

Expected: Java compilation PASS.

- [ ] **Step 3: Verify Java version used is 17+**

Run:

```bash
JAVA_HOME=$(/usr/libexec/java_home -v 17+)
"$JAVA_HOME/bin/java" -version
```

Expected: major version is 17 or newer.

## Task 10: Add README and Claude Code MCP configuration instructions

**Files:**
- Create: `bs-jdbc-tool/README.md`

- [ ] **Step 1: Create README.md**

Create `bs-jdbc-tool/README.md`:

```markdown
# bs-jdbc-tool

本工具是本地 Claude Code MCP Server，用于让 agent 根据数据库别名执行 JDBC SQL。

## 架构

- Node.js：MCP stdio server、配置加载、参数校验、子进程管理。
- Java：JDBC executor，负责加载驱动、连接数据库、执行 SQL。

## 前置要求

- Node.js
- Java 17 或更高版本
- JDBC driver jar

Oracle 使用 `ojdbc17`，因此必须使用 Java 17+。

## 安装

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm install
```

## 驱动

本机已从 DataGrip 驱动目录复制：

- `drivers/mysql-connector-j.jar`：MySQL Connector/J 9.7.0
- `drivers/ojdbc.jar`：Oracle ojdbc17 23.26.2.0.0

驱动 jar 不提交到版本库。

## 配置

真实配置文件：

```text
config.local.json
```

该文件包含明文密码，默认被 `.gitignore` 忽略。

初始别名：

- `dev-mysql`
- `dev-oracle`

请手动修改 `config.local.json` 中的密码占位符。

## 启动

```bash
npm start
```

## Claude Code MCP 配置

在 Claude Code 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "bs-jdbc-tool": {
      "command": "node",
      "args": ["/Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/src/server.js"]
    }
  }
}
```

## Tools

### list_databases

列出可用数据库别名。

### describe_database

查看某个别名的脱敏配置，不返回密码。

### jdbc_test_connection

测试某个别名能否连接。

### jdbc_query

执行单条 SQL。支持 `params` 参数绑定。配置允许时支持 DML/DDL。

## 验证

```bash
npm test
npm run compile:java
```

在 Claude Code 中验证：

1. 调用 `list_databases`
2. 调用 `jdbc_test_connection` 测试 `dev-mysql`
3. 调用 `jdbc_query` 执行 `select 1`
4. 调用 `jdbc_test_connection` 测试 `dev-oracle`
5. 调用 `jdbc_query` 执行 Oracle 简单查询，例如 `select 1 from dual`
```

- [ ] **Step 2: Verify README contains password warning**

Run:

```bash
grep -n "明文密码" /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/README.md
```

Expected: output includes the config warning.

## Task 11: End-to-end local verification

**Files:**
- Uses all previous files.

- [ ] **Step 1: Run full local checks**

Run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm test
npm run compile:java
```

Expected: both commands PASS.

- [ ] **Step 2: Confirm config does not expose real passwords yet**

Run:

```bash
grep -n "请在此处填写" /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/config.local.json
```

Expected: output shows both MySQL and Oracle password placeholders.

- [ ] **Step 3: Ask user to fill passwords**

Tell the user to edit:

```text
/Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool/config.local.json
```

and replace:

```text
请在此处填写MySQL密码
请在此处填写Oracle密码
```

with actual passwords.

- [ ] **Step 4: After passwords are filled, test MySQL through MCP tool**

Use Claude Code MCP tool call or an MCP inspector to call:

```json
{
  "tool": "jdbc_test_connection",
  "arguments": {
    "alias": "dev-mysql",
    "timeoutSeconds": 10
  }
}
```

Expected: `success: true` and database product metadata.

- [ ] **Step 5: After passwords are filled, test Oracle through MCP tool**

Use Claude Code MCP tool call or an MCP inspector to call:

```json
{
  "tool": "jdbc_test_connection",
  "arguments": {
    "alias": "dev-oracle",
    "timeoutSeconds": 10
  }
}
```

Expected: `success: true` and database product metadata.

- [ ] **Step 6: Run read-only smoke queries**

MySQL:

```json
{
  "tool": "jdbc_query",
  "arguments": {
    "alias": "dev-mysql",
    "sql": "select 1 as value",
    "maxRows": 10,
    "timeoutSeconds": 10
  }
}
```

Oracle:

```json
{
  "tool": "jdbc_query",
  "arguments": {
    "alias": "dev-oracle",
    "sql": "select 1 as value from dual",
    "maxRows": 10,
    "timeoutSeconds": 10
  }
}
```

Expected: each returns one row with `value` equal to 1.

## Self-Review Checklist

- Spec coverage:
  - Node MCP server: covered by Tasks 7 and 8.
  - Java JDBC executor: covered by Tasks 5 and 6.
  - MySQL/Oracle initial config with password placeholders: covered by Task 3.
  - Latest DataGrip drivers: covered by Task 2.
  - Java 17+ requirement for ojdbc17: covered by Tasks 6 and 9.
  - Password redaction: covered by Task 3 tests and tool handlers.
  - Single SQL, DML config, max rows, timeout: covered by Tasks 3, 4, and 7.
  - README and MCP setup: covered by Task 10.
- Placeholder scan: no implementation step uses TBD/TODO. Password placeholders are intentional user-filled config values.
- Type consistency: tool names, config fields, and Java request fields are consistent across tasks.

## Verification Summary

Before marking complete, run:

```bash
cd /Users/zhangzhengqing/work/project/bs-project-tools/bs-jdbc-tool
npm test
npm run compile:java
ls -lh drivers/*.jar
```

Then, after the user manually fills passwords, verify through MCP:

- `list_databases`
- `describe_database` for `dev-mysql` and `dev-oracle`
- `jdbc_test_connection` for both aliases
- `jdbc_query` with `select 1 as value` for MySQL
- `jdbc_query` with `select 1 as value from dual` for Oracle
