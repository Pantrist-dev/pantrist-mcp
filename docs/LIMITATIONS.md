# Known limitations & rough edges

An honest list of things to weigh before relying on this server in production.
Ordered roughly by impact.

## Not yet validated against live data 🔴

The tool wiring is verified (unit tests issue real HTTP to a local echo server,
asserting method/path/body/Bearer), **but no tool has been run against the live
Pantrist API with a real token.** Before trusting it end-to-end, run each tool
once against `https://api.pantrist.app` and confirm:

- response shapes match what the model is told (`ArticleDto` fields),
- `lastModified` is actually populated on items (it's written only when
  provided — see the n8n/trigger discussion),
- `check_shopping_item` returns something sensible across list settings
  (delete / move-to-pantry / move-to-cart).

The token-type question that used to sit in this list is settled: every tool,
recipe tools included, works with all three token types — see
[AUTHENTICATION.md](./AUTHENTICATION.md#token-types).

## Expired-token handling 🟠

When an upstream call returns **401** (e.g. the ~1h OAuth token expired), the
tool surfaces a generic error string rather than re-issuing the MCP `401 +
WWW-Authenticate` challenge. In stateless Streamable HTTP the response status is
already committed by the time the tool runs, so converting a mid-stream upstream
401 into a transport-level re-auth challenge isn't straightforward. Practical
impact: the model sees a "401" tool error and the user may need to reconnect
instead of the client silently refreshing. A future improvement is a pre-flight
token check, or surfacing a structured auth-required error the client
recognises.

## Large responses (token cost) 🟠

`list_shopping_items` / `list_pantry_items` pass the **entire** `ArticleDto`
array through (~20+ fields per item). For a large pantry this is a lot of tokens
and can crowd the model's context. Options if it bites: project to essential
fields, paginate, or expose the list as an MCP **resource** instead of a tool.

## The vendored OpenAPI snapshot is behind the API 🟢

`openapi/pantrist-openapi.json` is a checked-in copy of the published spec, and
`src/generated/pantrist-api.ts` is generated from it. In the current copy the
recipe operations carry no `security` entry at all (`security: null`, unlike
every `/list/**` route) — that was accurate when the recipe controller had no
`@ApiBearerAuth()`, and stopped being accurate with
[pantrist-api#291](https://github.com/Pantrist-dev/pantrist-api/pull/291).

Nothing is broken by this: `openapi-typescript` emits request/response types
only, so the `security` field never reaches the generated client. It is a
documentation drift, not a runtime one. To clear it:

```bash
curl -fsS https://api.pantrist.app/swagger-ui-json -o openapi/pantrist-openapi.json
npm run generate:client
```

## No server-initiated streaming (stateless) 🟡

The HTTP transport runs stateless (no sessions), so `GET /mcp` (SSE) and
`DELETE /mcp` (session teardown) return `405`. The server cannot push
notifications/progress to the client. This is a deliberate trade for horizontal
scalability and is fine for a request/response tool wrapper.

## Remote OAuth needs the consent page 🟡

The full remote OAuth flow can't complete until a browser-facing consent page
exists and `OAUTH_AUTHORIZE_URL` points at it. See
[AUTHENTICATION.md](./AUTHENTICATION.md#-dependency-the-browser-consent-page).
The stdio path (supplied token) works today regardless.

## No resources or prompts yet 🟢

Only tools are exposed. Static reference data (units, categories, supermarkets)
would fit better as MCP **resources**, and a "plan the week" **prompt** template
was sketched in the original design — both are future work.

## Misc

- **`server.tool(...)`** is the older SDK registration API (still supported in
  1.29). `registerTool` is the newer form if a refactor is ever wanted.
- **No CORS** is configured; only relevant for browser-based MCP clients
  (Claude's connector is server-side).
- The server forwards any valid Pantrist token without its own rate limiting;
  it relies on the API's throttling.
