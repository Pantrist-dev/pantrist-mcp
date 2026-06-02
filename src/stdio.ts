import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { enableStdioDefaults } from './api.js';

/**
 * stdio entrypoint — the local PoC transport. Uses the Bearer token from
 * PANTRIST_TOKEN for every call (see api.ts). Logs go to stderr so they don't
 * corrupt the JSON-RPC stream on stdout.
 */
async function main() {
  // Single-user transport: allow the PANTRIST_TOKEN / PANTRIST_LIST_ID env
  // defaults (the HTTP transport deliberately does not).
  enableStdioDefaults();

  if (!process.env.PANTRIST_TOKEN) {
    console.error(
      '[pantrist-mcp] Warning: PANTRIST_TOKEN is not set — tool calls will fail until it is.',
    );
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[pantrist-mcp] stdio server ready');
}

main().catch((err) => {
  console.error('[pantrist-mcp] fatal:', err);
  process.exit(1);
});
