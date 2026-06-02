import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

/** Build a fresh MCP server instance with the Pantrist tool set registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'pantrist', version: '0.1.0' });
  registerTools(server);
  return server;
}
