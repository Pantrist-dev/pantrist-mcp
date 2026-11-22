import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import createClient from 'openapi-fetch';
import type { paths } from './generated/pantrist-api.js';

/** REST API base URL. No trailing slash. */
export const BASE = (
  process.env.PANTRIST_BASE_URL ?? 'https://api.pantrist.app'
).replace(/\/+$/, '');

/**
 * Authorization Server advertised to MCP clients in the protected resource
 * metadata. MCP clients (claude.ai, …) run discovery, client registration and
 * the token exchange against it from the outside, so it must be the API's
 * public URL. It differs from `BASE` when the REST calls go to an in-cluster
 * address, which no MCP client can reach.
 */
export function authServerUrl(override: string | undefined): string {
  return (override?.trim() || BASE).replace(/\/+$/, '');
}

export const AUTH_SERVER = authServerUrl(process.env.PANTRIST_AUTH_SERVER_URL);

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
  return createClient<paths>({
    baseUrl: BASE,
    headers: { Authorization: bearer() },
  });
}

/**
 * A stable, non-reversible id of the caller's token, to keep per-user state
 * (such as cached parse results) apart without holding the token itself.
 */
export function tokenFingerprint(): string {
  return createHash('sha256').update(bearer()).digest('hex');
}

function bearer(): string {
  const token = currentToken();
  if (!token) {
    // Surfaced verbatim to the MCP caller, so keep it generic; the
    // operator-facing details (which env var to set, which transport
    // expects what) belong in logs/docs, not the error stream.
    throw new Error('Authentication required.');
  }
  return `Bearer ${token}`;
}

/** The fields of the API's `UserDto` this server reads. */
export interface CurrentUser {
  uid: string;
  email: string;
  displayName: string;
  providerId?: string;
}

/**
 * The account behind the current token. `GET /user-management/me` is tagged
 * app-specific and left out of the public spec, so it has no generated type
 * and is fetched by hand. Resolves to `null` when the API knows no user for
 * the token.
 */
export function currentUser(): Promise<CurrentUser | null> {
  return request<CurrentUser | null>('GET', '/user-management/me');
}

/**
 * Call a route the generated client has no type for: one tagged app-specific
 * and left out of the public spec, or one newer than the spec snapshot.
 * Errors come out the same way as from `unwrap`.
 */
export async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: bearer(),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // A proxy in front of the API answers some errors (502, 504) with HTML.
    parsed = text;
  }
  return unwrap<T>({
    data: response.ok ? (parsed as T) : undefined,
    error: response.ok ? undefined : parsed,
    response,
  });
}

/**
 * A non-2xx answer of the API. The message is what the MCP caller sees; the
 * status and `Retry-After` let tools tell a rate limit from a broken input.
 */
export class PantristApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
    /** Seconds from the `Retry-After` header, when the API sent one. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'PantristApiError';
  }

  /**
   * What went wrong, from the API's problem+json body (`detail`), a plain
   * NestJS body (`message`), or the body as sent.
   */
  get apiMessage(): string {
    const body = this.detail as { detail?: unknown; message?: unknown } | null;
    for (const candidate of [body?.detail, body?.message]) {
      if (typeof candidate === 'string') return candidate;
      if (Array.isArray(candidate)) return candidate.join('; ');
    }
    return typeof this.detail === 'string'
      ? this.detail
      : JSON.stringify(this.detail ?? {});
  }

  /** The stable cause the API names in `code`, e.g. `AI_QUOTA_EXHAUSTED`. */
  get code(): string | undefined {
    const code = (this.detail as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : undefined;
  }
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
    const retryAfter = Number(result.response.headers?.get('retry-after'));
    throw new PantristApiError(
      `Pantrist API ${result.response.status} ${result.response.statusText}: ${detail}`,
      result.response.status,
      result.error,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
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
