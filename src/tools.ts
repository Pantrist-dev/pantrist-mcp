import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { client, currentUser, resolveListId, unwrap } from './api.js';
import type { components } from './generated/pantrist-api.js';

type ArticleDto = components['schemas']['ArticleDto'];
type RecipeDto = components['schemas']['RecipeDto'];
type IngredientDto = components['schemas']['IngredientDto'];
type StepDto = components['schemas']['StepDto'];

/** Fields `update_pantry_item` can change; omitted ones keep their value. */
export interface PantryItemChanges {
  name?: string;
  brand?: string | null;
  categoryUuid?: string;
  unitId?: string;
  notes?: string | null;
  bestBefore?: string | null;
  minimumAmount?: number;
  minimumAmountMode?: ArticleDto['minimumAmountMode'];
  manageMinimumAmount?: boolean;
}

/**
 * Merge the requested changes into the current article for the full-upsert
 * PUT. The best-before date lives per stock batch in
 * `pantrySettings.articleList`, so a new date is written to every batch and
 * mirrored into `earliestBestBefore`; the date is user-set from then on, so
 * `calculatedBestBeforeDate` is cleared.
 */
export function applyPantryItemChanges(
  current: ArticleDto,
  changes: PantryItemChanges,
): ArticleDto {
  const { bestBefore, minimumAmount, manageMinimumAmount, ...metadata } =
    changes;
  const merged: ArticleDto = { ...current };
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }

  if (minimumAmount !== undefined) {
    merged.minimumAmount = minimumAmount;
    // Setting a minimum without tracking it would have no effect, so turn
    // tracking on unless the caller explicitly said otherwise.
    merged.manageMinimumAmount = manageMinimumAmount ?? true;
  } else if (manageMinimumAmount !== undefined) {
    merged.manageMinimumAmount = manageMinimumAmount;
  }

  if (bestBefore !== undefined) {
    const batches = current.pantrySettings.articleList;
    const articleList = (
      batches.length > 0
        ? batches
        : // No batch yet: '1' is the default pantry every item lands in.
          [{ pantryUuid: '1', count: current.amount }]
    ).map((batch) => {
      const { bestBefore: _old, calculatedBestBeforeDate: _calc, ...rest } =
        batch;
      return bestBefore === null
        ? rest
        : { ...rest, bestBefore, calculatedBestBeforeDate: false };
    });
    const { earliestBestBefore: _old, ...settings } = current.pantrySettings;
    merged.pantrySettings = {
      ...settings,
      articleList,
      ...(bestBefore === null ? {} : { earliestBestBefore: bestBefore }),
    };
  }

  return merged;
}

/**
 * Recipe categories accepted by `/recipe/filter`. Kept in lockstep with the
 * `ReceiptCategory` enum in the generated client; surfaced here as a Zod
 * enum so invalid values are rejected at MCP-input time instead of the
 * model getting an opaque 400 from the API.
 */
const RECIPE_CATEGORIES = [
  'Breakfast', 'Lunch', 'Dinner', 'Snacks', 'Dessert', 'Salad', 'Shake',
  'Soup', 'Smoothie', 'Appetizer', 'SideDish', 'Stew', 'Quick', 'ToGo',
  'FewIngredients', 'Baking', 'Casserole', 'OvenDish', 'DoughDish', 'Easy',
  'Basic', 'Vegetarian', 'Vegan', 'LowCarb', 'LowFat', 'LowCalorie',
  'HighProtein', 'HighFiber', 'CleanEating', 'Keto', 'Pescatarian',
  'SugarFree', 'GlutenFree', 'LactoseFree', 'Detox', 'Vegetables',
  'Fruits', 'Meat', 'Fish', 'Poultry', 'Rice', 'Potatoes', 'Pasta',
  'Sweet', 'German', 'Italian', 'Asian', 'Mexican', 'Indian',
  'Mediterranean', 'Oriental', 'Advanced',
] as const;

/** Ingredient units (`IngredientDto.volumeUnit`). */
const INGREDIENT_UNITS = [
  'pieces', 'packet', 'g', 'kg', 'l', 'ml', 'cup', 'tbsp', 'tsp', 'lbs',
  'qt', 'oz', 'fl-oz', 'gal', 'Pinch',
] as const;

/** Units a recipe's servings can be counted in (`RecipeDto.servingsUnit`). */
const SERVINGS_UNITS = [
  'Portion', 'pieces', 'packet', 'g', 'kg', 'l', 'ml', 'cup', 'tbsp', 'tsp',
  'lbs', 'qt', 'oz', 'fl-oz', 'gal',
] as const;

const RECIPE_LANGUAGES = [
  'de-DE', 'en-US', 'en-GB', 'pl-PL', 'sv-SE', 'nl-NL', 'pt-PT', 'pt-BR',
  'it-IT', 'es-ES',
] as const;

export interface IngredientInput {
  name: string;
  amount?: number;
  unit?: IngredientDto['volumeUnit'];
  notes?: string;
}

