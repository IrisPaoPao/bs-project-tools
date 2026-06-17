import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfigFromFile,
  loadConfig,
  redactDatabaseConfig,
  redactJdbcUrl,
  resolveEffectiveOptions,
  ConfigError,
  databaseListItem,
  configErrorResult,
  getDatabaseConfig,
  defaultConfigPath,
  resolveToolPath
} from '../../src/config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

test('redacts placeholder password - no password field returned when no password set', () => {
  const redacted = redactDatabaseConfig('demo', {
    type: 'mysql',
    description: 'demo db',
    jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
    driverClass: 'com.mysql.cj.jdbc.Driver',
    driverJars: ['drivers/mysql-connector-j.jar'],
    username: 'root',
    password: ''
  });

  assert.equal(redacted.alias, 'demo');
  assert.equal(redacted.hasPassword, false);
  assert.equal(Object.hasOwn(redacted, 'password'), false);
});

test('resolves options with caps', () => {
  const options = resolveEffectiveOptions(
    { maxRows: 9999, timeoutSeconds: 9999 },
    { defaults: { maxRows: 100, maxRowsLimit: 500, timeoutSeconds: 10, timeoutSecondsLimit: 60, allowDml: true } },
    { defaults: { maxRows: 200, timeoutSeconds: 20 } }
  );

  assert.equal(options.maxRows, 500);
  assert.equal(options.timeoutSeconds, 60);
  assert.equal(options.allowDml, true);
});

test('resolves options with builtin defaults when missing', () => {
  const options = resolveEffectiveOptions({}, {}, {});
  assert.equal(options.maxRows, 500);
  assert.equal(options.timeoutSeconds, 30);
  assert.equal(options.allowDml, true);
});

test('resolves options without NaN when all defaults missing', () => {
  const options = resolveEffectiveOptions({ maxRows: undefined, timeoutSeconds: undefined }, {}, {});
  assert.equal(Number.isNaN(options.maxRows), false);
  assert.equal(Number.isNaN(options.timeoutSeconds), false);
  assert.equal(options.maxRows, 500);
  assert.equal(options.timeoutSeconds, 30);
});

test('database defaults override config defaults in resolveEffectiveOptions', () => {
  const options = resolveEffectiveOptions(
    {},
    { defaults: { maxRows: 100, timeoutSeconds: 30 } },
    { defaults: { maxRows: 500, timeoutSeconds: 60 } }
  );
  assert.equal(options.maxRows, 500);
  assert.equal(options.timeoutSeconds, 60);
});

test('request options override database and config defaults', () => {
  const options = resolveEffectiveOptions(
    { maxRows: 200, timeoutSeconds: 45 },
    { defaults: { maxRows: 100, timeoutSeconds: 30 } },
    { defaults: { maxRows: 500, timeoutSeconds: 60 } }
  );
  assert.equal(options.maxRows, 200);
  assert.equal(options.timeoutSeconds, 45);
});

test('throws ConfigError for missing required fields', () => {
  const file = writeTempConfig({ databases: { bad: { type: 'mysql', password: '' } } });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.equal(err instanceof ConfigError, true);
      assert.equal(err.name, 'ConfigError');
      assert.match(err.message, /Missing required field databases\.bad\.jdbcUrl/);
      return true;
    }
  );
});

test('throws ConfigError for invalid JSON', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-jdbc-config-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, 'invalid json');

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.equal(err instanceof ConfigError, true);
      assert.match(err.message, /Invalid JSON/);
      return true;
    }
  );
});

test('throws ConfigError for missing databases config', () => {
  const file = writeTempConfig({});

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.equal(err instanceof ConfigError, true);
      assert.match(err.message, /Missing or invalid "databases"/);
      return true;
    }
  );
});

