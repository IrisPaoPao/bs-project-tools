import { loadConfig, databaseListItem } from '../config.js';

export const listDatabasesTool = {
  name: 'list_databases',
  description: 'List all configured database aliases with their basic information (type, description, defaults). Does not include sensitive details like JDBC URLs, usernames, or passwords.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: []
  },
  async handler() {
    const config = loadConfig();
    const databases = Object.entries(config.databases).map(([alias, db]) =>
      databaseListItem(alias, db)
    );
    return {
      success: true,
      databases
    };
  }
};

export default listDatabasesTool;
