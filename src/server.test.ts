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
    res.end(
      JSON.stringify(
        req.url?.endsWith('/supermarkets')
          ? [{ uid: 'coop', name: 'Coop', geofenceLat: 47.01, iconId: 'store' }]
          : { ok: true },
      ),
    );
  });
});
echo.listen(0);
await once(echo, 'listening');
const { port } = echo.address() as { port: number };
process.env.PANTRIST_BASE_URL = `http://127.0.0.1:${port}`;
delete process.env.PANTRIST_LIST_ID;

const {
  client,
  currentUser,
  tokenStore,
  unwrap,
  resolveListId,
  authServerUrl,
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

test('authServerUrl falls back to the REST base', () => {
  assert.equal(authServerUrl(undefined), `http://127.0.0.1:${port}`);
  assert.equal(authServerUrl('  '), `http://127.0.0.1:${port}`);
});

test('authServerUrl advertises the public API when the REST base is internal', () => {
  assert.equal(
    authServerUrl('https://api.pantrist.app/'),
    'https://api.pantrist.app',
  );
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

test('currentUser() asks /user-management/me with the request-context Bearer — the whoami path', async () => {
  received.length = 0;
  await tokenStore.run({ token: 'tok-xyz' }, () => currentUser());
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'GET');
  assert.equal(received[0].url, '/user-management/me');
  assert.equal(received[0].auth, 'Bearer tok-xyz');
});

test('currentUser() refuses to call the API without a token', async () => {
  received.length = 0;
  await assert.rejects(
    tokenStore.run({}, () => currentUser()),
    /Authentication required/,
  );
  assert.equal(received.length, 0);
});

// The tool handlers themselves, through the server they are registered on.
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { registerTools, applyPantryItemChanges } = await import('./tools.js');
const toolServer = new McpServer({ name: 'test', version: '0' });
registerTools(toolServer);

function callTool(name: string, args: Record<string, unknown>) {
  const tool = (
    toolServer as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools[name];
  return tokenStore.run({ token: 'tok-xyz' }, () =>
    tool.handler(args, {}),
  ) as Promise<{ content: { text: string }[] }>;
}

test('list_supermarkets returns only uid and name of each market', async () => {
  received.length = 0;
  const result = await callTool('list_supermarkets', { listId: 'L9' });

  assert.equal(received[0].url, '/list/L9/supermarkets');
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { uid: 'coop', name: 'Coop' },
  ]);
});

test('add_shopping_item sends the markets along', async () => {
  received.length = 0;
  await callTool('add_shopping_item', {
    listId: 'L9',
    name: 'WC-Papier',
    supermarketIds: ['coop'],
  });

  assert.equal(received[0].url, '/list/L9/shoppingList/add-by-name');
  assert.deepEqual(JSON.parse(received[0].body), {
    name: 'WC-Papier',
    supermarketIds: ['coop'],
  });
});

test('add_shopping_item without markets sends the name alone', async () => {
  received.length = 0;
  await callTool('add_shopping_item', { listId: 'L9', name: 'Milch' });

  assert.deepEqual(JSON.parse(received[0].body), { name: 'Milch' });
});

// update_pantry_item merges onto the fetched article before its full-upsert
// PUT; these pin down what the merge writes for each argument.
const article = {
  uuid: 'I42',
  name: 'Joghurt',
  amount: 3,
  manageMinimumAmount: false,
  minimumAmount: 1,
  pantrySettings: {
    earliestBestBefore: '2026-12-01',
    articleList: [
      { pantryUuid: '1', count: 2, bestBefore: '2026-12-01', calculatedBestBeforeDate: true },
      { pantryUuid: 'fridge', count: 1, bestBefore: '2027-01-15' },
    ],
  },
} as unknown as Parameters<typeof applyPantryItemChanges>[0];

test('update_pantry_item merge: bestBefore goes on every batch as a user-set date', () => {
  const merged = applyPantryItemChanges(article, { bestBefore: '2026-11-08' });

  assert.deepEqual(merged.pantrySettings, {
    earliestBestBefore: '2026-11-08',
    articleList: [
      { pantryUuid: '1', count: 2, bestBefore: '2026-11-08', calculatedBestBeforeDate: false },
      { pantryUuid: 'fridge', count: 1, bestBefore: '2026-11-08', calculatedBestBeforeDate: false },
    ],
  });
  assert.equal(merged.amount, 3);
});

test('update_pantry_item merge: bestBefore null clears the date', () => {
  const merged = applyPantryItemChanges(article, { bestBefore: null });

  assert.deepEqual(merged.pantrySettings, {
    articleList: [
      { pantryUuid: '1', count: 2 },
      { pantryUuid: 'fridge', count: 1 },
    ],
  });
});

test('update_pantry_item merge: an item without batches gets one holding its stock', () => {
  const empty = {
    ...article,
    pantrySettings: { articleList: [] },
  } as typeof article;

  const merged = applyPantryItemChanges(empty, { bestBefore: '2026-11-08' });

  assert.deepEqual(merged.pantrySettings.articleList, [
    { pantryUuid: '1', count: 3, bestBefore: '2026-11-08', calculatedBestBeforeDate: false },
  ]);
});

test('update_pantry_item merge: minimumAmount switches tracking on unless told otherwise', () => {
  const on = applyPantryItemChanges(article, { minimumAmount: 2 });
  assert.equal(on.minimumAmount, 2);
  assert.equal(on.manageMinimumAmount, true);

  const off = applyPantryItemChanges(article, {
    minimumAmount: 2,
    manageMinimumAmount: false,
  });
  assert.equal(off.manageMinimumAmount, false);
});

test('update_pantry_item merge: minimumAmountMode is passed through', () => {
  const merged = applyPantryItemChanges(article, {
    minimumAmount: 20,
    minimumAmountMode: 'content',
  });

  assert.equal(merged.minimumAmount, 20);
  assert.equal(merged.minimumAmountMode, 'content');
});

test('update_pantry_item merge: omitted fields round-trip unchanged', () => {
  const merged = applyPantryItemChanges(article, { name: 'Skyr', notes: null });

  assert.equal(merged.name, 'Skyr');
  assert.equal(merged.notes, null);
  assert.equal(merged.minimumAmount, 1);
  assert.equal(merged.manageMinimumAmount, false);
  assert.equal(merged.pantrySettings, article.pantrySettings);
});
