# Deployment

## Configuration (environment variables)

| Var | Transport | Default | Purpose |
|---|---|---|---|
| `PANTRIST_BASE_URL` | both | `https://api.pantrist.app` | REST API base (no trailing slash). |
| `PANTRIST_TOKEN` | stdio | — | Bearer token for all calls. See [AUTHENTICATION.md](./AUTHENTICATION.md). |
| `PANTRIST_LIST_ID` | stdio | — | Default `listId` when a tool omits it. **Ignored in HTTP mode.** |
| `PORT` | http | `8787` | Listen port. |
| `MCP_PUBLIC_URL` | http | `http://localhost:$PORT` | Public URL the server is reachable at; advertised in resource metadata. Set to the exact base clients connect to. |
| `MCP_ALLOWED_HOSTS` | http | — | Comma-separated Host allow-list. Enables DNS-rebinding protection when set. |
| `MCP_ALLOWED_ORIGINS` | http | — | Comma-separated Origin allow-list. Enables DNS-rebinding protection when set. |
| `MCP_BODY_LIMIT` | http | `4mb` | JSON-body size limit for `POST /mcp`. The Express default (`100kb`) is too small for typical tool payloads. |

### API-side vars (set on the Pantrist API, not the MCP server)

| Var | Purpose |
|---|---|
| `OAUTH_AUTHORIZE_URL` | **Required for remote OAuth.** Public URL of a browser-facing consent page that runs the user's Firebase login and then calls `POST /access-token/authorize` (e.g. `https://pantrist.app/oauth/authorize`). When unset the discovery doc falls back to the API's own JSON endpoint, which is FirebaseAuthGuard-protected and will 401 any plain-browser MCP-client navigation — the OAuth flow cannot complete without it. See [AUTHENTICATION.md](./AUTHENTICATION.md). |
| `OAUTH_ISSUER` | Override for the OAuth `issuer` URL advertised in `/.well-known/oauth-authorization-server`. Default: inferred from `x-forwarded-{proto,host}`. Set when the public origin can't be inferred from the request (CDN rewrites Host). |
| `OAUTH_EXTRA_KNOWN_REDIRECT_URIS` | Comma-separated extra redirect URIs accepted at `/access-token/authorize` for the legacy consent-page flow (where no `client_id` is sent). The built-in list is wear OS + the three Alexa skill-link URLs; only override if you wire up a new platform. |
| `OAUTH_CLIENT_ORPHAN_RETENTION_DAYS` | How many days after registration an orphan dynamic client (no `tokens` row) is kept before the prune endpoint sweeps it. Default `14`. |

### Cron-callable maintenance endpoints

| Endpoint | Purpose |
|---|---|
| `POST /oauth-client-cleanup/run` | Deletes orphan `oauth_clients` rows older than `OAUTH_CLIENT_ORPHAN_RETENTION_DAYS` that never produced a `tokens` row. Behind the shared `StaticApiKeyGuard` — wire into the existing daily k8s CronJob alongside the other `*-cleanup/run` endpoints. |

## Build

```bash
npm install
npm run build      # tsc → dist/ (test files excluded)
npm test           # node:test via tsx
```

## stdio (local / Claude Desktop)

```bash
export PANTRIST_TOKEN=<token>
export PANTRIST_LIST_ID=<list-uuid>   # optional
node dist/stdio.js
```

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pantrist": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/pantrist-mcp/dist/stdio.js"],
      "env": {
        "PANTRIST_BASE_URL": "https://api.pantrist.app",
        "PANTRIST_TOKEN": "<token>",
        "PANTRIST_LIST_ID": "<list-uuid>"
      }
    }
  }
}
```

## Remote (Streamable HTTP)

```bash
export PANTRIST_BASE_URL=https://api.pantrist.app
export MCP_PUBLIC_URL=https://mcp.pantrist.app
export MCP_ALLOWED_HOSTS=mcp.pantrist.app
export PORT=8787
node dist/http.js
```

Endpoints:

- `POST /mcp` — the MCP Streamable HTTP endpoint (requires `Authorization: Bearer`).
- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata.
- `GET /healthz` — liveness/readiness probe (`{ "status": "ok" }`).

Add it in Claude as a **Custom Connector** with URL `https://mcp.pantrist.app/mcp`.

### Reverse proxy / ingress

- Terminate TLS at the ingress; forward to `PORT`.
- Preserve the `Authorization` header.
- Set `MCP_PUBLIC_URL` to the external HTTPS URL so the advertised
  `resource` matches what the client connected to.
- If the ingress already pins the `Host`, DNS-rebinding protection is optional;
  otherwise set `MCP_ALLOWED_HOSTS` to your external host.

### Scaling

The HTTP transport is **stateless** — no sessions, no sticky routing. Run as
many replicas as you like behind a round-robin load balancer. Each request is
self-contained (token in the header, fresh server instance per request).

### Security checklist

- [ ] TLS in front of the server.
- [ ] `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` set if not behind a Host-pinning ingress.
- [ ] `MCP_PUBLIC_URL` is the exact external URL.
- [ ] No secrets baked into the image — tokens arrive per request (HTTP) or via env (stdio).
- [ ] Consider an upstream rate limit; the server forwards any valid Pantrist token but does not rate-limit (the API does its own throttling).

See [LIMITATIONS.md](./LIMITATIONS.md) for known rough edges to weigh before
shipping to many users.
