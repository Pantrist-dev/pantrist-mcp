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
    .describe('List UUID. Defaults to PANTRIST_LIST_ID if omitted.'),
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
    'List the shopping lists / pantries the authenticated user can access. Use a returned id as `listId` for the other tools.',
    {},
    async () => text(unwrap(await client().GET('/list'))),
  );

  // --- shopping list -------------------------------------------------------
  server.tool(
    'list_shopping_items',
    'Get all items currently on the shopping list.',
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
    'Add an item to the shopping list by name.',
    { name: z.string().describe('Item name, e.g. "Milk".'), ...listIdArg },
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
    'Check off a shopping-list item. Depending on list settings this marks it done, removes it, or moves it to the pantry.',
    { itemId: z.string().describe('Item uuid.'), ...listIdArg },
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
    'Remove an item from the shopping list.',
    { itemId: z.string().describe('Item uuid.'), ...listIdArg },
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
    'Get all items currently in the pantry.',
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
    'Add an item to the pantry by name.',
    {
      name: z.string(),
      amount: z.number().optional(),
      unitId: z.string().optional(),
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
    'Change the stock amount of a pantry item. Use a negative `amountChange` to consume stock.',
    {
      itemId: z.string().describe('Item uuid.'),
      amountChange: z
        .number()
        .describe('Delta applied to the current amount; negative consumes.'),
      autoRestock: z
        .boolean()
        .optional()
        .describe(
          'If true and the item lands at/below its minimumAmount, also re-add it to the shopping list. Defaults to false.',
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

  // --- recipes -------------------------------------------------------------
  server.tool(
    'search_recipes',
    'Search recipes by free-text and optional filters.',
    {
      searchString: z.string().optional(),
      categories: z.array(z.enum(RECIPE_CATEGORIES)).optional(),
      currentPage: z.number().int().min(1).optional(),
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
    'Get a single recipe by its uuid.',
    { recipeId: z.string() },
    async ({ recipeId }) =>
      text(
        unwrap(
          await client().GET('/recipe/{uid}', {
            params: { path: { uid: recipeId } },
          }),
        ),
      ),
  );

  // --- week plan -----------------------------------------------------------
  server.tool(
    'get_week_plan',
    'Get the meal plan for a date range. Dates are YYYY-MM-DD.',
    {
      from: z.string().describe('Start date, YYYY-MM-DD.'),
      to: z.string().describe('End date, YYYY-MM-DD.'),
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
    'Set the planned recipes/meals for a single day (YYYY-MM-DD).',
    {
      date: z.string().describe('Day to set, YYYY-MM-DD.'),
      list: z
        .array(
          z.discriminatedUnion('type', [
            z.object({
              type: z.literal('recipe'),
              uuid: z.string().describe('Recipe uuid.'),
            }),
            z.object({
              type: z.literal('manual'),
              name: z.string().describe('Free text meal name.'),
            }),
          ]),
        )
        .describe('Entries planned for the day. Empty array clears the day.'),
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
