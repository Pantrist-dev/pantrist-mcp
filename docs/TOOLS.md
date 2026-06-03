# Tool reference

12 curated tools. Most accept an optional `listId`; if omitted it falls back to
`PANTRIST_LIST_ID` **in stdio mode only** (HTTP mode requires it explicitly —
call `list_lists` to discover ids). All map to public REST endpoints.

| Tool | Args | REST call | Notes |
|---|---|---|---|
| `list_lists` | — | `GET /list` | Returns the lists/pantries the user can access. Use an `id` as `listId`. |
| `list_shopping_items` | `listId?` | `GET /list/{listId}/shoppingList` | Full item objects (`ArticleDto`). |
| `add_shopping_item` | `name`, `listId?` | `POST …/shoppingList/add-by-name` | Returns the created item. |
| `check_shopping_item` | `itemId`, `listId?` | `POST …/shoppingList/{itemId}/check` | Marks done / removes / moves to pantry per list settings. |
| `delete_shopping_item` | `itemId`, `listId?` | `DELETE …/shoppingList/{itemId}` | Returns a confirmation string (204 upstream). |
| `list_pantry_items` | `listId?` | `GET /list/{listId}/pantryList` | Full item objects. |
| `add_pantry_item` | `name`, `amount?`, `unitId?`, `listId?` | `POST …/pantryList/add-by-name` | `amount`/`unitId` omitted ⇒ API defaults (1 / `pieces`). |
| `reduce_pantry_amount` | `itemId`, `amountChange`, `autoRestock?`, `listId?` | `PUT …/pantryList/{itemId}/change-amount` | `amountChange` is a **delta** (negative consumes). `autoRestock` defaults to false. |
| `update_pantry_item` | `itemId`, `name?`, `brand?`, `categoryUuid?`, `unitId?`, `notes?`, `listId?` | `GET` then `PUT …/pantryList/{itemId}` | Metadata only — use `reduce_pantry_amount` for stock. Fetches the current item first so omitted fields round-trip unchanged. Pass `null` to `brand`/`notes` to clear. |
| `search_recipes` | `searchString?`, `categories?`, `currentPage?` | `POST /recipe/filter` | Paginated; returns `{ results, totalCount, totalPages, currentPage }`. |
| `get_recipe` | `recipeId` | `GET /recipe/{recipeId}` | Returns the full `RecipeDto`. |
| `delete_recipe` | `recipeId` | `DELETE /recipe/{recipeId}` | API rejects deletes of recipes you don't own — that error is surfaced verbatim. |
| `get_week_plan` | `from`, `to`, `listId?` | `GET /list/{listId}/weekPlan?from=&to=` | Dates `YYYY-MM-DD`. |
| `update_week_plan_day` | `date`, `list[]`, `listId?` | `PUT …/weekPlan/{date}` | `list` entries: `{ uuid?, name?, type?: recipe\|manual }`. Empty array clears the day. |

## Item shape

List/pantry tools return `ArticleDto` objects. The fields most useful to a
model:

```jsonc
{
  "uuid": "string",        // item id — pass as itemId to other tools
  "name": "string",
  "amount": 1,
  "unitId": "pieces",
  "categoryUuid": "string",
  "barcode": "string | string[] | null",
  "lastModified": 1700000000000  // epoch ms
  // …plus ~20 more fields; the whole object is passed through as JSON
}
```

> The tools intentionally pass the **whole** object through. This is simple and
> lossless but token-heavy for large lists — see
> [LIMITATIONS.md](./LIMITATIONS.md#large-responses).

## Adding a tool

1. Add a `server.tool(name, description, zodShape, handler)` in `src/tools.ts`.
2. Call the typed client: `client().GET('/path', { params, body })`, wrap with
   `unwrap()`.
3. If the endpoint isn't in `src/generated/pantrist-api.ts`, it isn't in the
   public OpenAPI spec — either it's app-specific (un-tag it in the backend) or
   you need to regenerate (see [ARCHITECTURE.md](./ARCHITECTURE.md#regenerating-the-client)).

Keep the set **curated** — exposing all ~70 endpoints would bloat the model's
tool context and hurt tool-selection accuracy.
