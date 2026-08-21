# Authentication

The MCP server never mints or validates credentials itself. It **forwards** a
Bearer token to the Pantrist API, which is the authority. There are two ways a
token gets to the server: supplied directly (stdio) or obtained by the client
via OAuth (HTTP).

## Roles

- **Resource Server** = this MCP server. It holds the protected resource (the
  tools) and tells clients where to authenticate.
- **Authorization Server** = the Pantrist API (`api.pantrist.app`). It owns the
  OAuth discovery, dynamic client registration, authorize, and token endpoints.

Because the AS and the data API are the same service, the access token the
client receives **is** the API Bearer — so this server just passes it through.

## Token types

All three token types work with every tool.

| Token type | All tools |
|---|---|
| **OAuth access token** (from the handshake below) | ✅ |
| **Firebase ID token** (what the Pantrist app itself sends) | ✅ |
| **Pantrist API key** (`<uuid>_<secret>`) | ✅ |

The recipe tools used to be the exception: `search_recipes` answered an API key
with `401 "Token is not verified"` while every other tool worked. That was a
backend bug and is fixed — if you still hit it, you are pointed at an API
deployed before 2026-08-21.

Note: the OAuth access token is accepted as-is and lasts ~1 hour. There is no
exchange step — do not try to trade it for anything else before calling.

## stdio: supply the token directly

Set `PANTRIST_TOKEN` to a **Pantrist API key**. Generate one here:

**https://www.pantrist.com/documentation/api-docs**

That is the right credential for stdio and the only one that does not expire.
The other two both die after ~1h, and stdio has nowhere to run a refresh loop —
the server would fail every call until you pasted a new token by hand. They
still work if you have one handy; neither is worth setting up on purpose.

## HTTP: the OAuth handshake

The remote transport drives the standard MCP OAuth flow. The server's only jobs
are to (a) serve protected-resource metadata and (b) challenge unauthenticated
requests toward it; the Pantrist API does the rest.

```
Claude ──POST /mcp (no token)──────────────▶ MCP server
        ◀── 401 + WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource"
Claude ──GET /.well-known/oauth-protected-resource ─▶ MCP server
        ◀── { resource, authorization_servers: ["https://api.pantrist.app"] }
Claude ──GET …/.well-known/oauth-authorization-server ─▶ pantrist-api   (RFC 8414)
Claude ──POST /access-token/register ──────────────────▶ pantrist-api   (RFC 7591 DCR)
Claude ──(browser) authorization_endpoint ─────────────▶ consent page   (⚠️ see below)
Claude ──POST /access-token/token (code + PKCE) ───────▶ pantrist-api   → access_token
Claude ──POST /mcp (Bearer access_token) ──────────────▶ MCP server ──▶ REST API
```

### ⚠️ Dependency: the browser consent page

`authorization_endpoint` must be a **browser-navigable** login/consent page. The
API's own `/access-token/authorize` is a guarded JSON endpoint (it expects a
Firebase session and returns `{ redirectUrl }`), so it **cannot** be the target
of a top-level browser navigation by an OAuth client. Host a consent page on the
app (e.g. `https://pantrist.app/oauth/authorize`) and set the API's
`OAUTH_AUTHORIZE_URL` to point at it. **Until that page exists, the remote OAuth
flow cannot complete** — use the stdio transport with a supplied token instead.

### Security policy enforced on dynamic (RFC 7591) clients

The API enforces the following on every client self-registered via
`POST /access-token/register`:

- **PKCE is mandatory.** A `code_challenge` is required at `/authorize`;
  `code_verifier` is required at `/token`. The flow refuses to issue a code
  for a dynamic client without `code_challenge`.
- **Exact redirect-URI allowlist.** The `redirect_uri` presented at both
  `/authorize` and `/token` must be on the list the client registered.
  Omitting `redirect_uri` at `/token` is rejected (no allow-list bypass).
- **Auth-code binding.** Auth codes are bound to the `client_id` and
  `redirect_uri` that issued them; another client cannot redeem a code.
- **Grant-type allowlist.** Only the grant types the client registered are
  usable (e.g. `authorization_code` only ⇒ no `refresh_token`).
- **Scheme allowlist on registration.** Redirect URIs must be `https://`,
  or `http://` to `localhost` / `127.0.0.1` / `[::1]` (RFC 8252). Fragments
  are forbidden. `javascript:`, `data:`, `file:`, plain `http://` are
  rejected at registration time.

## Multi-user isolation

In HTTP mode the server is multi-tenant. Two safeguards keep users separate:

1. **Per-request token.** The token is read from each request's `Authorization`
   header into an `AsyncLocalStorage` context; it is never read from
   `PANTRIST_TOKEN` (that env fallback is disabled in HTTP mode).
2. **No shared default list.** `PANTRIST_LIST_ID` is ignored in HTTP mode, so
   one user can't be silently pointed at another user's default list — callers
   must pass `listId` explicitly (or call `list_lists`).

## Token expiry

OAuth access tokens last ~1 hour. When one expires the upstream REST call
returns 401 and the tool surfaces an error. The client is expected to refresh
via the token endpoint (`grant_type=refresh_token`). See
[LIMITATIONS.md](./LIMITATIONS.md#expired-token-handling) for the current rough
edge here.