export type StepInput = string | { text: string; timerMinutes?: number };

/** Fields `create_recipe` / `update_recipe` take; omitted ones keep their value. */
export interface RecipeChanges {
  name?: string;
  description?: string | null;
  language?: (typeof RECIPE_LANGUAGES)[number];
  servings?: number;
  servingsUnit?: RecipeDto['servingsUnit'];
  preparationTime?: number;
  cookingTime?: number;
  waitingTime?: number;
  totalTime?: number;
  categories?: RecipeDto['categories'];
  ingredients?: IngredientInput[];
  steps?: StepInput[];
  link?: string | null;
  shouldBePublic?: boolean;
}

/**
 * The fields the save route accepts. It rejects any other property, and a
 * fetched recipe carries several (`favorites`, `source`, the match counts),
 * so an update sends this subset of the merged recipe rather than all of it.
 */
const WRITABLE_RECIPE_FIELDS = [
  'uuid', 'imageUrl', 'name', 'description', 'totalTime', 'cookingTime',
  'waitingTime', 'preparationTime', 'defaultServings', 'servingsUnit',
  'shouldBePublic', 'categories', 'allergens', 'language', 'link',
  'showAuthor', 'authorUuid', 'ingredients',
  'steps', 'partialSteps', 'copiedFromReceiptUuid', 'nutriments',
  'createdAt',
] as const;

function toIngredient({ name, amount, unit, notes }: IngredientInput): IngredientDto {
  return {
    name,
    contentVolume: amount ?? 1,
    volumeUnit: unit ?? 'pieces',
    ...(notes ? { notes } : {}),
  };
}

function toStep(step: StepInput): StepDto {
  const { text, timerMinutes } =
    typeof step === 'string' ? { text: step, timerMinutes: undefined } : step;
  return {
    text,
    ingredients: [],
    ...(timerMinutes !== undefined ? { timerMinutes } : {}),
  };
}

/** Drop the server-derived match keys; the save derives them again. */
function writableIngredient({
  normalizedName: _n,
  ingredientId: _i,
  ...ingredient
}: IngredientDto): IngredientDto {
  return ingredient;
}

/**
 * Merge the requested changes into a recipe for the full-replace save. With
 * no `current` it builds a new recipe from the app's defaults (private,
 * author shown, servings in portions). `ingredients` and `steps` replace
 * the existing ones as a whole.
 */
export function applyRecipeChanges(
  current: RecipeDto | undefined,
  changes: RecipeChanges,
  authorUuid: string,
): RecipeDto {
  const base: RecipeDto = current ?? {
    uuid: randomUUID(),
    name: '',
    totalTime: 0,
    preparationTime: 0,
    defaultServings: 4,
    servingsUnit: 'Portion',
    shouldBePublic: false,
    showAuthor: true,
    categories: [],
    language: 'de-DE',
    authorUuid,
    ingredients: [],
    steps: [],
  } as unknown as RecipeDto;

  const { servings, ingredients, steps, ...fields } = changes;
  const merged: RecipeDto = { ...base };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) Object.assign(merged, { [key]: value });
  }
  if (servings !== undefined) merged.defaultServings = servings;
  if (ingredients !== undefined) merged.ingredients = ingredients.map(toIngredient);
  if (steps !== undefined) merged.steps = steps.map(toStep);
  if (!current && changes.totalTime === undefined) {
    merged.totalTime =
      (merged.preparationTime ?? 0) +
      (merged.cookingTime ?? 0) +
      (merged.waitingTime ?? 0);
  }

  const body: Record<string, unknown> = {};
  for (const key of WRITABLE_RECIPE_FIELDS) {
    if (merged[key] !== undefined) body[key] = merged[key];
  }
  body.ingredients = merged.ingredients.map(writableIngredient);
  body.steps = merged.steps.map((step) => ({
    ...step,
    ingredients: step.ingredients.map(writableIngredient),
  }));
  return body as unknown as RecipeDto;
}

/** Wrap any value as an MCP text content result. */
function text(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text:
          data === undefined
            ? 'Done.'
            : typeof data === 'string'
              ? data
              : JSON.stringify(data, null, 2),
      },
    ],
  };
}

/**
 * Recipe fields shared by `create_recipe` and `update_recipe`. All optional
 * here; `create_recipe` makes the ones a new recipe needs required.
 */
const recipeName = z.string().min(1).describe('Recipe name, e.g. "Linsen-Dal".');

