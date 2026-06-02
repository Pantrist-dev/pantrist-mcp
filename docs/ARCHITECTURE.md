# Architecture

## Big picture

```
┌──────────────┐   MCP (stdio /        ┌───────────────┐   REST (OpenAPI)    ┌──────────────┐
│  LLM client   │   Streamable HTTP)    │  MCP server    │   + Bearer token    │  pantrist-api │
│ (Claude, …)   │ ───────────────────▶  │  (this package)│ ──────────────────▶ │  (backend)    │
└──────────────┘                        └───────────────┘                     └──────────────┘
```

This package is a **thin, stateless wrapper**. It contains **no business
logic** — every tool maps 1:1 to an existing Pantrist REST endpoint and
forwards the caller's Bearer token. The backend remains the single source of
truth for authorization, validation, and data.

## Components

| File | Responsibility |
|---|---|
| `src/tools.ts` | The **only hand-written** layer: the curated tool set, their descriptions, and Zod input schemas. Maps each tool to a typed REST call. |
| `src/api.ts` | Builds the typed `openapi-fetch` client bound to the current request's token; `unwrap()` (errors) and `resolveListId()` (list defaulting) helpers; the `AsyncLocalStorage` token context. |
| `src/generated/pantrist-api.ts` | **Generated** TypeScript types for every public REST path (from the OpenAPI spec). Never edited by hand. See [the regeneration workflow](#regenerating-the-client). |
| `src/server.ts` | Assembles an `McpServer` with the tools registered. |
| `src/stdio.ts` | stdio transport entrypoint (single-user, local). |
| `src/http.ts` | Streamable HTTP transport entrypoint (remote, multi-user) + OAuth resource metadata. |

## The token context (how one tool layer serves two transports)

The tool implementations are transport-agnostic. They call `client()`, which
reads the active token from an `AsyncLocalStorage` (ALS) store:

- **HTTP**: each request runs inside `tokenStore.run({ token }, …)`, so the
  token is strictly per-request — never shared between users.
- **stdio**: there is no per-request context, so `client()` falls back to the
  `PANTRIST_TOKEN` env var. This fallback is **gated**: it only activates after
  `enableStdioDefaults()` is called (which only `stdio.ts` does). The HTTP
  transport never enables it, which is what prevents a process-global token or
  list id from leaking across users. See
  [AUTHENTICATION.md](./AUTHENTICATION.md#multi-user-isolation).

## Request flow (a tool call)

1. The LLM client invokes a tool, e.g. `add_shopping_item { name: "Milk" }`.
2. The MCP SDK validates the arguments against the tool's Zod schema.
3. The handler resolves the list id (`resolveListId`) and calls the typed
   client: `client().POST('/list/{listId}/shoppingList/add-by-name', …)`.
4. `client()` attaches `Authorization: Bearer <token>` from the ALS context.
5. The backend authorizes the token, performs the write, and responds.
6. `unwrap()` returns the body or throws a readable error on non-2xx; the tool
   returns it as MCP text content.

## Transports

| | stdio | Streamable HTTP |
|---|---|---|
| Entrypoint | `src/stdio.ts` | `src/http.ts` |
| Users | single | multi |
| Token source | `PANTRIST_TOKEN` env | per-request `Authorization` header |
| `PANTRIST_LIST_ID` default | honoured | **ignored** (pass `listId`) |
| State | n/a | **stateless** — one `McpServer` + transport per request |
| OAuth | none (token supplied) | advertises resource metadata + 401 challenge |

The HTTP transport is **stateless** (`sessionIdGenerator: undefined`): it keeps
no sessions, so the SSE `GET /mcp` and session `DELETE /mcp` that Streamable
HTTP also defines return `405`. This keeps the server horizontally scalable (no
sticky sessions) at the cost of server-initiated streaming — acceptable for a
request/response tool wrapper. See [LIMITATIONS.md](./LIMITATIONS.md).

## Regenerating the client

The generated client and the committed spec snapshot keep the types in lockstep
with the API. Two steps, run when the API contract changes:

```bash
# 1. In the pantrist-api repo (Nest preview mode — no DB):
pnpm generate:openapi          # → mcp-server/openapi/pantrist-openapi.json

# 2. Here:
npm run generate:client        # → src/generated/pantrist-api.ts
```

Both artifacts are committed so the project builds offline. `src/tools.ts` is
hand-authored and never regenerated.
