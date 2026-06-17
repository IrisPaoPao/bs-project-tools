#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { ConfigError, configErrorResult } from './config.js';
import { SqlValidationError, sqlErrorResult } from './sql-validator.js';
import { executorErrorResult } from './java-runner.js';

import {
  listDatabasesTool,
  describeDatabaseTool,
  testConnectionTool,
  jdbcQueryTool
} from './tools/index.js';

const server = new McpServer(
  {
    name: 'bs-jdbc-tool',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

function wrapToolHandler(tool) {
  return async (args) => {
    try {
      const result = await tool.handler(args);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      let errorResult;
      const alias = args?.alias;

      if (error instanceof ConfigError) {
        errorResult = configErrorResult(error, alias);
      } else if (error instanceof SqlValidationError) {
        errorResult = sqlErrorResult(error, alias);
      } else {
        errorResult = executorErrorResult(error, alias);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(errorResult, null, 2)
          }
        ],
        isError: true
      };
    }
  };
}

// Register all tools using tool() method with real Zod schemas
server.tool(
  listDatabasesTool.name,
  listDatabasesTool.description,
  {},
  wrapToolHandler(listDatabasesTool)
);

server.tool(
  describeDatabaseTool.name,
  describeDatabaseTool.description,
  {
    alias: z.string().describe('The database alias to describe')
  },
  wrapToolHandler(describeDatabaseTool)
);

server.tool(
  testConnectionTool.name,
  testConnectionTool.description,
  {
    alias: z.string().describe('The database alias to test'),
    timeoutSeconds: z.number().int().positive().optional().describe('Connection timeout in seconds (optional, defaults to config value or 30)')
  },
  wrapToolHandler(testConnectionTool)
);

server.tool(
  jdbcQueryTool.name,
  jdbcQueryTool.description,
  {
    alias: z.string().describe('The database alias to query'),
    sql: z.string().describe('SQL statement to execute (SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, etc.)'),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe('Optional array of parameter values for prepared statements'),
    maxRows: z.number().int().positive().optional().describe('Maximum number of rows to return for queries (optional, limited by config)'),
    timeoutSeconds: z.number().int().positive().optional().describe('Query timeout in seconds (optional, limited by config)')
  },
  wrapToolHandler(jdbcQueryTool)
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
