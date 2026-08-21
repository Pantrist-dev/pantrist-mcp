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
| **OAuth access token** (from `/access-token/token`) | ✅ |
| **Firebase ID token** (e.g. copied from the app) | ✅ |
| **Pantrist API key** (`<uuid>_<secret>`) | ✅ |

The recipe-controller carve-out is fully gone as of
[pantrist-api#291](https://github.com/Pantrist-dev/pantrist-api/pull/291).
`POST /recipe/filter` (behind `search_recipes`) was the last route still on
`FirebaseAuthGuard`, which understands Firebase ID / custom tokens, the OAuth
JWT and the signed `x-api-key` header — but not a `<uuid>_<secret>` API key,
which it rejected with `401 "Token is not verified"`. It now uses `AnyAuthGuard`
like the rest of the controller. `get_recipe` and `delete_recipe` were never
affected; those routes had already moved.

You can tell the two guards apart from the 401 body if this ever regresses:
`FirebaseAuthGuard` says `"detail": "Token is not verified"`, `AnyAuthGuard`
says `"detail": "No valid authentication method provided"` with
`"code": "AUTH_INVALID_TOKEN"`. The latter on a recipe route means your token
is bad, not that the route is on the wrong guard.

Note: the OAuth access token the API issues is a Firebase **custom token**
(1-hour lifetime). The backend's auth guard verifies it directly; you do not
need to exchange it for an ID token.

## stdio: supply the token directly

Set `PANTRIST_TOKEN` to a **Pantrist API key**. Generate one here:

**https://www.pantrist.com/de-DE/documentation/api-docs**

That is the right credential for stdio and the only one that does not expire.
A Firebase ID token dies after ~1h, and an OAuth access token after exactly the
same hour (it *is* a Firebase custom token, see the note above) — a
long-running stdio server has nowhere to run a refresh loop, so it would fail
every call until you pasted a new one by hand. Both still work if you have one
handy; neither is worth setting up on purpose.

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
