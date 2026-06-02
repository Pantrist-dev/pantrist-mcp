import { AsyncLocalStorage } from 'node:async_hooks';
import createClient from 'openapi-fetch';
import type { paths } from './generated/pantrist-api.js';

/** REST API base URL. No trailing slash. */
export const BASE = (
  process.env.PANTRIST_BASE_URL ?? 'https://api.pantrist.app'
).replace(/\/+$/, '');

/**
 * Per-request token context. The HTTP transport runs each MCP request inside
 * `tokenStore.run({ token }, …)` with the caller's Bearer token; the stdio
 * transport has no per-request token, so we fall back to `PANTRIST_TOKEN`.
 * This lets the tool definitions be shared verbatim between both transports.
 */
export const tokenStore = new AsyncLocalStorage<{ token?: string }>();

/**
 * Whether to honour the process-global `PANTRIST_TOKEN` / `PANTRIST_LIST_ID`
 * env defaults. Enabled ONLY by the single-user stdio transport
 * (`enableStdioDefaults()`); deliberately OFF for the multi-user HTTP
 * transport, where a shared default would leak one user's token/list to
 * everyone. In HTTP mode the token always comes from the request context and
 * the list id must be passed explicitly per call.
 */
let stdioDefaultsEnabled = false;

export function enableStdioDefaults(): void {
  stdioDefaultsEnabled = true;
}

/** Test helper: clear the process-global stdio flag set by
 *  `enableStdioDefaults()` so suites can exercise both transports in any
 *  order without leaking state across tests. */
export function resetStdioDefaults(): void {
  stdioDefaultsEnabled = false;
}

function currentToken(): string | undefined {
  const ctx = tokenStore.getStore();
  // Inside a request context (HTTP), the token is whatever that request
  // carried — never the env fallback. Outside any context (stdio), use the
  // env token, but only when stdio defaults are explicitly enabled.
  if (ctx) return ctx.token;
  return stdioDefaultsEnabled ? process.env.PANTRIST_TOKEN : undefined;
}

/**
 * A typed `openapi-fetch` client bound to the current request's Bearer token.
 * Types come from `generated/pantrist-api.ts`, produced from the published
 * OpenAPI spec — so request/response shapes track the API automatically.
 */
export function client() {
  const token = currentToken();
  if (!token) {
    // Surfaced verbatim to the MCP caller, so keep it generic; the
    // operator-facing details (which env var to set, which transport
    // expects what) belong in logs/docs, not the error stream.
    throw new Error('Authentication required.');
  }
  return createClient<paths>({
    baseUrl: BASE,
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Unwrap an `openapi-fetch` result, throwing a readable error on non-2xx so
 * the MCP SDK surfaces it back to the model.
 */
export function unwrap<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.error !== undefined || !result.response.ok) {
    const detail =
      typeof result.error === 'string'
        ? result.error
        : JSON.stringify(result.error ?? {});
    throw new Error(
      `Pantrist API ${result.response.status} ${result.response.statusText}: ${detail}`,
    );
  }
  return result.data as T;
}

/**
 * Resolve the target list UUID: explicit arg wins, else the configured
 * default. Throws a helpful message when neither is available.
 */
export function resolveListId(listId?: string): string {
  // The PANTRIST_LIST_ID default is single-user only (stdio). In multi-user
  // HTTP mode it is ignored so one user can't be silently pointed at another
  // user's default list — callers must pass listId explicitly.
  const id =
    listId ?? (stdioDefaultsEnabled ? process.env.PANTRIST_LIST_ID : undefined);
  if (!id) {
    throw new Error(
      stdioDefaultsEnabled
        ? 'No listId provided and PANTRIST_LIST_ID is not set. Call the `list_lists` tool to find one.'
        : 'No listId provided. Pass listId explicitly — call `list_lists` to find one. (The PANTRIST_LIST_ID default is not used in multi-user HTTP mode.)',
    );
  }
  return id;
}
