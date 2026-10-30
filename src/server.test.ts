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

/** A pantry with one recipe-known-by-name and one Pantrist recipe reserved. */
const pantry = [
  {
    uuid: 'paprika',
    name: 'Paprika',
    unitId: 'g',
    amount: 2,
    contentVolume: 50,
    pantrySettings: {
      articleList: [],
      savedForRecipe: [
        { recipeUuid: 'ext-1', recipeName: 'Gulasch', contentSaved: 7 },
        { recipeUuid: 'R7', amountSaved: 1 },
      ],
    },
  },
  {
    uuid: 'rice',
    name: 'Reis',
    unitId: 'g',
    amount: 1,
    contentVolume: 1000,
    pantrySettings: {
      articleList: [],
      savedForRecipe: [{ recipeUuid: 'R7', contentSaved: 300 }],
    },
  },
  {
    uuid: 'salt',
    name: 'Salz',
    unitId: 'g',
    amount: 1,
    contentVolume: 500,
    pantrySettings: { articleList: [] },
  },
];

/** Canned answers for the routes the tool tests read from. */
function respond(method?: string, url?: string, body?: string): unknown {
  if (url?.endsWith('/supermarkets')) {
    return [{ uid: 'coop', name: 'Coop', geofenceLat: 47.01, iconId: 'store' }];
  }
  if (url === '/user-management/me') return { uid: 'u1', email: 'a@b.c' };
  if (url?.startsWith('/recipe-collection/with-connected-recipe/')) {
    return [
      { uuid: 'c1', name: 'Abendessen', shareInList: false, hasRecipe: true },
      { uuid: 'c2', name: 'Curry', shareInList: true, hasRecipe: false },
    ];
  }
  if (method === 'GET' && url?.startsWith('/recipe-collection')) {
    return [
      { uuid: 'c1', name: 'Abendessen', shareInList: false, connectedRecipeImages: ['x.jpg'], recipeCount: 3 },
      { uuid: 'c2', name: 'Curry', shareInList: true, connectedRecipeImages: [], recipeCount: 0 },
    ];
  }
  if (method === 'POST' && url === '/recipe') return JSON.parse(body ?? '{}');
  if (method === 'GET' && url === '/list/L9/pantryList') return pantry;
  if (method === 'PUT' && url?.includes('/reservations/')) {
    const itemId = url.split('/')[4];
    return pantry.find((item) => item.uuid === itemId);
  }
  if (method === 'POST' && url?.endsWith('/cooked')) {
    return {
      items: [{ ...pantry[0], amount: 1 }],
      unbooked: [{ itemId: 'paprika', name: 'Paprika', content: 10 }],
    };
  }
  if (method === 'DELETE' && url?.includes('/reservations/')) return [pantry[0]];
  return { ok: true };
}

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
    res.end(JSON.stringify(respond(req.method, req.url, body)));
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
const {
  registerTools,
  applyPantryItemChanges,
  applyRecipeChanges,
  groupReservations,
  recipeIdForName,
} = await import('./tools.js');
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

