import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  BASE,
  PantristApiError,
  client,
  currentUser,
  request,
  resolveListId,
  tokenFingerprint,
  unwrap,
} from './api.js';
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
  /** A URL in Pantrist's own file store, see `storeRecipeImage`. */
  imageUrl?: string | null;
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

/** One recipe's reservations across the pantry, as `list_recipe_reservations` shows them. */
export interface RecipeReservations {
  recipeId: string;
  /** Set for a recipe known only by name; else look it up with `get_recipe`. */
  recipeName?: string;
  items: {
    itemId: string;
    name: string;
    unitId: string;
    stock: number;
    contentVolume: number;
    amountSaved?: number;
    contentSaved?: number;
  }[];
}

/** Group the pantry's `savedForRecipe` entries by recipe. */
export function groupReservations(items: ArticleDto[]): RecipeReservations[] {
  const byRecipe = new Map<string, RecipeReservations>();
  for (const item of items) {
    for (const saved of item.pantrySettings?.savedForRecipe ?? []) {
      const group = byRecipe.get(saved.recipeUuid) ?? {
        recipeId: saved.recipeUuid,
        items: [],
      };
      if (saved.recipeName) group.recipeName = saved.recipeName;
      group.items.push({
        itemId: item.uuid,
        name: item.name,
        unitId: item.unitId,
        stock: item.amount,
        contentVolume: item.contentVolume,
        ...(saved.amountSaved ? { amountSaved: saved.amountSaved } : {}),
        ...(saved.contentSaved ? { contentSaved: saved.contentSaved } : {}),
      });
      byRecipe.set(saved.recipeUuid, group);
    }
  }
  return [...byRecipe.values()];
}

/**
 * The id a recipe known only by name is reserved under: the one it already
 * has in this pantry, so a second call adds to the same reservation, or a
 * fresh one.
 */
