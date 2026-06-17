import { loadConfig, getDatabaseConfig, resolveEffectiveOptions } from '../config.js';
import { buildExecutorRequest, runExecutor } from '../java-runner.js';

export const testConnectionTool = {
  name: 'jdbc_test_connection',
  description: 'Test if a database connection can be established successfully for a given database alias.',
  inputSchema: {
    type: 'object',
    properties: {
      alias: {
        type: 'string',
        description: 'The database alias to test'
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Connection timeout in seconds (optional, defaults to config value or 30)'
      }
    },
    required: ['alias']
  },
  async handler({ alias, timeoutSeconds }) {
    const config = loadConfig();
    const db = getDatabaseConfig(config, alias);
    const options = resolveEffectiveOptions({ timeoutSeconds }, config, db);
    const request = buildExecutorRequest({ action: 'testConnection', db, options });
    const result = await runExecutor(request, options.timeoutSeconds);
    return {
      alias,
      type: db.type,
      ...result
    };
  }
};

export default testConnectionTool;