// Recipes are saved as a whole, so create_recipe builds a complete recipe
// and update_recipe sends back a merged copy; these pin down both.
test('create_recipe merge: a new recipe gets the app defaults and the summed time', () => {
  const recipe = applyRecipeChanges(
    undefined,
    {
      name: 'Dal',
      preparationTime: 10,
      cookingTime: 25,
      ingredients: [
        { name: 'Rote Linsen', amount: 200, unit: 'g' },
        { name: 'Salz', unit: 'Pinch', notes: 'nach Geschmack' },
      ],
      steps: ['Linsen waschen.', { text: 'Köcheln lassen.', timerMinutes: 20 }],
    },
    'u1',
  );

  assert.match(recipe.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(recipe.authorUuid, 'u1');
  assert.equal(recipe.totalTime, 35);
  assert.equal(recipe.defaultServings, 4);
  assert.equal(recipe.servingsUnit, 'Portion');
  assert.equal(recipe.language, 'de-DE');
  assert.equal(recipe.shouldBePublic, false);
  assert.deepEqual(recipe.ingredients, [
    { name: 'Rote Linsen', contentVolume: 200, volumeUnit: 'g' },
    { name: 'Salz', contentVolume: 1, volumeUnit: 'Pinch', notes: 'nach Geschmack' },
  ]);
  assert.deepEqual(recipe.steps, [
    { text: 'Linsen waschen.', ingredients: [] },
    { text: 'Köcheln lassen.', ingredients: [], timerMinutes: 20 },
  ]);
});

const savedRecipe = {
  uuid: 'R7',
  name: 'Dal',
  authorUuid: 'u1',
  totalTime: 35,
  preparationTime: 10,
  defaultServings: 4,
  servingsUnit: 'Portion',
  shouldBePublic: false,
  showAuthor: true,
  language: 'de-DE',
  categories: ['Vegan'],
  imageUrl: 'https://img/dal.jpg',
  favorites: 3,
  source: { origin: 'manual' },
  ingredients: [
    { name: 'Linsen', contentVolume: 200, volumeUnit: 'g', normalizedName: 'linse', ingredientId: 'i1' },
  ],
  steps: [{ text: 'Kochen.', ingredients: [], timerMinutes: 20 }],
} as unknown as Parameters<typeof applyRecipeChanges>[0] & object;

test('update_recipe merge: omitted fields round-trip, read-only ones are left out', () => {
  const recipe = applyRecipeChanges(savedRecipe, { name: 'Linsen-Dal' }, 'u1');

  assert.equal(recipe.name, 'Linsen-Dal');
  assert.equal(recipe.uuid, 'R7');
  assert.equal(recipe.totalTime, 35);
  assert.equal(recipe.imageUrl, 'https://img/dal.jpg');
  assert.deepEqual(recipe.categories, ['Vegan']);
  assert.deepEqual(recipe.steps, savedRecipe.steps);
  assert.equal('favorites' in recipe, false);
  assert.equal('source' in recipe, false);
  assert.deepEqual(recipe.ingredients, [
    { name: 'Linsen', contentVolume: 200, volumeUnit: 'g' },
  ]);
});

test('update_recipe merge: ingredients and steps are replaced, not merged', () => {
  const recipe = applyRecipeChanges(
    savedRecipe,
    { ingredients: [{ name: 'Kichererbsen' }], steps: ['Anbraten.'] },
    'u1',
  );

  assert.deepEqual(recipe.ingredients, [
    { name: 'Kichererbsen', contentVolume: 1, volumeUnit: 'pieces' },
  ]);
  assert.deepEqual(recipe.steps, [{ text: 'Anbraten.', ingredients: [] }]);
  assert.equal(recipe.totalTime, 35);
});

test('create_recipe saves the recipe as the signed-in user, then files it', async () => {
  received.length = 0;
  const result = await callTool('create_recipe', {
    name: 'Dal',
    ingredients: [{ name: 'Linsen', amount: 200, unit: 'g' }],
    steps: ['Kochen.'],
    collectionIds: ['c2'],
  });

  assert.deepEqual(
    received.map((r) => `${r.method} ${r.url}`),
    [
      'GET /recipe-collection',
      'GET /user-management/me',
      'POST /recipe',
      `PUT /recipe-collection/recipe/${JSON.parse(received[2].body).uuid}`,
    ],
  );
  assert.equal(JSON.parse(received[2].body).authorUuid, 'u1');
  assert.deepEqual(JSON.parse(received[3].body), { collectionUuids: ['c2'] });
  assert.equal(JSON.parse(result.content[0].text).name, 'Dal');
});

test('create_recipe with an unknown collection fails before saving anything', async () => {
  received.length = 0;
  await assert.rejects(
    callTool('create_recipe', {
      name: 'Dal',
      ingredients: [],
      steps: [],
      collectionIds: ['nope'],
    }),
    /Unknown recipe collection nope/,
  );
  assert.deepEqual(
    received.map((r) => `${r.method} ${r.url}`),
    ['GET /recipe-collection'],
  );
});

test('list_recipe_collections returns uuid, name, sharing and count', async () => {
  const result = await callTool('list_recipe_collections', {});

  assert.deepEqual(JSON.parse(result.content[0].text), [
    { uuid: 'c1', name: 'Abendessen', shareInList: false, recipeCount: 3 },
    { uuid: 'c2', name: 'Curry', shareInList: true, recipeCount: 0 },
  ]);
});

test('add_recipe_to_collection keeps the recipe in its other collections', async () => {
  received.length = 0;
  const result = await callTool('add_recipe_to_collection', {
    recipeId: 'R7',
    collectionId: 'c2',
  });

  assert.equal(received[1].method, 'PUT');
  assert.equal(received[1].url, '/recipe-collection/recipe/R7');
  assert.deepEqual(JSON.parse(received[1].body), { collectionUuids: ['c1', 'c2'] });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    collections: ['Abendessen', 'Curry'],
  });
});

test('add_recipe_to_collection rejects a collection the user cannot see', async () => {
  received.length = 0;
  await assert.rejects(
    callTool('add_recipe_to_collection', { recipeId: 'R7', collectionId: 'nope' }),
    /Unknown recipe collection nope/,
  );
  assert.equal(received.length, 1);
});