const recipeIngredients = z
  .array(
    z.object({
      name: z
        .string()
        .describe(
          'Plain ingredient name, e.g. "Karotte". The server resolves it against the shared ingredient catalog to match the recipe with the pantry, so keep amounts, units and preparation out of it.',
        ),
      amount: z
        .number()
        .min(0)
        .optional()
        .describe('Amount in `unit`. Defaults to 1.'),
      unit: z
        .enum(INGREDIENT_UNITS)
        .optional()
        .describe(
          'Unit of `amount`. Defaults to "pieces". For "salt to taste" use amount 1, unit "Pinch" and the note.',
        ),
      notes: z
        .string()
        .optional()
        .describe('Preparation or detail, e.g. "fein gerieben", "gegart", "nach Geschmack".'),
    }),
  )
  .describe(
    'Ingredients in display order. On update the whole list is replaced, not merged: pass every ingredient, also the unchanged ones.',
  );

const recipeSteps = z
  .array(
    z.union([
      z.string(),
      z.object({
        text: z.string().describe('Instruction text of the step.'),
        timerMinutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .optional()
          .describe('Timer the cooking mode offers for this step.'),
      }),
    ]),
  )
  .describe(
    'Steps in order, each a string or `{ text, timerMinutes }`. On update the whole list is replaced, not merged.',
  );

const recipeFieldArgs = {
  name: recipeName.optional(),
  description: z
    .string()
    .nullable()
    .optional()
    .describe('Short description. On update pass null to clear.'),
  language: z
    .enum(RECIPE_LANGUAGES)
    .optional()
    .describe(
      'Language the recipe is written in. The server matches ingredient names in this language, so it must fit the text. Defaults to "de-DE" on create.',
    ),
  servings: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('How many `servingsUnit` the recipe yields. Defaults to 4 on create.'),
  servingsUnit: z
    .enum(SERVINGS_UNITS)
    .optional()
    .describe('What `servings` counts. Defaults to "Portion" on create.'),
  preparationTime: z
    .number()
    .min(0)
    .optional()
    .describe('Active preparation time in minutes (chopping, mixing). Defaults to 0 on create.'),
  cookingTime: z
    .number()
    .min(0)
    .optional()
    .describe('Time on the stove or in the oven, in minutes.'),
  waitingTime: z
    .number()
    .min(0)
    .optional()
    .describe('Resting, marinating or chilling time in minutes.'),
  totalTime: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Total time in minutes. On create it defaults to preparationTime + cookingTime + waitingTime.',
    ),
  categories: z
    .array(z.enum(RECIPE_CATEGORIES))
    .optional()
    .describe(
      'Categories, e.g. ["Dinner", "Vegan", "Easy", "Indian"]. Meal types, diets, main ingredients, cuisines and `Easy`/`Advanced` for difficulty all live here. Replaces the existing categories on update.',
    ),
  ingredients: recipeIngredients.optional(),
  steps: recipeSteps.optional(),
  link: z
    .string()
    .nullable()
    .optional()
    .describe('URL of the original recipe, if it comes from a website. On update pass null to clear.'),
  shouldBePublic: z
    .boolean()
    .optional()
    .describe(
      'Whether other Pantrist users can find the recipe. Defaults to false (private; members of the user\'s lists still see it). Only set true when the user asks to publish it.',
    ),
  collectionIds: z
    .array(z.string())
    .optional()
    .describe(
      'Recipe collections to file the recipe into: `uuid`s from `list_recipe_collections`. Replaces the recipe\'s current collections. An unknown uuid fails the call before anything is saved.',
    ),
};

/**
 * Throw unless every id is a collection the user can see, so a wrong id
 * fails before the recipe is written rather than being dropped silently by
 * the assignment route.
 */
async function assertCollectionsExist(collectionIds: string[]): Promise<void> {
  if (collectionIds.length === 0) return;
  const known = new Set(
    unwrap(await client().GET('/recipe-collection', {})).map((c) => c.uuid),
  );
  const unknown = collectionIds.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(
      `Unknown recipe collection ${unknown.join(', ')}. Call \`list_recipe_collections\` for valid uuids.`,
    );
  }
}

async function setRecipeCollections(
  recipeId: string,
  collectionUuids: string[],
): Promise<void> {
  unwrap(
    await client().PUT('/recipe-collection/recipe/{recipeUuid}', {
      params: { path: { recipeUuid: recipeId } },
      body: { collectionUuids },
    }),
  );
}

/** The user's collections with a flag whether `recipeId` is in each. */
async function collectionsOfRecipe(recipeId: string) {
  return unwrap(
    await client().GET('/recipe-collection/with-connected-recipe/{recipeId}', {
      params: { path: { recipeId } },
    }),
  );
}

const listIdArg = {
  listId: z
    .string()
    .optional()
    .describe(
      'List UUID — call `list_lists` to discover one. Optional only in stdio mode (falls back to the PANTRIST_LIST_ID env var); required explicitly in HTTP mode.',
    ),
};

/**
 * Curated tool set mapped onto the real Pantrist REST routes via the typed
 * `openapi-fetch` client. Deliberately a focused subset — not every endpoint —
 * so the model's tool context stays legible.
 */
