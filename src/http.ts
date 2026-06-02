import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { BASE, tokenStore } from './api.js';

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = (
  process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`
).replace(/\/+$/, '');
const PRM_PATH = '/.well-known/oauth-protected-resource';

// Optional DNS-rebinding protection: when MCP_ALLOWED_HOSTS / _ORIGINS are
// set the transport rejects requests whose Host/Origin isn't allow-listed.
// Leave unset behind a trusted TLS-terminating ingress that already pins Host.
const allowedHosts = csv(process.env.MCP_ALLOWED_HOSTS);
const allowedOrigins = csv(process.env.MCP_ALLOWED_ORIGINS);
const dnsProtection = allowedHosts.length > 0 || allowedOrigins.length > 0;

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// The Streamable HTTP body carries JSON-RPC envelopes whose tool args /
// tool results can legitimately exceed the Express default 100 KB cap
// (think: full pantry dumps, recipe payloads). Override-able for ops; the
// 4 MB default leaves headroom without going wild.
const BODY_LIMIT = process.env.MCP_BODY_LIMIT?.trim() || '4mb';

const app = express();
app.use(express.json({ limit: BODY_LIMIT }));

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

/**
 * RFC 9728 Protected Resource Metadata. The MCP client fetches this (pointed
 * here by the 401 `WWW-Authenticate` challenge below) to learn which
 * Authorization Server to run the OAuth flow against — the Pantrist API,
 * whose discovery + DCR + token endpoints handle the rest.
 */
app.get(PRM_PATH, (_req, res) => {
  res.json({
    resource: PUBLIC_URL,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
  });
});

function challenge(res: express.Response) {
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      `Bearer resource_metadata="${PUBLIC_URL}${PRM_PATH}"`,
    )
    .json({
      error: 'unauthorized',
      error_description: 'Missing or invalid Bearer token',
    });
}

/**
 * Streamable HTTP transport, stateless: one fresh server + transport per
 * request. The caller's Bearer token is the Pantrist API token (the API is
 * the Authorization Server), so we just forward it via the per-request
 * AsyncLocalStorage context that `api()` reads.
 */
app.post('/mcp', (req, res, next) => {
  void handleMcpRequest(req, res).catch(next);
});

async function handleMcpRequest(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    challenge(res);
    return;
  }
  const token = auth.slice('Bearer '.length);

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    ...(dnsProtection
      ? { enableDnsRebindingProtection: true, allowedHosts, allowedOrigins }
      : {}),
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await tokenStore.run({ token }, () =>
    transport.handleRequest(req, res, req.body),
  );
}

// Centralised error handler — any throw from handleMcpRequest (or the
// JSON body parser hitting the size limit) flows here instead of becoming
// an unhandled rejection. We don't leak the message; the MCP SDK already
// surfaces tool errors structurally via the JSON-RPC response.
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error('[pantrist-mcp] request error:', err);
    if (res.headersSent) {
      res.end();
      return;
    }
    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { statusCode?: number }).statusCode ??
      500;
    res.status(status).json({ error: 'internal_error' });
  },
);

// Stateless mode keeps no sessions, so the SSE GET and session DELETE that
// Streamable HTTP also defines have nothing to attach to.
app.get('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
app.delete('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());

const httpServer = app.listen(PORT, () => {
  console.error(
    `[pantrist-mcp] Streamable HTTP server on ${PUBLIC_URL} (REST base ${BASE})` +
      (dnsProtection ? ' [DNS-rebinding protection on]' : ''),
  );
});

// Close the listener on termination so in-flight requests drain and the
// container exits promptly instead of being SIGKILLed.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.error(`[pantrist-mcp] ${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
  });
}