test('remove_recipe_from_collection keeps the other collections', async () => {
  received.length = 0;
  await callTool('remove_recipe_from_collection', {
    recipeId: 'R7',
    collectionId: 'c1',
  });

  assert.deepEqual(JSON.parse(received[1].body), { collectionUuids: [] });
});

type PantryItems = Parameters<typeof groupReservations>[0];

test('groupReservations groups the pantry by recipe', () => {
  assert.deepEqual(groupReservations(pantry as unknown as PantryItems), [
    {
      recipeId: 'ext-1',
      recipeName: 'Gulasch',
      items: [
        { itemId: 'paprika', name: 'Paprika', unitId: 'g', stock: 2, contentVolume: 50, contentSaved: 7 },
      ],
    },
    {
      recipeId: 'R7',
      items: [
        { itemId: 'paprika', name: 'Paprika', unitId: 'g', stock: 2, contentVolume: 50, amountSaved: 1 },
        { itemId: 'rice', name: 'Reis', unitId: 'g', stock: 1, contentVolume: 1000, contentSaved: 300 },
      ],
    },
  ]);
});

test('recipeIdForName reuses the id a name is already reserved under', () => {
  const items = pantry as unknown as PantryItems;
  assert.equal(recipeIdForName(items, ' gulasch '), 'ext-1');
  const fresh = recipeIdForName(items, 'Linsensuppe');
  assert.notEqual(fresh, 'ext-1');
  assert.match(fresh, /^[0-9a-f-]{36}$/);
});

test('reserve_pantry_for_recipe by name reserves every item under one id', async () => {
  received.length = 0;
  const result = await callTool('reserve_pantry_for_recipe', {
    recipeName: 'Gulasch',
    items: [
      { itemId: 'paprika', content: 10 },
      { itemId: 'salt', packages: 1 },
    ],
    listId: 'L9',
  });

  assert.deepEqual(
    received.map((r) => `${r.method} ${r.url}`),
    [
      'GET /list/L9/pantryList',
      'PUT /list/L9/pantryList/paprika/reservations/ext-1',
      'PUT /list/L9/pantryList/salt/reservations/ext-1',
    ],
  );
  assert.deepEqual(JSON.parse(received[1].body), { recipeName: 'Gulasch', contentSaved: 10 });
  assert.deepEqual(JSON.parse(received[2].body), { recipeName: 'Gulasch', amountSaved: 1 });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    recipeId: 'ext-1',
    recipeName: 'Gulasch',
    reserved: [
      { itemId: 'paprika', name: 'Paprika', content: 10, unitId: 'g' },
      { itemId: 'salt', name: 'Salz', packages: 1 },
    ],
  });
});

test('reserve_pantry_for_recipe by recipeId skips the pantry lookup', async () => {
  received.length = 0;
  await callTool('reserve_pantry_for_recipe', {
    recipeId: 'R7',
    items: [{ itemId: 'rice', content: 300 }],
    listId: 'L9',
  });

  assert.deepEqual(
    received.map((r) => `${r.method} ${r.url}`),
    ['PUT /list/L9/pantryList/rice/reservations/R7'],
  );
  assert.deepEqual(JSON.parse(received[0].body), { contentSaved: 300 });
});

test('reserve_pantry_for_recipe wants exactly one of recipeId and recipeName', async () => {
  received.length = 0;
  await assert.rejects(
    callTool('reserve_pantry_for_recipe', {
      recipeId: 'R7',
      recipeName: 'Dal',
      items: [{ itemId: 'rice', content: 1 }],
      listId: 'L9',
    }),
    /either `recipeId` or `recipeName`/,
  );
  assert.equal(received.length, 0);
});

test('cook_recipe books the reservation and reports what was not covered', async () => {
  received.length = 0;
  const result = await callTool('cook_recipe', { recipeId: 'ext-1', listId: 'L9' });

  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/list/L9/pantryList/reservations/ext-1/cooked');
  assert.deepEqual(JSON.parse(received[0].body), { autoRestock: false });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    items: [{ itemId: 'paprika', name: 'Paprika', stock: 1, unitId: 'g', contentVolume: 50 }],
    unbooked: [{ itemId: 'paprika', name: 'Paprika', content: 10 }],
  });
});

test('release_recipe_reservation releases one item or the whole recipe', async () => {
  received.length = 0;
  await callTool('release_recipe_reservation', { recipeId: 'R7', itemId: 'rice', listId: 'L9' });
  await callTool('release_recipe_reservation', { recipeId: 'R7', listId: 'L9' });

  assert.deepEqual(
    received.map((r) => `${r.method} ${r.url}`),
    [
      'DELETE /list/L9/pantryList/rice/reservations/R7',
      'DELETE /list/L9/pantryList/reservations/R7',
    ],
  );
});
