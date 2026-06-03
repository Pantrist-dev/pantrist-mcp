import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

// Stand up an echo server and point the client at it BEFORE importing the api
// module — BASE is read from the environment at module load.
const received: {
  method?: string;
  url?: string;
  auth?: string;
  body: string;
}[] = [];

const echo = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    received.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});
echo.listen(0);
await once(echo, 'listening');
const { port } = echo.address() as { port: number };
process.env.PANTRIST_BASE_URL = `http://127.0.0.1:${port}`;
delete process.env.PANTRIST_LIST_ID;

const {
  client,
  tokenStore,
  unwrap,
  resolveListId,
  enableStdioDefaults,
  resetStdioDefaults,
} = await import('./api.js');

after(() => echo.close());

// stdioDefaultsEnabled is a process-global `let` in api.ts — reset between
// tests so the multi-user-safety assertions don't depend on test order.
afterEach(() => {
  resetStdioDefaults();
  delete process.env.PANTRIST_LIST_ID;
});

test('unwrap returns data on a 2xx', () => {
  const result = unwrap({
    data: { a: 1 },
    response: { ok: true, status: 200, statusText: 'OK' } as Response,
  });
  assert.deepEqual(result, { a: 1 });
});

test('unwrap throws on a non-2xx, including the status', () => {
  assert.throws(
    () =>
      unwrap({
        error: { message: 'nope' },
        response: { ok: false, status: 404, statusText: 'Not Found' } as Response,
      }),
    /404/,
  );
});

test('resolveListId requires an explicit listId in HTTP mode (defaults off)', () => {
  // stdio defaults are off by default — the multi-user safety behaviour.
  assert.throws(() => resolveListId(undefined), /Pass listId explicitly/);
  assert.equal(resolveListId('explicit-id'), 'explicit-id');
});

test('resolveListId honours PANTRIST_LIST_ID once stdio defaults are enabled', () => {
  process.env.PANTRIST_LIST_ID = 'env-list';
  enableStdioDefaults();
  assert.equal(resolveListId(undefined), 'env-list');
  assert.equal(resolveListId('explicit-id'), 'explicit-id');
});

test('client() forwards the request-context Bearer + path params + body', async () => {
  received.length = 0;
  await tokenStore.run({ token: 'tok-xyz' }, async () => {
    unwrap(
      await client().POST('/list/{listId}/shoppingList/add-by-name', {
        params: { path: { listId: 'L9' } },
        body: { name: 'Eggs' },
      }),
    );
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/list/L9/shoppingList/add-by-name');
  assert.equal(received[0].auth, 'Bearer tok-xyz');
  assert.deepEqual(JSON.parse(received[0].body), { name: 'Eggs' });
});

// The two new tools (update_pantry_item, delete_recipe) added in #1/#2.
// We exercise the underlying openapi-fetch routes directly — same shape
// the tools execute internally — so we prove the wiring without having
// to spin up an MCP transport in the test.

test('GET then PUT pantry item — the update_pantry_item path', async () => {
  received.length = 0;
  await tokenStore.run({ token: 'tok-xyz' }, async () => {
    // Step 1: tool fetches the current article.
    unwrap(
      await client().GET('/list/{listId}/pantryList/{itemId}', {
        params: { path: { listId: 'L9', itemId: 'I42' } },
      }),
    );
    // Step 2: tool PUTs the merged article back.
    unwrap(
      await client().PUT('/list/{listId}/pantryList/{itemId}', {
        params: { path: { listId: 'L9', itemId: 'I42' } },
        body: { ok: true, name: 'New Name' } as never,
      }),
    );
  });
  assert.equal(received.length, 2);
  assert.equal(received[0].method, 'GET');
  assert.equal(received[0].url, '/list/L9/pantryList/I42');
  assert.equal(received[1].method, 'PUT');
  assert.equal(received[1].url, '/list/L9/pantryList/I42');
  assert.deepEqual(JSON.parse(received[1].body), { ok: true, name: 'New Name' });
});

test('DELETE /recipe/{uid} — the delete_recipe path', async () => {
  received.length = 0;
  await tokenStore.run({ token: 'tok-xyz' }, async () => {
    unwrap(
      await client().DELETE('/recipe/{uid}', {
        params: { path: { uid: 'R7' } },
      }),
    );
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'DELETE');
  assert.equal(received[0].url, '/recipe/R7');
  assert.equal(received[0].auth, 'Bearer tok-xyz');
});