export function registerTools(server: McpServer): void {
  // --- discovery -----------------------------------------------------------
  server.tool(
    'list_lists',
    'List the shopping lists / pantries the authenticated user can access. Read-only. Returns an array of list objects each with `uuid`, `name`, and the user\'s role on that list — use a returned `uuid` as the `listId` argument for every other tool here.',
    {},
    async () => text(unwrap(await client().GET('/list'))),
  );

  server.tool(
    'whoami',
    'Show which Pantrist account this connection is signed in as. Read-only. Returns `email`, `displayName`, `loginMethod` ("google.com", "apple.com" or "facebook.com"; an email/password account may show "password" or null) and `uid`. Use it when `list_lists` comes back empty or lacks a list the user expects: the user is then usually signed in to the Pantrist app with a different account, or uses the app without one.',
    {},
    async () => {
      const user = await currentUser();
      if (!user) {
        return text('No Pantrist account is linked to this connection.');
      }
      // Only what identifies the account; the full UserDto also carries
      // subscription, notification and location data the model has no use for.
      return text({
        email: user.email,
        displayName: user.displayName,
        loginMethod: user.providerId ?? null,
        uid: user.uid,
      });
    },
  );

  // --- shopping list -------------------------------------------------------
  server.tool(
    'list_supermarkets',
    'List the markets (supermarkets, shops) set up on the list `listId`. Read-only. Returns an array of `{ uid, name }`. Pass a `uid` in `supermarketIds` of `add_shopping_item` to put an item on that market\'s list, instead of writing the shop into the item name.',
    { ...listIdArg },
    async ({ listId }) => {
      const markets = unwrap(
        await client().GET('/list/{listId}/supermarkets', {
          params: { path: { listId: resolveListId(listId) } },
        }),
      );
      // Only what identifies a market; the full dto also carries the
      // store's coordinates and category order the model has no use for.
      return text(markets.map(({ uid, name }) => ({ uid, name })));
    },
  );

  server.tool(
    'list_shopping_items',
    'List all items currently on the shopping list for `listId`. Read-only. Returns an array of `ArticleDto` objects (`uuid`, `name`, `amount`, `unitId`, `categoryUuid`, `pantrySettings`, …); empty array if the list is empty. For pantry items use `list_pantry_items`; to add a new shopping item use `add_shopping_item`.',
    { ...listIdArg },
    async ({ listId }) =>
      text(
        unwrap(
          await client().GET('/list/{listId}/shoppingList', {
            params: { path: { listId: resolveListId(listId) } },
          }),
        ),
      ),
  );

  server.tool(
    'add_shopping_item',
    'Add an item to the shopping list by name. The API matches `name` against the user\'s article catalog: an existing article is reused (its category, unit and price history preserved); a new article is created on first use. To have it bought at a particular shop, pass that market in `supermarketIds` (from `list_supermarkets`); never put the shop into `name`. Returns the resulting `ArticleDto`. To add directly to the pantry instead use `add_pantry_item`; to mark an existing shopping item bought use `check_shopping_item`.',
    {
      name: z
        .string()
        .describe(
          'Item name, e.g. "Milk", without the shop. Matched case-insensitively against the article catalog; an exact match reuses the existing article.',
        ),
      supermarketIds: z
        .array(z.string())
        .optional()
        .describe(
          'Markets to buy the item at: `uid`s from `list_supermarkets` for the same list. An unknown uid is rejected. Omit for an item not tied to a shop.',
        ),
      ...listIdArg,
    },
    async ({ name, supermarketIds, listId }) =>
      text(
        unwrap(
          await client().POST('/list/{listId}/shoppingList/add-by-name', {
            params: { path: { listId: resolveListId(listId) } },
            body: supermarketIds?.length ? { name, supermarketIds } : { name },
          }),
        ),
      ),
  );

  server.tool(
    'check_shopping_item',
    'Check off a shopping-list item. The list\'s settings decide the actual effect: `markDone` flags the item as bought (stays on the list, struck through), `removeOnCheck` deletes it, and `moveOnCheck` transfers it into the pantry. Mutates state and returns the updated row. To unconditionally remove regardless of list settings use `delete_shopping_item`; for stock changes on a pantry item use `reduce_pantry_amount`.',
    {
      itemId: z
        .string()
        .describe(
          'Item uuid (from `list_shopping_items[].uuid` or `add_shopping_item`).',
        ),
      ...listIdArg,
    },
    async ({ itemId, listId }) =>
      text(
        unwrap(
          await client().POST(
            '/list/{listId}/shoppingList/{itemId}/check',
            { params: { path: { listId: resolveListId(listId), itemId } } },
          ),
        ),
      ),
  );

  server.tool(
    'delete_shopping_item',
    'Remove an item from the shopping list, unconditionally and irreversibly (no soft-delete, not affected by list `removeOnCheck` setting). Returns a confirmation string; the row is gone after the call returns. Use `check_shopping_item` instead if you want list-setting-dependent behaviour (mark done / move to pantry) rather than a hard delete.',
    {
      itemId: z
        .string()
        .describe(
          'Item uuid (from `list_shopping_items[].uuid`). Hard-delete is permanent — verify before calling.',
        ),
      ...listIdArg,
    },
    async ({ itemId, listId }) => {
      unwrap(
        await client().DELETE('/list/{listId}/shoppingList/{itemId}', {
          params: { path: { listId: resolveListId(listId), itemId } },
        }),
      );
      return text(`Removed item ${itemId} from the shopping list.`);
    },
  );

  // --- pantry --------------------------------------------------------------
  server.tool(
    'list_pantry_items',
    'List all items currently stocked in the pantry for `listId`. Read-only. Returns an array of `ArticleDto` objects (`uuid`, `name`, `amount` = current stock, `unitId`, `pantrySettings.earliestBestBefore` for expiry tracking, `minimumAmount` (in packages, or in content of `unitId` when `minimumAmountMode` is `content`, e.g. 3 rolls out of packs of 8 with `contentVolume` 8), …); empty array if the pantry is empty. For shopping items use `list_shopping_items`; for stock changes on an existing item use `reduce_pantry_amount`; for metadata changes use `update_pantry_item`.',
    { ...listIdArg },
    async ({ listId }) =>
      text(
        unwrap(
          await client().GET('/list/{listId}/pantryList', {
            params: { path: { listId: resolveListId(listId) } },
          }),
        ),
      ),
  );

  server.tool(
    'add_pantry_item',
    'Add a new item to the pantry by name. The API matches `name` against the user\'s article catalog: an existing article is reused (its category, unit, price history preserved); a new article is created on first use. Returns the resulting `ArticleDto`. Use `reduce_pantry_amount` to change stock on an item already in the pantry; use `update_pantry_item` to rename or change unit / category; use `add_shopping_item` to put it on the shopping list instead.',
    {
      name: z
        .string()
        .describe(
          'Item name, e.g. "Milk". Matched case-insensitively against the article catalog; matches reuse the existing article.',
        ),
      amount: z
        .number()
        .optional()
        .describe(
          'Initial stock amount. Defaults to 1 if omitted (server-applied).',
        ),
      unitId: z
        .string()
        .optional()
        .describe(
          'Unit id, e.g. "pieces", "g", "ml", "l". Defaults to "pieces" if omitted (server-applied). Discover supported ids by inspecting any existing pantry item\'s `unitId`.',
        ),
      ...listIdArg,
    },
    async ({ name, amount, unitId, listId }) => {
      // `amount`/`unitId` carry server-side defaults (1 / "pieces"); send
      // them only when set so the API applies its defaults instead of
      // taking a literal undefined through the wire.
      const body: { name: string; amount?: number; unitId?: string } = {
        name,
      };
      if (amount !== undefined) body.amount = amount;
      if (unitId !== undefined) body.unitId = unitId;
      return text(
        unwrap(
          await client().POST('/list/{listId}/pantryList/add-by-name', {
            params: { path: { listId: resolveListId(listId) } },
            // openapi-fetch validates against the generated DTO; the cast
            // is unavoidable because the spec marks `amount`/`unitId`
            // required and we deliberately omit them to trigger defaults.
            body: body as { name: string; amount: number; unitId: string },
          }),
        ),
      );
    },
  );

  server.tool(
    'reduce_pantry_amount',
    'Change the stock of an existing pantry item by a delta. Mutates state and returns the updated `ArticleDto`. If `autoRestock` is true and the new amount lands at or below the item\'s `minimumAmount`, the item is also added to the shopping list in the same call. Use `add_pantry_item` to create a new pantry entry; use `update_pantry_item` for metadata (name / unit / category) — this tool only touches stock.',
    {
      itemId: z
        .string()
        .describe(
          'Item uuid (from `list_pantry_items[].uuid`). Item must already exist in the pantry — this tool does not create.',
        ),
      amountChange: z
        .number()
        .describe(
          'Delta added to the current `amount` — negative consumes stock, positive restocks. Despite the tool name, positive values work for restocking too.',
        ),
      autoRestock: z
        .boolean()
        .optional()
        .describe(
          'If true and the resulting amount drops to or below the item\'s `minimumAmount` (with `manageMinimumAmount` enabled), the item is also added to the shopping list in the same call. Defaults to false so reads stay quiet.',
        ),
      ...listIdArg,
    },
    async ({ itemId, amountChange, autoRestock, listId }) =>
      text(
        unwrap(
          await client().PUT(
            '/list/{listId}/pantryList/{itemId}/change-amount',
            {
              params: { path: { listId: resolveListId(listId), itemId } },
              body: { amountChange, autoRestock: autoRestock ?? false },
            },
          ),
        ),
      ),
  );

  server.tool(
    'update_pantry_item',
    'Update an existing pantry item\'s metadata (rename, change unit, category, brand, notes, best-before date, minimum amount). Internally fetches the current `ArticleDto` and PUTs back a merged copy — only the fields you pass change; everything else (current stock, price history, image URLs, autoRestock config) round-trips unchanged. Two API calls per invocation. Returns the updated `ArticleDto`. Use `reduce_pantry_amount` for stock changes — this tool only touches metadata.',
    {
      itemId: z
        .string()
        .describe(
          'Item uuid (from `list_pantry_items[].uuid`). Item must already exist.',
        ),
      name: z.string().optional().describe('New name. Omit to keep current.'),
      brand: z
        .string()
        .nullable()
        .optional()
        .describe(
          'New brand. Omit to keep current; pass null to clear an existing brand.',
        ),
      categoryUuid: z
        .string()
        .optional()
        .describe(
          'New category uuid. Discover existing ones by inspecting `list_pantry_items[].categoryUuid`.',
        ),
      unitId: z
        .string()
        .optional()
        .describe(
          'New unit id, e.g. "pieces", "g", "ml". Changes how `amount` is displayed but does NOT convert existing stock.',
        ),
      notes: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Freeform notes. Omit to keep current; pass null to clear an existing note.',
        ),
      bestBefore: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
        .nullable()
        .optional()
        .describe(
          'Best-before date `YYYY-MM-DD`, applied to all of the item\'s stock (every batch in `pantrySettings.articleList`, so batches with different dates end up sharing this one). Feeds expiry tracking and the expiry calendar. Omit to keep current; pass null to clear.',
        ),
      minimumAmount: z
        .number()
        .min(0)
        .optional()
        .describe(
          'Minimum stock; at or below it the item counts as low stock. In packages, or in content of `unitId` when `minimumAmountMode` is `content`. Setting it also enables `manageMinimumAmount` unless that is passed as false.',
        ),
      minimumAmountMode: z
        .enum(['packages', 'content'])
        .optional()
        .describe(
          'What `minimumAmount` counts: `packages` = whole packages; `content` = the content in `unitId` (`amount * contentVolume`), e.g. 3 rolls out of packs of 8. The shopping list still gets whole packages. Omit to keep current.',
        ),
      manageMinimumAmount: z
        .boolean()
        .optional()
        .describe(
          'Whether low-stock tracking is on for this item. Omit to keep current (or to have `minimumAmount` switch it on).',
        ),
      ...listIdArg,
    },
    async ({ itemId, listId, ...changes }) => {
      // PUT /pantryList/{itemId} is a FULL upsert — it replaces the row.
      // Fetch the current article first so the caller only has to send the
      // fields they want to change; everything else round-trips unchanged.
      const resolvedListId = resolveListId(listId);
      const current = unwrap(
        await client().GET('/list/{listId}/pantryList/{itemId}', {
          params: { path: { listId: resolvedListId, itemId } },
        }),
      );
      const merged = applyPantryItemChanges(current, changes);
      return text(
        unwrap(
          await client().PUT('/list/{listId}/pantryList/{itemId}', {
            params: { path: { listId: resolvedListId, itemId } },
            body: merged,
          }),
        ),
      );
    },
  );

  // --- recipes -------------------------------------------------------------
  server.tool(
    'search_recipes',
    'Search the user\'s recipes (their own creations + public favourites) by free-text and optional category filters. Read-only and paginated — returns `{ results: RecipeDto[], totalCount, totalPages, currentPage }`. To fetch a single recipe by uuid use `get_recipe`; to delete one you own use `delete_recipe`.',
    {
      searchString: z
        .string()
        .optional()
        .describe(
          'Free-text query matched against recipe name, description, and ingredient names. Case-insensitive. Omit to list all recipes (still paginated).',
        ),
      categories: z
        .array(z.enum(RECIPE_CATEGORIES))
        .optional()
        .describe(
          'Optional category filter — multiple categories are OR-combined. Values must come from the recipe-categories enum (e.g. "Breakfast", "Vegetarian", "LowCarb").',
        ),
      currentPage: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          '1-based page index. Page size is fixed server-side. Defaults to 1.',
        ),
    },
    async ({ searchString, categories, currentPage }) =>
      text(
        unwrap(
          await client().POST('/recipe/filter', {
            body: { searchString, categories, currentPage },
          }),
        ),
      ),
  );

  server.tool(
    'get_recipe',
    'Get a single recipe by its uuid. Read-only. Returns a full `RecipeDto` with `name`, `description`, `ingredients[]`, `steps[]`, `imageUrls[]`, `totalTime`, `categories[]`, etc. Use `search_recipes` to discover recipe uuids; use `delete_recipe` to remove one you own.',
    {
      recipeId: z
        .string()
        .describe(
          'Recipe uuid (from `search_recipes[].results[].uuid` or `list_pantry_items[].pantrySettings.linkedRecipeUuids`).',
        ),
    },
    async ({ recipeId }) =>
      text(
        unwrap(
          await client().GET('/recipe/{uid}', {
            params: { path: { uid: recipeId } },
          }),
        ),
      ),
  );

  server.tool(
    'delete_recipe',
    'Delete a recipe you own, unconditionally and irreversibly. A recipe of another user, also one shared through a list, answers 404 as if it did not exist; that error surfaces verbatim to the caller. Preview with `get_recipe` before calling to confirm authorship and contents.',
    {
      recipeId: z
        .string()
        .describe(
          'Recipe uuid. Hard-delete is permanent — confirm ownership via `get_recipe` first.',
        ),
    },
    async ({ recipeId }) => {
      unwrap(
        await client().DELETE('/recipe/{uid}', {
          params: { path: { uid: recipeId } },
        }),
      );
      return text(`Deleted recipe ${recipeId}.`);
    },
  );

  server.tool(
    'create_recipe',
    'Create a new recipe owned by the signed-in user and optionally file it into recipe collections. Always creates a new recipe, even when one with the same name exists — call `search_recipes` first if the recipe might already be there, and change an existing one with `update_recipe` instead. Ingredient names are resolved against the shared ingredient catalog (for matching with the pantry); this creates no articles in the shopping or pantry catalog. Recipes belong to the user, not to a list, so there is no `listId`. Images can only be added in the app. Returns the saved `RecipeDto`, the same shape as `get_recipe`; its `uuid` is the `recipeId` for follow-up calls.',
    {
      ...recipeFieldArgs,
      name: recipeName,
      ingredients: recipeIngredients,
      steps: recipeSteps,
    },
    async ({ collectionIds, ...changes }) => {
      if (collectionIds) await assertCollectionsExist(collectionIds);
      const user = await currentUser();
      if (!user) throw new Error('No Pantrist account is linked to this connection.');
      const recipe = unwrap(
        await client().POST('/recipe', {
          body: applyRecipeChanges(undefined, changes, user.uid),
        }),
      );
      if (collectionIds?.length) {
        await setRecipeCollections(recipe.uuid, collectionIds);
      }
      return text(recipe);
    },
  );

  server.tool(
    'update_recipe',
    'Change a recipe the user owns. Only the fields you pass change; everything else (image, allergens, nutriments, partial steps) round-trips unchanged. `ingredients`, `steps` and `categories` are replaced as a whole, never merged: to fix one ingredient, pass the full list from `get_recipe` with that entry changed. `collectionIds` replaces the recipe\'s collections; to add or remove a single one use `add_recipe_to_collection` / `remove_recipe_from_collection`. Recipes of other users, also ones shared through a list, are rejected with a 400 "You\'re not allowed to change the recipe". Two or more API calls per invocation. Returns the saved `RecipeDto`. To read use `get_recipe`, to delete `delete_recipe`.',
    {
      recipeId: z
        .string()
        .describe('Recipe uuid (from `search_recipes`, `get_recipe` or `create_recipe`).'),
      ...recipeFieldArgs,
    },
    async ({ recipeId, collectionIds, ...changes }) => {
      if (collectionIds) await assertCollectionsExist(collectionIds);
      // PUT /recipe replaces the whole recipe; fetch it so omitted fields
      // round-trip unchanged.
      const current = unwrap(
        await client().GET('/recipe/{uid}', {
          params: { path: { uid: recipeId } },
        }),
      );
      const recipe = unwrap(
        await client().PUT('/recipe', {
          body: applyRecipeChanges(current, changes, current.authorUuid),
        }),
      );
      if (collectionIds) await setRecipeCollections(recipeId, collectionIds);
      return text(recipe);
    },
  );

  // --- recipe collections --------------------------------------------------
  server.tool(
    'list_recipe_collections',
    'List the recipe collections the user can file recipes into: their own plus the ones members of their lists share. Read-only. Returns `[{ uuid, name, shareInList, recipeCount }]`; pass a `uuid` in `collectionIds` of `create_recipe` / `update_recipe` or as `collectionId` of `add_recipe_to_collection`. Collections belong to the user, not to a list. Create a new one with `create_recipe_collection`.',
    {
      searchText: z
        .string()
        .optional()
        .describe('Only collections whose name, or one of whose recipes\' names, contains this text.'),
    },
    async ({ searchText }) => {
      const collections = unwrap(
        await client().GET('/recipe-collection', {
          params: { query: searchText ? { searchText } : {} },
        }),
      );
      // Leave out the preview image URLs the app draws its tiles from.
      return text(
        collections.map(({ uuid, name, shareInList, recipeCount }) => ({
          uuid,
          name,
          shareInList,
          recipeCount,
        })),
      );
    },
  );

  server.tool(
    'create_recipe_collection',
    'Create a new, empty recipe collection for the user. Always creates a new one — check `list_recipe_collections` first so you do not create a second collection with the same name. Returns `{ uuid, name, shareInList }`; file recipes into it with `add_recipe_to_collection` or `collectionIds` of `create_recipe`.',
    {
      name: z.string().min(1).describe('Collection name, e.g. "Schnelle Abendessen".'),
      shareInList: z
        .boolean()
        .optional()
        .describe('Whether members of the user\'s lists see the collection too. Defaults to false.'),
    },
    async ({ name, shareInList }) => {
      const collection = unwrap(
        await client().POST('/recipe-collection', {
          body: { name, shareInList: shareInList ?? false },
        }),
      ) as { uuid: string; name: string; shareInList: boolean };
      return text({
        uuid: collection.uuid,
        name: collection.name,
        shareInList: collection.shareInList,
      });
    },
  );

  server.tool(
    'add_recipe_to_collection',
    'File a recipe into one recipe collection, keeping its other collections. Adding it to a collection it is already in changes nothing. Works for any recipe the user can see, not only their own. Fails when `collectionId` is not one of `list_recipe_collections`. Returns the names of the recipe\'s collections afterwards. To take it out again use `remove_recipe_from_collection`.',
    {
      recipeId: z.string().describe('Recipe uuid.'),
      collectionId: z.string().describe('Collection uuid from `list_recipe_collections`.'),
    },
    async ({ recipeId, collectionId }) => {
      const collections = await collectionsOfRecipe(recipeId);
      if (!collections.some((c) => c.uuid === collectionId)) {
        throw new Error(
          `Unknown recipe collection ${collectionId}. Call \`list_recipe_collections\` for valid uuids.`,
        );
      }
      const assigned = collections
        .filter((c) => c.hasRecipe || c.uuid === collectionId)
        .map((c) => c.uuid);
      await setRecipeCollections(recipeId, assigned);
      return text({
        collections: collections
          .filter((c) => assigned.includes(c.uuid))
          .map((c) => c.name),
      });
    },
  );

  server.tool(
    'remove_recipe_from_collection',
    'Take a recipe out of one recipe collection, keeping its other collections. The recipe itself stays; to delete it use `delete_recipe`. Removing it from a collection it is not in changes nothing. Returns the names of the recipe\'s collections afterwards.',
    {
      recipeId: z.string().describe('Recipe uuid.'),
      collectionId: z.string().describe('Collection uuid from `list_recipe_collections`.'),
    },
    async ({ recipeId, collectionId }) => {
      const collections = await collectionsOfRecipe(recipeId);
      const remaining = collections.filter(
        (c) => c.hasRecipe && c.uuid !== collectionId,
      );
      await setRecipeCollections(
        recipeId,
        remaining.map((c) => c.uuid),
      );
      return text({ collections: remaining.map((c) => c.name) });
    },
  );

  // --- week plan -----------------------------------------------------------
  server.tool(
    'get_week_plan',
    'List meal-plan entries between two dates (inclusive). Read-only. Returns an array of day objects — `[{ date, list: [{ type: "recipe" | "manual", uuid?, name? }, …] }, …]` — one per day that has any entries. Days with no plan are omitted from the response (so an empty array means nothing is planned in the range, not that the range is invalid). To set or clear a single day use `update_week_plan_day`.',
    {
      from: z
        .string()
        .describe(
          'Range start (inclusive), YYYY-MM-DD. Must be ≤ `to`; same value as `to` returns one day.',
        ),
      to: z
        .string()
        .describe('Range end (inclusive), YYYY-MM-DD.'),
      ...listIdArg,
    },
    async ({ from, to, listId }) =>
      text(
        unwrap(
          await client().GET('/list/{listId}/weekPlan', {
            params: { path: { listId: resolveListId(listId) }, query: { from, to } },
          }),
        ),
      ),
  );

  server.tool(
    'update_week_plan_day',
    'Replace the meal-plan entries for one day, identified by date. `list` is a full replacement — the day\'s previous entries are discarded. Pass an empty array to clear the day entirely. Returns the new `{ date, list }`. To read a date range use `get_week_plan`; to read a single recipe referenced in the plan use `get_recipe`.',
    {
      date: z
        .string()
        .describe(
          'Day to set, YYYY-MM-DD. This single day is fully replaced — adjacent days are not touched.',
        ),
      list: z
        .array(
          z.discriminatedUnion('type', [
            z.object({
              type: z
                .literal('recipe')
                .describe('Reference to a saved recipe by uuid.'),
              uuid: z
                .string()
                .describe(
                  'Recipe uuid (from `search_recipes` or `get_recipe`).',
                ),
            }),
            z.object({
              type: z
                .literal('manual')
                .describe(
                  'Free-text meal not tied to a stored recipe (e.g. "leftovers", "takeout").',
                ),
              name: z
                .string()
                .describe('Free-text meal name displayed in the plan.'),
            }),
          ]),
        )
        .describe(
          'Entries planned for the day. Each entry is either a recipe ref or a manual free-text meal. Empty array clears the day.',
        ),
      ...listIdArg,
    },
    async ({ date, list, listId }) =>
      text(
        unwrap(
          await client().PUT('/list/{listId}/weekPlan/{date}', {
            params: { path: { listId: resolveListId(listId), date } },
            body: { date, list },
          }),
        ),
      ),
  );
}