test('databaseListItem returns redacted database info without jdbcUrl or username', () => {
  const item = databaseListItem('demo', {
    type: 'mysql',
    description: 'demo db',
    jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
    driverClass: 'com.mysql.cj.jdbc.Driver',
    driverJars: ['drivers/mysql.jar'],
    username: 'root',
    password: 'secret'
  });

  assert.equal(item.alias, 'demo');
  assert.equal(item.type, 'mysql');
  assert.equal(item.description, 'demo db');
  assert.equal(Object.hasOwn(item, 'password'), false);
  assert.equal(Object.hasOwn(item, 'jdbcUrl'), false);
  assert.equal(Object.hasOwn(item, 'username'), false);
  assert.equal(Object.hasOwn(item, 'driverClass'), false);
  assert.ok(Object.hasOwn(item, 'defaults'));
});

test('configErrorResult returns error result with ConfigError type', () => {
  const result = configErrorResult('something went wrong');

  assert.equal(result.success, false);
  assert.equal(result.error.type, 'ConfigError');
  assert.equal(result.error.message, 'something went wrong');
});

test('configErrorResult includes alias when provided', () => {
  const result = configErrorResult('something went wrong', 'demo-db');

  assert.equal(result.success, false);
  assert.equal(result.alias, 'demo-db');
  assert.equal(result.error.type, 'ConfigError');
});

test('configErrorResult includes hint from ConfigError', () => {
  const err = new ConfigError('Database not found');
  err.hint = 'Call list_databases';
  const result = configErrorResult(err, 'demo');

  assert.equal(result.success, false);
  assert.equal(result.error.message, 'Database not found');
  assert.equal(result.error.hint, 'Call list_databases');
});

test('getDatabaseConfig returns database config by alias', () => {
  const config = {
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  };

  const db = getDatabaseConfig(config, 'demo');
  assert.equal(db.type, 'mysql');
  assert.equal(db.jdbcUrl, 'jdbc:mysql://localhost:3306/demo');
});

test('getDatabaseConfig throws ConfigError with hint for unknown alias', () => {
  const config = { databases: { demo: { type: 'mysql' } } };

  assert.throws(
    () => getDatabaseConfig(config, 'unknown'),
    (err) => {
      assert.equal(err instanceof ConfigError, true);
      assert.match(err.message, /Database not found: unknown/);
      assert.match(err.hint, /Call list_databases/);
      return true;
    }
  );
});

test('defaultConfigPath returns config.local.json in project root by default', () => {
  const expected = path.join(PROJECT_ROOT, 'config.local.json');
  assert.equal(defaultConfigPath(), expected);
});

test('defaultConfigPath supports BS_JDBC_TOOL_CONFIG override', () => {
  const originalEnv = process.env.BS_JDBC_TOOL_CONFIG;
  process.env.BS_JDBC_TOOL_CONFIG = '/custom/path/config.json';

  try {
    assert.equal(defaultConfigPath(), '/custom/path/config.json');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.BS_JDBC_TOOL_CONFIG;
    } else {
      process.env.BS_JDBC_TOOL_CONFIG = originalEnv;
    }
  }
});

test('resolveToolPath resolves relative path against project root, not cwd', () => {
  const expected = path.join(PROJECT_ROOT, 'drivers/mysql.jar');
  assert.equal(resolveToolPath('drivers/mysql.jar'), expected);
});

test('resolveToolPath returns absolute path unchanged', () => {
  const absolute = '/absolute/path/driver.jar';
  assert.equal(resolveToolPath(absolute), absolute);
});

test('resolveToolPath is stable regardless of cwd', () => {
  const originalCwd = process.cwd();
  process.chdir(tmpdir());

  try {
    const expected = path.join(PROJECT_ROOT, 'drivers/mysql.jar');
    assert.equal(resolveToolPath('drivers/mysql.jar'), expected);
  } finally {
    process.chdir(originalCwd);
  }
});

