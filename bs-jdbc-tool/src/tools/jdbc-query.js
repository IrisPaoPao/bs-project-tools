import { loadConfig, getDatabaseConfig, resolveEffectiveOptions } from '../config.js';
import { ensureSingleStatement, classifySql, SqlValidationError } from '../sql-validator.js';
import { buildExecutorRequest, runExecutor } from '../java-runner.js';

export const jdbcQueryTool = {
  name: 'jdbc_query',
  description: 'Execute a SQL statement (query or update) against a configured database. For SELECT queries, returns rows and column metadata. For UPDATE/INSERT/DELETE, returns affected row count. Only one statement per call is allowed.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: {
        type: 'string',
        description: 'The database alias to query'
      },
      sql: {
        type: 'string',
        description: 'SQL statement to execute (SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, etc.)'
      },
      params: {
        type: 'array',
        description: 'Optional array of parameter values for prepared statements',
        items: {
          type: ['string', 'number', 'boolean', 'null']
        }
      },
      maxRows: {
        type: 'number',
        description: 'Maximum number of rows to return for queries (optional, limited by config)'
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Query timeout in seconds (optional, limited by config)'
      }
    },
    required: ['alias', 'sql']
  },
  async handler({ alias, sql, params, maxRows, timeoutSeconds }) {
    const config = loadConfig();
    const db = getDatabaseConfig(config, alias);
    const options = resolveEffectiveOptions({ maxRows, timeoutSeconds }, config, db);

    // Validate SQL is a single statement
    const cleanSql = ensureSingleStatement(sql);
    const sqlKind = classifySql(cleanSql);

    // Check DML permission
    if (sqlKind === 'update' && !options.allowDml) {
      throw new SqlValidationError('UPDATE/INSERT/DELETE statements are disabled. Set allowDml: true in config to enable.');
    }

    const request = buildExecutorRequest({
      action: 'execute',
      db,
      options,
      sql: cleanSql,
      params,
      sqlKind
    });

    const result = await runExecutor(request, options.timeoutSeconds);
    return {
      alias,
      type: db.type,
      sqlKind,
      ...result
    };
  }
};

export default jdbcQueryTool;
