import { loadConfig, getDatabaseConfig, redactDatabaseConfig } from '../config.js';

export const describeDatabaseTool = {
  name: 'describe_database',
  description: 'Get detailed configuration for a specific database by alias. Returns redacted configuration (password is hidden, sensitive parameters in JDBC URL are redacted).',
  inputSchema: {
    type: 'object',
    properties: {
      alias: {
        type: 'string',
        description: 'The database alias to describe'
      }
    },
    required: ['alias']
  },
  async handler({ alias }) {
    const config = loadConfig();
    const db = getDatabaseConfig(config, alias);
    return {
      success: true,
      ...redactDatabaseConfig(alias, db)
    };
  }
};

export default describeDatabaseTool;