export function recipeIdForName(items: ArticleDto[], recipeName: string): string {
  const wanted = recipeName.trim().toLocaleLowerCase();
  const existing = groupReservations(items).find(
    (group) => group.recipeName?.trim().toLocaleLowerCase() === wanted,
  );
  return existing?.recipeId ?? randomUUID();
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

/** Where a recipe image comes from: a URL to copy, or the bytes themselves. */
export type RecipeImageSource =
  | { url: string }
  | { base64: string; mimeType: string };

/**
 * Whether `url` already points into Pantrist's own file store, e.g. the
 * `imageUrl` of another recipe. Copying it again would only fetch our own
 * file back.
 */
export function isPantristFileUrl(url: string): boolean {
  return url.startsWith(`${BASE}/files?`) || url.startsWith('https://api.pantrist.app/files?');
}

/**
 * Store a recipe image in Pantrist's file store and return the URL to put
 * into `imageUrl`. The API fetches a URL itself, behind its SSRF guard, and
 * re-encodes the image like an upload from the app, so the recipe never
 * hotlinks someone else's CDN. A failed image is a warning, never a reason
 * to lose the recipe: callers save without it and pass the warning on.
 */
async function storeRecipeImage(
  recipeUuid: string,
  source: RecipeImageSource,
): Promise<{ imageUrl: string } | { warning: string }> {
  if ('url' in source && isPantristFileUrl(source.url)) {
    return { imageUrl: source.url };
  }
  try {
    const { imageUrl } = await request<{ key: string; imageUrl: string }>(
      'POST',
      `/files/recipe-image?recipeUuid=${encodeURIComponent(recipeUuid)}`,
      source,
    );
    return { imageUrl };
  } catch (error) {
    return { warning: imageWarning(error) };
  }
}

/** `image_fetch_failed: <reason>`, the reason as specific as the API told it. */
function imageWarning(error: unknown): string {
  if (error instanceof PantristApiError) {
    const message = error.apiMessage;
    return message.startsWith('image_fetch_failed')
      ? message
      : `image_fetch_failed: http_${error.status} ${message}`;
  }
  return `image_fetch_failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Save a new recipe, then its image, then its collections. The image needs
 * the saved recipe (the API only stores images for recipes the caller
 * owns), so it costs a second save that sets `imageUrl`.
 */
async function saveNewRecipe(
  body: RecipeDto,
  image: RecipeImageSource | undefined,
  collectionIds: string[] | undefined,
): Promise<{ recipe: RecipeDto; warnings: string[] }> {
  const warnings: string[] = [];
  let recipe = unwrap(await client().POST('/recipe', { body }));
  if (image) {
    const stored = await storeRecipeImage(recipe.uuid, image);
    if ('warning' in stored) {
      warnings.push(stored.warning);
    } else {
      recipe = unwrap(
        await client().PUT('/recipe', {
          body: applyRecipeChanges(recipe, { imageUrl: stored.imageUrl }, recipe.authorUuid),
        }),
      );
    }
  }
  if (collectionIds?.length) {
    await setRecipeCollections(recipe.uuid, collectionIds);
  }
  return { recipe, warnings };
}

/** The recipe image `create_recipe` / `update_recipe` were given, if any. */
function imageSourceOf(args: {
  imageUrl?: string | null;
  imageBase64?: string;
  mimeType?: string;
}): RecipeImageSource | undefined {
  if (args.imageUrl && args.imageBase64) {
    throw new Error('Pass either imageUrl or imageBase64, not both.');
  }
  if (args.imageBase64) {
    if (!args.mimeType) throw new Error('imageBase64 needs mimeType.');
    return { base64: args.imageBase64, mimeType: args.mimeType };
  }
  return args.imageUrl ? { url: args.imageUrl } : undefined;
}

const recipeImageArgs = {
  imageUrl: z
    .string()
    .url()
    .nullable()
    .optional()
    .describe(
      'Cover image as an http(s) URL. The server copies it into Pantrist\'s own storage (no hotlinking), scaled like an upload from the app. Max 10 MB, must be an image. On update pass null to remove the image. A failed image never blocks the recipe: it is saved without it and the answer carries `warnings: ["image_fetch_failed: <reason>"]`.',
    ),
  imageBase64: z
    .string()
    .max(2_800_000)
    .optional()
    .describe('Cover image as base64 instead of `imageUrl`, max ~2 MB decoded. Needs `mimeType`.'),
  mimeType: z
    .enum(['image/jpeg', 'image/png', 'image/webp'])
    .optional()
    .describe('MIME type of `imageBase64`.'),
};

/** A recipe as the parse returns it: a `RecipeDto` without uuid, plus the cover image. */
type ParsedRecipe = Omit<RecipeDto, 'uuid'> & {
  uuid?: string;
  imageBase64?: string;
  imageMimeType?: string;
};

/** Where the parse took its content from, as `POST /parse-recipe/collection` reports it. */
export interface ParseSources {
  caption?: string;
  /** Absent only on a cached parse from before the API reported it. */
  usedCaption?: boolean;
  usedNarration?: boolean;
  transcript?: string;
  usedImages: boolean;
  imageTexts?: string[];
}

interface ParseCollectionResult {
  recipes: ParsedRecipe[];
  sourceCount: number;
  skippedCount: number;
  sources?: ParseSources;
}

/** What the import tools report: drafts or saved recipes, the raw sources, warnings. */
interface ImportResult {
  recipes: unknown[];
  sources?: ParseSources;
  warnings: string[];
}

/**
 * Parse results kept for the save that follows a dry run, so reviewing a
 * draft first does not cost a second AI use, a second slot of the parse
 * route's rate limit, and another 10–60 s. Per token, in this process only:
 * with several replicas a save that lands elsewhere simply parses again.
 */
const PARSE_CACHE_TTL_MS = 30 * 60_000;
const PARSE_CACHE_MAX_ENTRIES = 100;
const parseCache = new Map<string, { result: ParseCollectionResult; expires: number }>();

/** Test helper: forget every cached parse. */
export function clearParseCache(): void {
  parseCache.clear();
}

/**
 * Parse a post or page with the same route the app's import uses. Errors
 * come back as one of the codes the import tools document, so a batch can
 * tell "skip this one" from "wait and retry".
 */
async function parseForImport(
  body: Record<string, unknown>,
  { dryRun }: { dryRun: boolean },
): Promise<ParseCollectionResult> {
  const key = `${tokenFingerprint()} ${JSON.stringify(body)}`;
  const cached = parseCache.get(key);
  if (cached && cached.expires > Date.now()) {
    // A save consumes the draft it was reviewed from; a later import of the
    // same source parses afresh.
    if (!dryRun) parseCache.delete(key);
    return cached.result;
  }
  let result: ParseCollectionResult;
  try {
    result = await request<ParseCollectionResult>('POST', '/parse-recipe/collection', {
      ...body,
      includeSources: true,
    });
  } catch (error) {
    throw importError(error);
  }
  if (dryRun) {
    for (const [k, entry] of parseCache) {
      if (entry.expires <= Date.now()) parseCache.delete(k);
    }
    if (parseCache.size >= PARSE_CACHE_MAX_ENTRIES) {
      parseCache.delete(parseCache.keys().next().value!);
    }
    parseCache.set(key, { result, expires: Date.now() + PARSE_CACHE_TTL_MS });
  }
  return result;
}

/** Map an API error of the parse route onto the import tools' error codes. */
export function importError(error: unknown): Error {
  if (!(error instanceof PantristApiError)) return error as Error;
  const message = error.apiMessage;
  let code: string;
  if (error.status === 429) code = 'rate_limited';
  else if (error.code === 'AI_QUOTA_EXHAUSTED') code = 'ai_quota_exhausted';
  else if (error.code === 'AI_ACCOUNT_REQUIRED') code = 'account_required';
  else if (message.startsWith('image_fetch_failed')) code = 'fetch_failed';
  else if (error.status === 400 || error.status === 422) code = 'unsupported_url';
  else code = 'fetch_failed';
  const retry = error.retryAfter !== undefined ? ` retryAfter=${error.retryAfter}s` : '';
  return new Error(`${code}:${retry} ${message} (HTTP ${error.status})`);
}

/**
 * The drafts of a dry run: what would be saved, without the image bytes,
 * which would flood the model's context. `hasImage` says whether a cover
 * image would come along.
 */
export function toDraft({ imageBase64, imageMimeType: _m, ...recipe }: ParsedRecipe) {
  return { ...recipe, hasImage: Boolean(imageBase64) };
}

/**
 * The fields a new recipe takes from a parse. The parse is a model's reading
 * of someone else's post, so anything beyond the recipe's content (an
 * `imageUrl` to hotlink, `copiedFromReceiptUuid`, `createdAt`, visibility)
 * is never taken from it: the image goes through `storeRecipeImage`, the
 * rest comes from the caller.
 */
const PARSED_CONTENT_FIELDS = [
  'name', 'description', 'totalTime', 'cookingTime', 'waitingTime',
  'preparationTime', 'defaultServings', 'servingsUnit', 'categories',
  'allergens', 'ingredients', 'steps', 'partialSteps', 'nutriments',
] as const;

/**
 * Turn a parsed recipe into the body of a new save: its content, a fresh
 * uuid, the signed-in user as author, the caller's language and visibility,
 * and the link of the post it came from.
 */
export function parsedToNewRecipe(
  parsed: ParsedRecipe,
  options: { authorUuid: string; language: string; shouldBePublic: boolean; link?: string },
): RecipeDto {
  const content: Record<string, unknown> = {};
  for (const key of PARSED_CONTENT_FIELDS) {
    if (parsed[key] !== undefined) content[key] = parsed[key];
  }
  const draft = {
    ...content,
    uuid: randomUUID(),
    authorUuid: options.authorUuid,
    language: options.language,
    shouldBePublic: options.shouldBePublic,
    showAuthor: true,
    link: options.link,
    ingredients: parsed.ingredients ?? [],
    steps: parsed.steps ?? [],
    categories: parsed.categories ?? [],
  } as unknown as RecipeDto;
  const body = applyRecipeChanges(draft, {}, options.authorUuid);
  // The save derives origin, platform and originalUrl from `link`; the
  // author handle only the parse saw, so that one field goes along.
  const channelName = parsed.source?.channelName;
  if (channelName) {
    body.source = { channelName } as RecipeDto['source'];
  }
  return body;
}

/**
 * Save every recipe of a parse. Each one gets its own image and its own
 * warnings; one failing recipe does not stop the others, so a post with
 * five recipes keeps the four that saved.
 */
async function saveParsedRecipes(
  parsed: ParsedRecipe[],
  options: {
    language: string;
    shouldBePublic: boolean;
    link?: string;
    collectionIds?: string[];
    /** Overrides the image the parse picked, e.g. a chosen carousel slide. */
    image?: RecipeImageSource;
  },
): Promise<{ recipes: RecipeDto[]; warnings: string[] }> {
  const user = await currentUser();
  if (!user) throw new Error('No Pantrist account is linked to this connection.');
  const recipes: RecipeDto[] = [];
  const warnings: string[] = [];
  for (const [index, item] of parsed.entries()) {
    const image =
      options.image ??
      (item.imageBase64
        ? { base64: item.imageBase64, mimeType: item.imageMimeType ?? 'image/jpeg' }
        : undefined);
    try {
      const saved = await saveNewRecipe(
        parsedToNewRecipe(item, { ...options, authorUuid: user.uid }),
        image,
        options.collectionIds,
      );
      recipes.push(saved.recipe);
      warnings.push(...saved.warnings.map((w) => `recipe ${index} (${item.name}): ${w}`));
    } catch (error) {
      warnings.push(
        `save_failed: recipe ${index} (${item.name}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { recipes, warnings };
}

/** The import tools' shared ending: drafts on a dry run, else save and report. */
async function finishImport(
  result: ParseCollectionResult,
  options: {
    dryRun: boolean;
    language: string;
    shouldBePublic: boolean;
    link?: string;
    collectionIds?: string[];
    image?: RecipeImageSource;
  },
): Promise<ImportResult> {
  const warnings: string[] = [];
  if (result.skippedCount > 0) {
    warnings.push(
      `skipped: ${result.skippedCount} of ${result.sourceCount} recipe candidates exceed the per-import cap and were not parsed`,
    );
  }
  if (result.recipes.length === 0) {
    // Not thrown: the raw sources are what tells the caller why.
    return {
      recipes: [],
      sources: result.sources,
      warnings: [...warnings, 'no_recipe_found: the source holds no recipe the parser could read'],
    };
  }
  if (options.dryRun) {
    return { recipes: result.recipes.map(toDraft), sources: result.sources, warnings };
  }
  const saved = await saveParsedRecipes(result.recipes, options);
  return {
    recipes: saved.recipes,
    sources: result.sources,
    warnings: [...warnings, ...saved.warnings],
  };
}

const importLanguage = z
  .enum(RECIPE_LANGUAGES)
  .optional()
  .describe('Language the recipe is translated into and saved as. Defaults to "de-DE".');

const importRateLimit =
  'Cost and limits: every parse is one AI use — unlimited with Pantrist Premium, otherwise a few per month (check `get_ai_quota` before a batch); `ai_quota_exhausted` means none are left this month. A save right after a dry run of the same arguments reuses that parse (for 30 minutes) and costs nothing extra. The parse route allows 10 calls per minute (counted per connection IP, shared by everyone on this MCP server): pace a batch to about one call every 7 seconds and wait `retryAfter` seconds on `rate_limited`.';

/** Your own recipes per normalized link, from `POST /recipe/by-links`. */
async function recipesByLinks(links: string[]): Promise<Record<string, string[]>> {
  const { matches } = await request<{ matches: Record<string, string[]> }>(
    'POST',
    '/recipe/by-links',
    { links },
  );
  return matches;
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

  server.tool(
    'get_ai_quota',
    'Show how many AI features the user may still start this month. Read-only. Recipe imports (`import_recipe_from_url`, `import_recipe_from_images`) cost one use each. Returns `{ unlimited, limit, used, remaining }`: `unlimited: true` with Pantrist Premium (then `remaining` is 0 and means nothing), otherwise `remaining` of the monthly `limit`. Check it before a batch import.',
    {},
    async () => text(await request('GET', '/ai-quota')),
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
    'List all items currently stocked in the pantry for `listId`. Read-only. Returns an array of `ArticleDto` objects (`uuid`, `name`, `amount` = current stock, `unitId`, `pantrySettings.earliestBestBefore` for expiry tracking, `minimumAmount` (in packages, or in content of `unitId` when `minimumAmountMode` is `content`, e.g. 3 rolls out of packs of 8 with `contentVolume` 8), `pantrySettings.savedForRecipe` = stock already reserved for recipes (see `list_recipe_reservations`), …); empty array if the pantry is empty. For shopping items use `list_shopping_items`; for stock changes on an existing item use `reduce_pantry_amount`; for metadata changes use `update_pantry_item`.',
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

  // --- recipe reservations -------------------------------------------------
  server.tool(
    'reserve_pantry_for_recipe',
    'Set pantry stock aside for a recipe that is going to be cooked, so it is not planned twice. Nothing leaves the stock yet: once the recipe is cooked call `cook_recipe`, if it will not be cooked call `release_recipe_reservation`. Works for a Pantrist recipe (`recipeId`) and for one that only exists elsewhere, a website or a cookbook (`recipeName`); the app shows both under "reserved". Reserving an item again for the same recipe replaces its earlier amount. Check `list_pantry_items` (stock, `contentVolume`, existing `pantrySettings.savedForRecipe`) first so you only reserve what is there and not already reserved. Returns the `recipeId` to cook or release it with, and the reserved items.',
    {
      recipeId: z
        .string()
        .optional()
        .describe(
          'Pantrist recipe uuid (from `search_recipes` or `get_recipe`), or the `recipeId` of an earlier reservation (`list_recipe_reservations`). Pass this or `recipeName`.',
        ),
      recipeName: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Name of a recipe that is not in Pantrist, e.g. "Gulasch von Chefkoch". Reservations under the same name in this pantry are added to; otherwise a new `recipeId` is made up. Pass this or `recipeId`.',
        ),
      items: z
        .array(
          z
            .object({
              itemId: z
                .string()
                .describe('Pantry item uuid (from `list_pantry_items[].uuid`).'),
              packages: z
                .number()
                .positive()
                .optional()
                .describe(
                  'Whole packages to set aside, for items used whole (2 cans of tomatoes).',
                ),
              content: z
                .number()
                .positive()
                .optional()
                .describe(
                  "Content to set aside in the item's own `unitId`, for part of a package (200 g out of a 500 g pack). Convert the recipe's unit first.",
                ),
            })
            .refine((item) => item.packages || item.content, {
              message: 'Give `packages` or `content`.',
            }),
        )
        .min(1)
        .describe('Pantry items to reserve and how much of each.'),
      ...listIdArg,
    },
    async ({ recipeId, recipeName, items, listId }) => {
      if (!recipeId === !recipeName) {
        throw new Error('Pass either `recipeId` or `recipeName`.');
      }
      const resolvedListId = resolveListId(listId);
      const id =
        recipeId ??
        recipeIdForName(
          unwrap(
            await client().GET('/list/{listId}/pantryList', {
              params: { path: { listId: resolvedListId } },
            }),
          ),
          recipeName as string,
        );
      const reserved = [];
      for (const { itemId, packages, content } of items) {
        const article = unwrap(
          await client().PUT(
            '/list/{listId}/pantryList/{itemId}/reservations/{recipeUuid}',
            {
              params: {
                path: { listId: resolvedListId, itemId, recipeUuid: id },
              },
              body: {
                ...(recipeName ? { recipeName } : {}),
                ...(packages ? { amountSaved: packages } : {}),
                ...(content ? { contentSaved: content } : {}),
              },
            },
          ),
        );
        reserved.push({
          itemId,
          name: article.name,
          ...(packages ? { packages } : {}),
          ...(content ? { content, unitId: article.unitId } : {}),
        });
      }
      return text({
        recipeId: id,
        ...(recipeName ? { recipeName } : {}),
        reserved,
      });
    },
  );

  server.tool(
    'list_recipe_reservations',
    'List what pantry stock is set aside for which recipe. Read-only. Returns `[{ recipeId, recipeName?, items: [{ itemId, name, unitId, stock, contentVolume, amountSaved?, contentSaved? }] }]`, empty when nothing is reserved. `recipeName` is set for recipes known only by name; for Pantrist recipes look the name up with `get_recipe`. `amountSaved` counts packages, `contentSaved` content in `unitId`. Use the `recipeId` with `cook_recipe` or `release_recipe_reservation`.',
    { ...listIdArg },
    async ({ listId }) =>
      text(
        groupReservations(
          unwrap(
            await client().GET('/list/{listId}/pantryList', {
              params: { path: { listId: resolveListId(listId) } },
            }),
          ),
        ),
      ),
  );

  server.tool(
    'cook_recipe',
    'Book a cooked recipe out of the pantry: every item reserved for it loses what was reserved, the way the app does it (open packages first, then whole ones; a remainder leaves a package open), and the reservations are removed. Only for stock reserved with `reserve_pantry_for_recipe`; for anything else use `reduce_pantry_amount`. Returns `{ items, unbooked }`: the items as they stand afterwards, and reserved content the stock could no longer cover (worth mentioning to the user). Fails with 404 when nothing is reserved for the recipe.',
    {
      recipeId: z
        .string()
        .describe('`recipeId` from `reserve_pantry_for_recipe` or `list_recipe_reservations`.'),
      autoRestock: z
        .boolean()
        .optional()
        .describe(
          'If true, every item that ends at or below its minimum is also added to the shopping list, as with `reduce_pantry_amount`. Defaults to false.',
        ),
      ...listIdArg,
    },
    async ({ recipeId, autoRestock, listId }) => {
      const result = unwrap(
        await client().POST(
          '/list/{listId}/pantryList/reservations/{recipeUuid}/cooked',
          {
            params: {
              path: { listId: resolveListId(listId), recipeUuid: recipeId },
            },
            body: { autoRestock: autoRestock ?? false },
          },
        ),
      );
      return text({
        items: result.items.map((item) => ({
          itemId: item.uuid,
          name: item.name,
          stock: item.amount,
          unitId: item.unitId,
          contentVolume: item.contentVolume,
        })),
        unbooked: result.unbooked,
      });
    },
  );

  server.tool(
    'release_recipe_reservation',
    'Drop the reservations of a recipe that will not be cooked after all, from every item or only from `itemId`. The stock is left as it is; to book a cooked recipe out use `cook_recipe`. Returns the names of the items that were released.',
    {
      recipeId: z
        .string()
        .describe('`recipeId` from `reserve_pantry_for_recipe` or `list_recipe_reservations`.'),
      itemId: z
        .string()
        .optional()
        .describe('Release only this pantry item. Omit to release the whole recipe.'),
      ...listIdArg,
    },
    async ({ recipeId, itemId, listId }) => {
      const resolvedListId = resolveListId(listId);
      const released = itemId
        ? unwrap(
            await client().DELETE(
              '/list/{listId}/pantryList/{itemId}/reservations/{recipeUuid}',
              {
                params: {
                  path: { listId: resolvedListId, itemId, recipeUuid: recipeId },
                },
              },
            ),
          )
        : unwrap(
            await client().DELETE(
              '/list/{listId}/pantryList/reservations/{recipeUuid}',
              {
                params: {
                  path: { listId: resolvedListId, recipeUuid: recipeId },
                },
              },
            ),
          );
      return text({ released: released.map((item) => item.name) });
    },
  );

  // --- recipes -------------------------------------------------------------
  server.tool(
    'search_recipes',
    'Search recipes by free-text and optional category filters. By default this covers the user\'s own recipes, recipes shared through their lists AND public recipes of other users; pass `ownOnly: true` to see only recipes the user authored — use that before creating one, to tell whether it is already theirs. Read-only and paginated — returns an array of up to 10 `RecipeDto`s per page; a page with fewer than 10 is the last one. To check many source links for duplicates at once use `find_recipes_by_link`; to fetch a single recipe by uuid use `get_recipe`.',
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
      ownOnly: z
        .boolean()
        .optional()
        .describe('Only recipes the signed-in user authored. Defaults to false.'),
      currentPage: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          '1-based page index; 10 recipes per page. Defaults to 1.',
        ),
    },
    async ({ searchString, categories, ownOnly, currentPage }) => {
      let authorUuid: string | undefined;
      if (ownOnly) {
        const user = await currentUser();
        if (!user) throw new Error('No Pantrist account is linked to this connection.');
        authorUuid = user.uid;
      }
      return text(
        unwrap(
          // The legacy `/recipe/filter` answers a growing window (page N
          // returns rows 1..N*10); this one returns page N alone.
          await client().POST('/recipe/filter/paginated', {
            body: { searchString, categories, currentPage, authorUuid },
          }),
        ),
      );
    },
  );

  server.tool(
    'find_recipes_by_link',
    'Check which source links are already among the user\'s OWN recipes, for de-duplicating an import before it runs. Matches a recipe\'s `link` and its `source.originalUrl`, both normalized: tracking parameters (`igsh`, `utm_*`, `si`, …), `www.`, the fragment and a trailing slash are ignored. Read-only, one API call for up to 500 links. Returns `{ [url]: recipeUuid[] }` keyed by each url exactly as passed; `[]` means not imported yet.',
    {
      urls: z
        .array(z.string().min(1).max(2000))
        .min(1)
        .max(500)
        .describe('Post or recipe URLs to look up, up to 500 per call.'),
    },
    async ({ urls }) => text(await recipesByLinks(urls)),
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
    'Create a new recipe owned by the signed-in user and optionally file it into recipe collections. Always creates a new recipe, even when one with the same name exists — call `search_recipes` with `ownOnly: true` (or `find_recipes_by_link` for an imported post) first if the recipe might already be there, and change an existing one with `update_recipe` instead. To import a post or web page, prefer `import_recipe_from_url`, which records the author and platform. Ingredient names are resolved against the shared ingredient catalog (for matching with the pantry); this creates no articles in the shopping or pantry catalog. Recipes belong to the user, not to a list, so there is no `listId`. Returns the saved `RecipeDto`, the same shape as `get_recipe`; its `uuid` is the `recipeId` for follow-up calls. When the image could not be stored, the answer also carries `warnings`.',
    {
      ...recipeFieldArgs,
      ...recipeImageArgs,
      name: recipeName,
      ingredients: recipeIngredients,
      steps: recipeSteps,
    },
    async ({ collectionIds, imageUrl, imageBase64, mimeType, ...changes }) => {
      const image = imageSourceOf({ imageUrl, imageBase64, mimeType });
      if (collectionIds) await assertCollectionsExist(collectionIds);
      const user = await currentUser();
      if (!user) throw new Error('No Pantrist account is linked to this connection.');
      const { recipe, warnings } = await saveNewRecipe(
        applyRecipeChanges(undefined, changes, user.uid),
        image,
        collectionIds,
      );
      return text(warnings.length ? { ...recipe, warnings } : recipe);
    },
  );

  server.tool(
    'update_recipe',
    'Change a recipe the user owns. Only the fields you pass change; everything else (image, allergens, nutriments, partial steps) round-trips unchanged. `ingredients`, `steps` and `categories` are replaced as a whole, never merged: to fix one ingredient, pass the full list from `get_recipe` with that entry changed. `collectionIds` replaces the recipe\'s collections; to add or remove a single one use `add_recipe_to_collection` / `remove_recipe_from_collection`. `imageUrl` / `imageBase64` replace the cover image, `imageUrl: null` removes it. Recipes of other users, also ones shared through a list, are rejected with a 400 "You\'re not allowed to change the recipe". Two or more API calls per invocation. Returns the saved `RecipeDto`, plus `warnings` when the new image could not be stored (the other changes are saved anyway). To read use `get_recipe`, to delete `delete_recipe`.',
    {
      recipeId: z
        .string()
        .describe('Recipe uuid (from `search_recipes`, `get_recipe` or `create_recipe`).'),
      ...recipeFieldArgs,
      ...recipeImageArgs,
    },
    async ({ recipeId, collectionIds, imageUrl, imageBase64, mimeType, ...changes }) => {
      const image = imageSourceOf({ imageUrl, imageBase64, mimeType });
      if (collectionIds) await assertCollectionsExist(collectionIds);
      // PUT /recipe replaces the whole recipe; fetch it so omitted fields
      // round-trip unchanged.
      const current = unwrap(
        await client().GET('/recipe/{uid}', {
          params: { path: { uid: recipeId } },
        }),
      );
      const warnings: string[] = [];
      let newImageUrl: string | null | undefined = imageUrl === null ? null : undefined;
      if (image) {
        const stored = await storeRecipeImage(recipeId, image);
        if ('warning' in stored) warnings.push(stored.warning);
        else newImageUrl = stored.imageUrl;
      }
      const recipe = unwrap(
        await client().PUT('/recipe', {
          body: applyRecipeChanges(
            current,
            { ...changes, imageUrl: newImageUrl },
            current.authorUuid,
          ),
        }),
      );
      if (collectionIds) await setRecipeCollections(recipeId, collectionIds);
      return text(warnings.length ? { ...recipe, warnings } : recipe);
    },
  );

  server.tool(
    'import_recipe_from_url',
    `Import the recipe(s) of a web page or a TikTok, Instagram or YouTube post the same way the Pantrist app does (origin \`web_import\` / \`social_import\`, author and platform recorded from the post). The server reads the page or post: caption, video narration and the post's images. One post can hold several recipes ("5 buckwheat recipes"), so \`recipes\` is an array. Use \`dryRun: true\` first to review drafts against \`sources\` (raw caption, and transcript / image texts when available) for anything missing or invented, then call again with the same arguments and \`dryRun: false\` to save the reviewed draft(s). Saving stores each recipe with its cover image and files it into \`collectionIds\`. Check \`find_recipes_by_link\` beforehand to skip posts already imported. For a carousel whose recipe sits only on the slides, this already reads the slides; use \`import_recipe_from_images\` when you only have the image URLs. Returns \`{ recipes, sources, warnings }\`: drafts without uuid on a dry run, saved \`RecipeDto\`s otherwise. A source with no recipe returns \`recipes: []\` and a \`no_recipe_found\` warning. Errors start with a code: \`unsupported_url\`, \`fetch_failed\`, \`rate_limited\` (with \`retryAfter\`), \`ai_quota_exhausted\`, \`account_required\`. Takes 10–60 s per call. ${importRateLimit}`,
    {
      url: z.string().url().describe('Recipe page, TikTok, Instagram or YouTube URL.'),
      dryRun: z
        .boolean()
        .optional()
        .describe('true: save nothing, only return the draft(s). Defaults to false.'),
      collectionIds: recipeFieldArgs.collectionIds,
      language: importLanguage,
      shouldBePublic: recipeFieldArgs.shouldBePublic,
    },
    async ({ url, dryRun = false, collectionIds, language = 'de-DE', shouldBePublic = false }) => {
      if (!dryRun && collectionIds) await assertCollectionsExist(collectionIds);
      const result = await parseForImport({ url, targetLanguage: language }, { dryRun });
      return text(
        await finishImport(result, { dryRun, language, shouldBePublic, link: url, collectionIds }),
      );
    },
  );

  server.tool(
    'import_recipe_from_images',
    `Import the recipe(s) shown on images, e.g. the slides of a carousel post whose recipe only appears on the pictures, or photos of a cookbook page. The server fetches the images itself (http(s) only, max 10 MB each), reads them in order, and groups them by recipe: pages of one recipe become one result, distinct recipes distinct results. Up to 10 images per call. \`caption\` adds the post's text as context. Same flow as \`import_recipe_from_url\`: \`dryRun: true\` returns drafts and \`sources\` (with the text read from each image when available), \`dryRun: false\` saves them, each with the image at \`coverImageIndex\` as cover and \`link\` as its source link. Returns \`{ recipes, sources, warnings }\`; errors start with \`fetch_failed\` (an image could not be loaded), \`rate_limited\` (with \`retryAfter\`), \`ai_quota_exhausted\` or \`account_required\`. An image that cannot be loaded, or a URL without readable content, gives the AI use back. ${importRateLimit}`,
    {
      imageUrls: z
        .array(z.string().url())
        .min(1)
        .max(10)
        .describe('1–10 image URLs in slide order.'),
      caption: z
        .string()
        .max(10_000)
        .optional()
        .describe('The post\'s text, read together with the images.'),
      link: z
        .string()
        .url()
        .optional()
        .describe('URL of the original post, saved as the recipe\'s link (and so found by `find_recipes_by_link`).'),
      dryRun: z
        .boolean()
        .optional()
        .describe('true: save nothing, only return the draft(s). Defaults to false.'),
      collectionIds: recipeFieldArgs.collectionIds,
      language: importLanguage,
      shouldBePublic: recipeFieldArgs.shouldBePublic,
      coverImageIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Index into `imageUrls` of the cover image. Defaults to 0. With several recipes, all of them get this cover.'),
    },
    async ({
      imageUrls,
      caption,
      link,
      dryRun = false,
      collectionIds,
      language = 'de-DE',
      shouldBePublic = false,
      coverImageIndex = 0,
    }) => {
      if (coverImageIndex >= imageUrls.length) {
        throw new Error(`coverImageIndex ${coverImageIndex} is out of range for ${imageUrls.length} image(s).`);
      }
      if (!dryRun && collectionIds) await assertCollectionsExist(collectionIds);
      const result = await parseForImport(
        { imageUrls, caption, targetLanguage: language },
        { dryRun },
      );
      return text(
        await finishImport(result, {
          dryRun,
          language,
          shouldBePublic,
          link,
          collectionIds,
          image: { url: imageUrls[coverImageIndex] },
        }),
      );
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
    'list_recipes_in_collection',
    'List the recipes in one recipe collection. Read-only and paginated. Returns an array of up to 10 `{ uuid, name, link, originalUrl }` per page (a page with fewer than 10 is the last) — just enough to compare a collection against another source; read a recipe in full with `get_recipe`.',
    {
      collectionId: z.string().describe('Collection uuid from `list_recipe_collections`.'),
      currentPage: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based page index; 10 recipes per page. Defaults to 1.'),
    },
    async ({ collectionId, currentPage }) => {
      const page = unwrap(
        await client().POST('/recipe/filter/paginated', {
          body: { collectionId, currentPage },
        }),
      );
      return text(
        page.map((recipe) => ({
          uuid: recipe.uuid,
          name: recipe.name,
          link: recipe.link ?? null,
          originalUrl: recipe.source?.originalUrl ?? null,
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
