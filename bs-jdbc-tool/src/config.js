import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_DB_FIELDS = ['type', 'jdbcUrl', 'driverClass', 'driverJars', 'username', 'password'];

const BUILTIN_DEFAULTS = {
  maxRows: 500,
  maxRowsLimit: 5000,
  timeoutSeconds: 30,
  timeoutSecondsLimit: 120,
  allowDml: true,
  maxBatchSize: 200
};

// Project root directory (where src/config.js lives)
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function defaultConfigPath() {
  return process.env.BS_JDBC_TOOL_CONFIG || path.join(PROJECT_ROOT, 'config.local.json');
}

export function resolveToolPath(relativePath) {
  if (path.isAbsolute(relativePath)) {
    return relativePath;
  }
  return path.resolve(PROJECT_ROOT, relativePath);
}

export function getDatabaseConfig(config, alias) {
  const db = config.databases?.[alias];
  if (!db) {
    const err = new ConfigError(`Database not found: ${alias}`);
    err.hint = 'Call list_databases to see available aliases.';
    throw err;
  }
  return db;
}

export function redactJdbcUrl(url) {
  if (typeof url !== 'string') return url;
  return url
    .replace(/(password=)[^&;]+/gi, '$1***')
    .replace(/(pwd=)[^&;]+/gi, '$1***');
}

export function redactDatabaseConfig(alias, db) {
  const { password, ...rest } = db;
  return {
    alias,
    type: rest.type,
    description: rest.description,
    jdbcUrl: redactJdbcUrl(rest.jdbcUrl),
    driverClass: rest.driverClass,
    driverJars: rest.driverJars,
    username: rest.username,
    hasPassword: !!password,
    defaults: rest.defaults
  };
}

export function databaseListItem(alias, db) {
  return {
    alias,
    type: db.type,
    description: db.description,
    defaults: {
      maxRows: db.defaults?.maxRows,
      timeoutSeconds: db.defaults?.timeoutSeconds,
      allowDml: db.defaults?.allowDml
    }
  };
}

export function resolveEffectiveOptions(toolInput, config, db) {
  const configDefaults = { ...BUILTIN_DEFAULTS, ...config?.defaults };
  const dbDefaults = db?.defaults || {};
  const input = toolInput || {};

  const maxRowsLimit = Number(configDefaults.maxRowsLimit) || BUILTIN_DEFAULTS.maxRowsLimit;
  const timeoutSecondsLimit = Number(configDefaults.timeoutSecondsLimit) || BUILTIN_DEFAULTS.timeoutSecondsLimit;

  const maxRowsRaw = input.maxRows ?? dbDefaults.maxRows ?? configDefaults.maxRows ?? BUILTIN_DEFAULTS.maxRows;
  const timeoutSecondsRaw = input.timeoutSeconds ?? dbDefaults.timeoutSeconds ?? configDefaults.timeoutSeconds ?? BUILTIN_DEFAULTS.timeoutSeconds;
  // allowDml must NOT come from toolInput - security restriction
  const allowDml = dbDefaults.allowDml ?? configDefaults.allowDml ?? BUILTIN_DEFAULTS.allowDml;
  // maxBatchSize must NOT come from toolInput - security restriction
  const maxBatchSize = dbDefaults.maxBatchSize ?? configDefaults.maxBatchSize ?? BUILTIN_DEFAULTS.maxBatchSize;

  const maxRows = Math.min(Number(maxRowsRaw) || 0, maxRowsLimit) || BUILTIN_DEFAULTS.maxRows;
  const timeoutSeconds = Math.min(Number(timeoutSecondsRaw) || 0, timeoutSecondsLimit) || BUILTIN_DEFAULTS.timeoutSeconds;

  return {
    maxRows,
    timeoutSeconds,
    allowDml,
    maxBatchSize
  };
}

export function configErrorResult(errorOrMessage, alias) {
  const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);
  const hint = errorOrMessage instanceof Error ? errorOrMessage.hint : undefined;

  const result = {
    success: false,
    error: {
      type: 'ConfigError',
      message
    }
  };

  if (alias !== undefined) {
    result.alias = alias;
  }

  if (hint !== undefined) {
    result.error.hint = hint;
  }

  return result;
}

