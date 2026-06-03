# Pantrist MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that wraps
the Pantrist REST API, so an LLM client (Claude Desktop, the Claude web/mobile
connector, Cursor, …) can manage shopping lists, the pantry, recipes and the
week plan in natural language.

It's a **thin wrapper** — no business logic. Every tool maps to an existing
REST endpoint and forwards the caller's Bearer token. The HTTP client is
**generated from the public OpenAPI spec** (`src/generated/pantrist-api.ts`),
so request/response types track the API automatically; only the curated tool
layer (`src/tools.ts`) is hand-written.

## Documentation

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — components, the token context, request flow, transports, regeneration.
- **[docs/AUTHENTICATION.md](./docs/AUTHENTICATION.md)** — OAuth flow, **token-type ↔ tool compatibility**, multi-user isolation, the consent-page dependency.
- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** — full env var reference, remote/ingress setup, scaling, security checklist.
- **[docs/TOOLS.md](./docs/TOOLS.md)** — every tool's args, REST mapping, and the item shape.
- **[docs/LIMITATIONS.md](./docs/LIMITATIONS.md)** — known rough edges (read before relying on it in production).

## Two transports

| Transport | When | Auth |
|---|---|---|
| **stdio** (`src/stdio.ts`) | Local PoC, single user, Claude Desktop | Bearer from `PANTRIST_TOKEN` env |
| **Streamable HTTP** (`src/http.ts`) | Remote, multi-user, the Claude connector | Per-request Bearer, obtained by the client via OAuth |

## Connecting Claude to the hosted server

If you just want to **use** Pantrist with Claude (not self-host), the public
endpoint is **`https://mcp.pantrist.app/mcp`**. Pick whichever Claude surface
you're on; in every case the first tool call walks you through an OAuth login
to your Pantrist account, no token to copy by hand.

### Claude.ai (web or desktop app)

1. **claude.ai** → profile menu → **Settings → Connectors**
2. Click **Add custom connector**
3. Fill in:
   - **Name**: `Pantrist`
   - **URL**: `https://mcp.pantrist.app/mcp`
4. Save → click **Connect**. A popup opens the Pantrist consent page.
5. Sign in → authorize → the popup closes.
6. Start a new chat — the Pantrist tools (shopping list, pantry, week plan,
   recipes) show up in the tool selector. Try *"What's on my shopping list?"*

### Claude Code (CLI)

```bash
claude mcp add pantrist --transport http https://mcp.pantrist.app/mcp
```

In the session, run `/mcp` to confirm it's listed. The first tool call triggers
the OAuth flow in your browser.

### Claude Desktop (manual config)

For Claude Desktop versions that support remote MCP, in
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "pantrist": {
      "type": "url",
      "url": "https://mcp.pantrist.app/mcp"
    }
  }
}
```

Restart Claude Desktop. First tool use kicks off OAuth.

### Sanity-checks if it doesn't work

```bash
# 200 OK + {"status":"ok"}
curl -fsS https://mcp.pantrist.app/healthz

# 401 + a WWW-Authenticate header pointing at /.well-known/oauth-protected-resource
curl -i -X POST https://mcp.pantrist.app/mcp -H 'Content-Type: application/json' -d '{}'

# JSON listing api.pantrist.app as the authorization server
curl -fsS https://mcp.pantrist.app/.well-known/oauth-protected-resource
```

If all three succeed but the connector flow still fails, the API's
`OAUTH_AUTHORIZE_URL` probably isn't set to a browser-facing consent page —
see the warning in [the OAuth dependency note](#how-the-oauth-handshake-flows).

## Quick start (stdio — fastest path)

You can validate the whole tool set in a couple of minutes without touching
OAuth, by using a token you already have.

```bash
git clone https://github.com/NLueg/pantrist-mcp.git
cd pantrist-mcp
npm install
npm run build

# Get a token: log into the Pantrist app, open DevTools → Network, copy the
# `Authorization: Bearer <…>` value from any API request (a Firebase ID token —
# the API accepts it directly). Or use an OAuth access_token.
export PANTRIST_BASE_URL=https://api.pantrist.app
export PANTRIST_TOKEN=<paste-token>
export PANTRIST_LIST_ID=<a-list-uuid>   # optional; or call list_lists

