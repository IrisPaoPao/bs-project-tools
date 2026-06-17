import { loadConfig, getDatabaseConfig, resolveEffectiveOptions } from '../config.js';
import { ensureSingleStatement, classifySql, SqlValidationError } from '../sql-validator.js';
import { buildExecutorRequest, runExecutor } from '../java-runner.js';

export const jdbcBatchTool = {
  name: 'jdbc_batch',
  description: 'Execute multiple SQL statements in a single database connection with configurable transaction mode. For abort mode (default), all statements roll back on any failure. For continue mode, failures are recorded and successful statements commit.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: {
        type: 'string',
        description: 'The database alias to query'
      },
      statements: {
        type: 'array',
        description: 'Array of SQL statements to execute',
        items: {
          type: 'object',
          properties: {
            sql: { type: 'string', description: 'SQL statement' },
            params: {
              type: 'array',
              description: 'Optional parameter values for prepared statement',
              items: { type: ['string', 'number', 'boolean', 'null'] }
            }
          },
          required: ['sql']
        },
        minItems: 1
      },
      onError: {
        type: 'string',
        enum: ['abort', 'continue'],
        description: 'Transaction mode on error: abort (rollback all, default) or continue (commit successful statements)'
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Per-statement query timeout in seconds (optional, limited by config)'
      }
    },
    required: ['alias', 'statements']
  },
  async handler({ alias, statements, onError, timeoutSeconds }) {
    const config = loadConfig();
    const db = getDatabaseConfig(config, alias);
    const options = resolveEffectiveOptions({ timeoutSeconds }, config, db);

    // Validate statements array
    if (!Array.isArray(statements) || statements.length === 0) {
      throw new SqlValidationError('statements must be a non-empty array');
    }

    // Check batch size limit
    if (statements.length > options.maxBatchSize) {
      throw new SqlValidationError(`Batch size ${statements.length} exceeds maxBatchSize ${options.maxBatchSize}`);
    }

    // Pre-validate every statement: single-statement + allowDml check
    const cleanStatements = statements.map((s, idx) => {
      if (!s || typeof s.sql !== 'string') {
        throw new SqlValidationError(`Statement ${idx}: must have a 'sql' string property`);
      }
      const cleanSql = ensureSingleStatement(s.sql);
      const sqlKind = classifySql(cleanSql);

      // Check DML permission for each statement
      if (sqlKind === 'update' && !options.allowDml) {
        throw new SqlValidationError(`Statement ${idx}: UPDATE/INSERT/DELETE statements are disabled. Set allowDml: true in config to enable.`);
      }

      return { sql: cleanSql, params: s.params || [] };
    });

    const request = buildExecutorRequest({
      action: 'executeBatch',
      db,
      options,
      statements: cleanStatements,
      mode: onError || 'abort'
    });

    const result = await runExecutor(request, options.timeoutSeconds);
    return {
      alias,
      type: db.type,
      ...result
    };
  }
};

export default jdbcBatchTool;