function validateDefaults(defaults, path) {
  if (!defaults) return;

  if ('maxRows' in defaults && (!Number.isInteger(defaults.maxRows) || defaults.maxRows <= 0)) {
    throw new ConfigError(`${path}.maxRows must be a positive integer`);
  }
  if ('maxRowsLimit' in defaults && (!Number.isInteger(defaults.maxRowsLimit) || defaults.maxRowsLimit <= 0)) {
    throw new ConfigError(`${path}.maxRowsLimit must be a positive integer`);
  }
  if ('timeoutSeconds' in defaults && (!Number.isInteger(defaults.timeoutSeconds) || defaults.timeoutSeconds <= 0)) {
    throw new ConfigError(`${path}.timeoutSeconds must be a positive integer`);
  }
  if ('timeoutSecondsLimit' in defaults && (!Number.isInteger(defaults.timeoutSecondsLimit) || defaults.timeoutSecondsLimit <= 0)) {
    throw new ConfigError(`${path}.timeoutSecondsLimit must be a positive integer`);
  }
  if ('allowDml' in defaults && typeof defaults.allowDml !== 'boolean') {
    throw new ConfigError(`${path}.allowDml must be a boolean`);
  }
  if ('maxBatchSize' in defaults) {
    if (typeof defaults.maxBatchSize !== 'number' || !Number.isInteger(defaults.maxBatchSize) || defaults.maxBatchSize <= 0) {
      throw new ConfigError(`${path}.maxBatchSize must be a positive integer`);
    }
  }
}

function validateDatabaseConfig(alias, db, checkDriverFiles = true) {
  for (const field of REQUIRED_DB_FIELDS) {
    if (db[field] === undefined) {
      throw new ConfigError(`Missing required field databases.${alias}.${field}`);
    }
  }

  // Type validations
  if (typeof db.type !== 'string') {
    throw new ConfigError(`databases.${alias}.type must be a string`);
  }
  if (typeof db.jdbcUrl !== 'string') {
    throw new ConfigError(`databases.${alias}.jdbcUrl must be a string`);
  }
  if (typeof db.driverClass !== 'string') {
    throw new ConfigError(`databases.${alias}.driverClass must be a string`);
  }
  if (typeof db.username !== 'string') {
    throw new ConfigError(`databases.${alias}.username must be a string`);
  }
  if (typeof db.password !== 'string') {
    throw new ConfigError(`databases.${alias}.password must be a string (can be empty)`);
  }
  if (!Array.isArray(db.driverJars) || db.driverJars.length === 0) {
    throw new ConfigError(`databases.${alias}.driverJars must be a non-empty array`);
  }
  for (const jar of db.driverJars) {
    if (typeof jar !== 'string' || jar.trim() === '') {
      throw new ConfigError(`databases.${alias}.driverJars must contain non-empty strings`);
    }
  }

  if (db.defaults) {
    validateDefaults(db.defaults, `databases.${alias}.defaults`);
  }

  if (checkDriverFiles) {
    for (const jar of db.driverJars) {
      const jarPath = resolveToolPath(jar);
      if (!fs.existsSync(jarPath)) {
        throw new ConfigError(`Driver jar not found: ${jarPath}`);
      }
    }
  }
}

export function loadConfigFromFile(filePath, options = {}) {
  const { checkDriverFiles = true } = options;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new ConfigError(`Failed to read config file: ${filePath}`);
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Invalid JSON in config file: ${filePath}`);
  }

  if (!config.databases || typeof config.databases !== 'object') {
    throw new ConfigError('Missing or invalid "databases" in config');
  }

  if (config.defaults) {
    validateDefaults(config.defaults, 'defaults');
  }

  for (const [alias, db] of Object.entries(config.databases)) {
    validateDatabaseConfig(alias, db, checkDriverFiles);
  }

  // Merge builtin defaults with config.defaults
  config.defaults = { ...BUILTIN_DEFAULTS, ...config.defaults };

  return config;
}

export function loadConfig(options = {}) {
  return loadConfigFromFile(defaultConfigPath(), options);
}