npm run dev:stdio   # or: node dist/stdio.js
```

### Claude Desktop config

`claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pantrist": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/pantrist-mcp/dist/stdio.js"],
      "env": {
        "PANTRIST_BASE_URL": "https://api.pantrist.app",
        "PANTRIST_TOKEN": "<your-token>",
        "PANTRIST_LIST_ID": "<list-uuid>"
      }
    }
  }
}
```

Restart Claude Desktop, then try: *"What's on my shopping list?"* or
*"Add milk and eggs."*

## Remote (Streamable HTTP + OAuth)

```bash
export PANTRIST_BASE_URL=https://api.pantrist.app
export MCP_PUBLIC_URL=https://mcp.pantrist.app   # public URL of THIS server
export MCP_ALLOWED_HOSTS=mcp.pantrist.app        # optional DNS-rebinding guard
export PORT=8787
npm run dev:http   # or: node dist/http.js
```

Then add it in Claude as a **Custom Connector** with URL
`https://mcp.pantrist.app/mcp`. The server also exposes `GET /healthz` for
probes. Full env reference, ingress, and scaling notes are in
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

### How the OAuth handshake flows

```
Claude ──POST /mcp (no token)──▶ MCP server
        ◀── 401 + WWW-Authenticate: resource_metadata=".../oauth-protected-resource"
Claude ──GET  /.well-known/oauth-protected-resource ──▶ MCP server
        ◀── { authorization_servers: ["https://api.pantrist.app"] }
Claude ──GET  /.well-known/oauth-authorization-server ─▶ pantrist-api   (RFC 8414)
Claude ──POST /access-token/register ─────────────────▶ pantrist-api   (RFC 7591 DCR)
Claude ──(browser) authorization_endpoint ────────────▶ consent page   (see below)
Claude ──POST /access-token/token (code + PKCE) ──────▶ pantrist-api   → access_token
Claude ──POST /mcp (Bearer access_token) ─────────────▶ MCP server ──▶ REST API
```

The MCP server is the **Resource Server**; the **Authorization Server** is the
Pantrist API. The token Claude receives is the API Bearer, so this server just
forwards it.

> **⚠️ Dependency — the consent page.** The API's `authorization_endpoint` must
> be a browser-navigable login/consent page (the API's `/access-token/authorize`
> is a guarded JSON endpoint and can't be navigated to directly). Host one on
> the app (e.g. `https://pantrist.app/oauth/authorize`) and set the API's
> `OAUTH_AUTHORIZE_URL` env to point at it. Until that page exists, use the
> stdio path above with a manually-supplied token.

## Tools

| Tool | REST route |
|---|---|
| `list_lists` | `GET /list` |
| `list_shopping_items` | `GET /list/{listId}/shoppingList` |
| `add_shopping_item` | `POST /list/{listId}/shoppingList/add-by-name` |
| `check_shopping_item` | `POST /list/{listId}/shoppingList/{itemId}/check` |
| `delete_shopping_item` | `DELETE /list/{listId}/shoppingList/{itemId}` |
| `list_pantry_items` | `GET /list/{listId}/pantryList` |
| `add_pantry_item` | `POST /list/{listId}/pantryList/add-by-name` |
| `reduce_pantry_amount` | `PUT /list/{listId}/pantryList/{itemId}/change-amount` |
| `update_pantry_item` | `GET` + `PUT /list/{listId}/pantryList/{itemId}` (metadata-only; stock changes go through `reduce_pantry_amount`) |
| `search_recipes` | `POST /recipe/filter` |
| `get_recipe` | `GET /recipe/{recipeId}` |
| `delete_recipe` | `DELETE /recipe/{recipeId}` |
| `get_week_plan` | `GET /list/{listId}/weekPlan?from=&to=` |
| `update_week_plan_day` | `PUT /list/{listId}/weekPlan/{date}` |

Most tools accept an optional `listId`; if omitted they use `PANTRIST_LIST_ID`
**in stdio mode only** (HTTP mode requires it explicitly — see
[multi-user isolation](./docs/AUTHENTICATION.md#multi-user-isolation)). Full
argument and item-shape details are in [docs/TOOLS.md](./docs/TOOLS.md).

All of these are **public** API endpoints (present in `/swagger-ui-json`), so
this wrapper needs only the published spec — never the private API source. That
keeps the door open to open-sourcing this directory as its own repo.

## Tests

```bash
npm test     # Node's built-in test runner (via tsx) — wiring + multi-user gating
```

## Regenerating the API client

Two steps, run when the API contract changes:

```bash
# 1. In the pantrist-api repo: emit the public OpenAPI spec
#    (Nest preview mode — no DB). Writes the snapshot directly into
#    ../pantrist-mcp/openapi/pantrist-openapi.json.
cd ../pantrist-api && pnpm generate:openapi

# 2. Back here: regenerate the typed client from that spec.
cd ../pantrist-mcp && npm run generate:client
```

Both the spec snapshot (`openapi/pantrist-openapi.json`) and the generated
client (`src/generated/pantrist-api.ts`) are committed so the project builds
without network access. The tool layer in `src/tools.ts` is hand-authored and
not regenerated.

## Environment

See [`.env.example`](./.env.example).
