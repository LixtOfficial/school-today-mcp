#!/usr/bin/env node
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { SchoolTodayClient } = require('./core/client');
const { CacheManager } = require('./core/cache');
const { PreviewStore } = require('./core/preview-store');
const { MetadataManager } = require('./metadata');
const { TOOLS_DEFINITIONS, handleToolCall } = require('./tools');

const cache = new CacheManager(90 * 1000);
const previewStore = new PreviewStore(15 * 60 * 1000);
const client = new SchoolTodayClient();
const metadataManager = new MetadataManager(client, cache);

const server = new Server(
  {
    name: 'school-today-mcp',
    version: '2.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS_DEFINITIONS
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleToolCall(name, args || {}, {
      client,
      metadataManager,
      cache,
      previewStore
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Помилка виконання інструменту [${name}]: ${err.message}`
        }
      ]
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('School-Today MCP server running on stdio (v2.0.0 — Getters & Two-Phase Setters)');
}

run().catch((err) => {
  console.error('Fatal error in MCP server:', err);
  process.exit(1);
});