test('loadConfig loads from default path with environment override', () => {
  const file = writeTempConfig({
    databases: {
      testdb: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/test',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  const originalEnv = process.env.BS_JDBC_TOOL_CONFIG;
  process.env.BS_JDBC_TOOL_CONFIG = file;

  try {
    const config = loadConfig({ checkDriverFiles: false });
    assert.equal(config.databases.testdb.type, 'mysql');
  } finally {
    if (originalEnv === undefined) {
      delete process.env.BS_JDBC_TOOL_CONFIG;
    } else {
      process.env.BS_JDBC_TOOL_CONFIG = originalEnv;
    }
  }
});

test('validates driverJars must be non-empty array', () => {
  const file = writeTempConfig({
    databases: {
      bad: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/test',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: [],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /driverJars must be a non-empty array/);
      return true;
    }
  );
});

test('validates type must be string', () => {
  const file = writeTempConfig({
    databases: {
      bad: {
        type: 123,
        jdbcUrl: 'jdbc:mysql://localhost:3306/test',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /type must be a string/);
      return true;
    }
  );
});

test('validates jdbcUrl must be string', () => {
  const file = writeTempConfig({
    databases: {
      bad: {
        type: 'mysql',
        jdbcUrl: 123,
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /jdbcUrl must be a string/);
      return true;
    }
  );
});

test('validates password must exist (can be empty string)', () => {
  const file = writeTempConfig({
    databases: {
      bad: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/test',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root'
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /Missing required field databases\.bad\.password/);
      return true;
    }
  );
});

test('validates password must be string', () => {
  const file = writeTempConfig({
    databases: {
      bad: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/test',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: null
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /password must be a string/);
      return true;
    }
  );
});

test('redactJdbcUrl replaces password parameter', () => {
  const url = 'jdbc:mysql://localhost:3306/db?user=root&password=secret123';
  const redacted = redactJdbcUrl(url);
  assert.equal(redacted, 'jdbc:mysql://localhost:3306/db?user=root&password=***');
});

test('redactJdbcUrl replaces pwd parameter', () => {
  const url = 'jdbc:oracle:thin:@localhost:1521/pdb?pwd=tiger&foo=bar';
  const redacted = redactJdbcUrl(url);
  assert.equal(redacted, 'jdbc:oracle:thin:@localhost:1521/pdb?pwd=***&foo=bar');
});

test('redactJdbcUrl handles semicolon separators', () => {
  const url = 'jdbc:sqlserver://localhost;databaseName=db;user=sa;password=secret;';
  const redacted = redactJdbcUrl(url);
  assert.equal(redacted, 'jdbc:sqlserver://localhost;databaseName=db;user=sa;password=***;');
});

test('redactJdbcUrl is case insensitive', () => {
  const url = 'jdbc:mysql://localhost?PASSWORD=secret&PWD=test';
  const redacted = redactJdbcUrl(url);
  assert.equal(redacted, 'jdbc:mysql://localhost?PASSWORD=***&PWD=***');
});

test('redactDatabaseConfig redacts jdbcUrl with embedded password', () => {
  const redacted = redactDatabaseConfig('demo', {
    type: 'mysql',
    jdbcUrl: 'jdbc:mysql://localhost:3306/db?password=secret123',
    driverClass: 'com.mysql.cj.jdbc.Driver',
    driverJars: ['drivers/mysql.jar'],
    username: 'root',
    password: 'separatepassword'
  });

  assert.equal(redacted.jdbcUrl, 'jdbc:mysql://localhost:3306/db?password=***');
  assert.equal(redacted.hasPassword, true);
});

test('loadConfigFromFile merges BUILTIN_DEFAULTS with config.defaults', () => {
  const file = writeTempConfig({
    defaults: { maxRows: 100 },
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  const config = loadConfigFromFile(file, { checkDriverFiles: false });
  assert.equal(config.defaults.maxRows, 100); // from config
  assert.equal(config.defaults.maxRowsLimit, 5000); // from builtin
  assert.equal(config.defaults.timeoutSeconds, 30); // from builtin
  assert.equal(config.defaults.allowDml, true); // from builtin
});

test('validates defaults.maxRows must be positive integer', () => {
  const file = writeTempConfig({
    defaults: { maxRows: 'not-a-number' },
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /defaults\.maxRows must be a positive integer/);
      return true;
    }
  );
});

test('validates defaults.allowDml must be boolean', () => {
  const file = writeTempConfig({
    defaults: { allowDml: 'true' },
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /defaults\.allowDml must be a boolean/);
      return true;
    }
  );
});

test('database config preserves password (not redacted)', () => {
  const file = writeTempConfig({
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: 'mysecret'
      }
    }
  });

  const config = loadConfigFromFile(file, { checkDriverFiles: false });
  assert.equal(config.databases.demo.password, 'mysecret');
});

test('allowDml cannot be overridden by toolInput - security fix', () => {
  // toolInput.allowDml=true but config.defaults.allowDml=false
  const options = resolveEffectiveOptions(
    { allowDml: true },
    { defaults: { allowDml: false } },
    {} // db.defaults absent
  );
  assert.equal(options.allowDml, false);
});

test('allowDml from db.defaults overrides config.defaults', () => {
  // db.defaults.allowDml=true overrides config.defaults.allowDml=false
  const options = resolveEffectiveOptions(
    {},
    { defaults: { allowDml: false } },
    { defaults: { allowDml: true } }
  );
  assert.equal(options.allowDml, true);
});

test('toolInput.allowDml is completely ignored regardless of value', () => {
  // Even with toolInput.allowDml=true, it should not affect the result
  const options1 = resolveEffectiveOptions(
    { allowDml: true },
    {},
    {}
  );
  assert.equal(options1.allowDml, true); // BUILTIN_DEFAULTS is true

  const options2 = resolveEffectiveOptions(
    { allowDml: false },
    {},
    {}
  );
  assert.equal(options2.allowDml, true); // Still BUILTIN_DEFAULTS true
});

test('maxBatchSize resolves from builtin → global defaults → db defaults', () => {
  const config = {
    defaults: { maxBatchSize: 300 },
    databases: {
      test1: { driverClass: 'x', jdbcUrl: 'x', driverJars: ['x.jar'] },
      test2: { driverClass: 'x', jdbcUrl: 'x', driverJars: ['x.jar'], defaults: { maxBatchSize: 400 } }
    }
  };

  // Uses global default when no db defaults
  const noDefaults = getDatabaseConfig(config, 'test1');
  const opts1 = resolveEffectiveOptions({}, config, noDefaults);
  assert.equal(opts1.maxBatchSize, 300);  // global default wins

  // DB default overrides global
  const withDbDefaults = getDatabaseConfig(config, 'test2');
  const opts2 = resolveEffectiveOptions({}, config, withDbDefaults);
  assert.equal(opts2.maxBatchSize, 400);
});

test('maxBatchSize validation rejects non-positive integers', () => {
  const file1 = writeTempConfig({
    defaults: { maxBatchSize: 0 },
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file1, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /defaults\.maxBatchSize must be a positive integer/);
      return true;
    }
  );

  const file2 = writeTempConfig({
    defaults: { maxBatchSize: -5 },
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file2, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /defaults\.maxBatchSize must be a positive integer/);
      return true;
    }
  );

  const file3 = writeTempConfig({
    defaults: { maxBatchSize: 'large' },
    databases: {
      demo: {
        type: 'mysql',
        jdbcUrl: 'jdbc:mysql://localhost:3306/demo',
        driverClass: 'com.mysql.cj.jdbc.Driver',
        driverJars: ['drivers/mysql.jar'],
        username: 'root',
        password: ''
      }
    }
  });

  assert.throws(
    () => loadConfigFromFile(file3, { checkDriverFiles: false }),
    (err) => {
      assert.match(err.message, /defaults\.maxBatchSize must be a positive integer/);
      return true;
    }
  );
});
