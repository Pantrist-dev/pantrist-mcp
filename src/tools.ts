import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { client, resolveListId, unwrap } from './api.js';

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
  'Sweet',
] as const;

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

  // --- shopping list -------------------------------------------------------
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
    'Add an item to the shopping list by name. The API matches `name` against the user\'s article catalog: an existing article is reused (its category, unit and price history preserved); a new article is created on first use. Returns the resulting `ArticleDto`. To add directly to the pantry instead use `add_pantry_item`; to mark an existing shopping item bought use `check_shopping_item`.',
    {
      name: z
        .string()
        .describe(
          'Item name, e.g. "Milk". Matched case-insensitively against the article catalog; an exact match reuses the existing article.',
        ),
      ...listIdArg,
    },
    async ({ name, listId }) =>
      text(
        unwrap(
          await client().POST('/list/{listId}/shoppingList/add-by-name', {
            params: { path: { listId: resolveListId(listId) } },
            body: { name },
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
    'List all items currently stocked in the pantry for `listId`. Read-only. Returns an array of `ArticleDto` objects (`uuid`, `name`, `amount` = current stock, `unitId`, `pantrySettings.earliestBestBefore` for expiry tracking, `minimumAmount`, …); empty array if the pantry is empty. For shopping items use `list_shopping_items`; for stock changes on an existing item use `reduce_pantry_amount`; for metadata changes use `update_pantry_item`.',
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
    'Update an existing pantry item\'s metadata (rename, change unit, category, brand, notes). Internally fetches the current `ArticleDto` and PUTs back a merged copy — only the fields you pass change; everything else (current stock, price history, image URLs, autoRestock config) round-trips unchanged. Two API calls per invocation. Returns the updated `ArticleDto`. Use `reduce_pantry_amount` for stock changes — this tool only touches metadata.',
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
      ...listIdArg,
    },
    async ({ itemId, name, brand, categoryUuid, unitId, notes, listId }) => {
      // PUT /pantryList/{itemId} is a FULL upsert — it replaces the row.
      // Fetch the current article first so the caller only has to send the
      // fields they want to change; everything else round-trips unchanged.
      const resolvedListId = resolveListId(listId);
      const current = unwrap(
        await client().GET('/list/{listId}/pantryList/{itemId}', {
          params: { path: { listId: resolvedListId, itemId } },
        }),
      );
      const merged = {
        ...current,
        ...(name !== undefined ? { name } : {}),
        ...(brand !== undefined ? { brand } : {}),
        ...(categoryUuid !== undefined ? { categoryUuid } : {}),
        ...(unitId !== undefined ? { unitId } : {}),
        ...(notes !== undefined ? { notes } : {}),
      };
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
    'Delete a recipe you own, unconditionally and irreversibly. The API rejects deletes for recipes belonging to another user with a 403; that error surfaces verbatim to the caller. Preview with `get_recipe` before calling to confirm authorship and contents.',
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
