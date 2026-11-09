/**
 * Name normalization and similarity across naming conventions.
 *
 * The wedge (design v3 §1) has to join `posts.scheduled_at` to `Post.scheduledAt`
 * to `#/components/schemas/Post/properties/scheduled-at` with zero declarations.
 * Every one of those is the same name written in a different convention, so the
 * first thing the matcher needs is a canonical token sequence that is invariant
 * under snake / camel / pascal / kebab / dotted spelling, common abbreviations,
 * and pluralization.
 *
 * Two normalization levels are kept, deliberately:
 *
 *   literalKey   - convention-invariant only. `scheduled_at`, `scheduledAt`,
 *                  `ScheduledAt`, `scheduled-at` all collapse to `scheduled_at`.
 *                  Equality here is a *certain* name match.
 *   canonicalKey - additionally expands abbreviations and singularizes.
 *                  `msgs` becomes `message`, `posts` becomes `post`. Equality
 *                  here is a *near-certain* match, scored slightly below
 *                  literal because the expansion tables are heuristics.
 *
 * Nothing here reads the clock, the filesystem, or a locale (`localeCompare` is
 * deliberately never used) - v3 §2.3 makes byte-identical output a CI gate.
 */

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Split an identifier into lowercase tokens across every convention this
 * project sees: `snake_case`, `kebab-case`, `dotted.path`, `camelCase`,
 * `PascalCase`, `SCREAMING_SNAKE`, and acronym runs (`HTTPServer` gives
 * http, server). Digit runs are split off (`sha256Hash` gives sha, 256, hash)
 * so that the snake and camel spellings of the same name agree.
 */
export function splitTokens(name: string): ReadonlyArray<string> {
  const out: string[] = [];
  for (const chunk of name.split(/[^A-Za-z0-9]+/u)) {
    if (chunk.length === 0) continue;
    const spaced = chunk
      .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
      .replace(/([A-Za-z])([0-9])/gu, '$1 $2')
      .replace(/([0-9])([A-Za-z])/gu, '$1 $2');
    for (const token of spaced.split(' ')) {
      if (token.length > 0) out.push(token.toLowerCase());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Abbreviations and pluralization
// ---------------------------------------------------------------------------

/**
 * Abbreviation to canonical long form. Curated, not generated: every entry is a
 * form observed in column/field/property names. An over-broad table is worse
 * than a small one, because a wrong expansion manufactures a wrong join, and a
 * silent wrong join is the failure mode this component exists to avoid.
 *
 * `auth` is deliberately absent: `authentication` and `authorization` are
 * different things and collapsing them would join a session column to a
 * permission field.
 */
export const ABBREVIATIONS: Readonly<Record<string, string>> = Object.freeze({
  addr: 'address',
  amt: 'amount',
  attr: 'attribute',
  avg: 'average',
  cfg: 'config',
  configuration: 'config',
  cnt: 'count',
  cust: 'customer',
  db: 'database',
  dept: 'department',
  desc: 'description',
  dest: 'destination',
  dir: 'directory',
  doc: 'document',
  err: 'error',
  ext: 'extension',
  identifier: 'id',
  img: 'image',
  info: 'information',
  lang: 'language',
  loc: 'location',
  mgr: 'manager',
  msg: 'message',
  nbr: 'number',
  num: 'number',
  org: 'organization',
  organisation: 'organization',
  passwd: 'password',
  pct: 'percent',
  percentage: 'percent',
  phone: 'telephone',
  pos: 'position',
  prev: 'previous',
  prio: 'priority',
  pwd: 'password',
  qty: 'quantity',
  ref: 'reference',
  repo: 'repository',
  req: 'request',
  res: 'response',
  src: 'source',
  svc: 'service',
  tel: 'telephone',
  ts: 'timestamp',
  txn: 'transaction',
  uri: 'url',
  usr: 'user',
  val: 'value',
  ver: 'version',
});

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = Object.freeze({
  children: 'child',
  criteria: 'criterion',
  feet: 'foot',
  geese: 'goose',
  indexes: 'index',
  indices: 'index',
  matrices: 'matrix',
  men: 'man',
  mice: 'mouse',
  people: 'person',
  phenomena: 'phenomenon',
  teeth: 'tooth',
  vertices: 'vertex',
  women: 'woman',
});

/** Tokens that end in `s` but are not plurals. Stripping these breaks matching. */
const NEVER_SINGULAR: ReadonlySet<string> = new Set([
  'abs', 'access', 'address', 'alias', 'always', 'analysis', 'as', 'axis',
  'basis', 'bonus', 'bus', 'business', 'class', 'cls', 'cms', 'cors', 'css',
  'data', 'des', 'dns', 'gas', 'has', 'https', 'ios', 'is', 'js', 'media',
  'metadata', 'ms', 'news', 'ns', 'os', 'pass', 'plus', 'pos', 'process',
  'progress', 'res', 'series', 'species', 'status', 'success', 'this', 'tls',
  'ts', 'us', 'vs', 'was',
]);

/**
 * Own-property lookup into a plain-object dictionary.
 *
 * A bracket access (`dict[token]`) walks the prototype chain, so a token that
 * happens to spell an `Object.prototype` member name (`constructor`,
 * `toString`, `valueOf`, `hasOwnProperty`, ...) silently returns that
 * built-in function instead of `undefined` - and `constructor` is an
 * extremely common real symbol name (every class has one). `ABBREVIATIONS`
 * and `IRREGULAR_PLURALS` are plain object literals for readability, so every
 * lookup into them goes through this guard rather than a bare index.
 */
function ownLookup(dict: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/** Collapse a plural token to its singular form. Conservative by construction. */
export function singularize(token: string): string {
  const irregular = ownLookup(IRREGULAR_PLURALS, token);
  if (irregular !== undefined) return irregular;
  if (NEVER_SINGULAR.has(token)) return token;
  if (!token.endsWith('s')) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (
    token.length > 4 &&
    (token.endsWith('ses') || token.endsWith('xes') || token.endsWith('zes') ||
      token.endsWith('ches') || token.endsWith('shes'))
  ) {
    return token.slice(0, -2);
  }
  if (token.endsWith('ss') || token.endsWith('us') || token.endsWith('is')) return token;
  if (token.length > 2) return token.slice(0, -1);
  return token;
}

/** Expand a known abbreviation to its canonical long form. */
export function expandAbbrev(token: string): string {
  return ownLookup(ABBREVIATIONS, token) ?? token;
}

/**
 * Canonicalize one token: singularize, expand, singularize again. The second
 * pass exists because expansion can reintroduce a plural (`msgs` gives `msg`
 * gives `message`) and because a plural-looking abbreviation (`pos`) must not
 * be mangled by the first pass - hence `pos` living in NEVER_SINGULAR.
 */
export function canonicalToken(token: string): string {
  return singularize(expandAbbrev(singularize(token)));
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** Convention-invariant key. Equality is a certain name match. */
export function literalKey(name: string): string {
  return splitTokens(name).join('_');
}

/** Canonical tokens: convention-invariant, de-abbreviated, singularized. */
export function canonicalTokens(name: string): ReadonlyArray<string> {
  return splitTokens(name).map(canonicalToken);
}

/** Canonical key. Equality is a near-certain name match. */
export function canonicalKey(name: string): string {
  return canonicalTokens(name).join('_');
}

// ---------------------------------------------------------------------------
// Container names
// ---------------------------------------------------------------------------

/**
 * Affixes that carry no domain meaning on a container name. `PostRow`,
 * `PostEntity`, `PostDTO`, `CreatePostInput` and table `posts` all describe the
 * same thing; the core is `post`.
 */
export const CONTAINER_SUFFIXES: ReadonlySet<string> = new Set([
  'arg', 'attribute', 'base', 'body', 'column', 'config', 'dao', 'default',
  'definition', 'dto', 'entity', 'impl', 'input', 'interface', 'model',
  'output', 'param', 'payload', 'prop', 'record', 'repository', 'request',
  'response', 'result', 'row', 'schema', 'service', 'store', 'struct',
  'table', 'type', 'validator', 'view', 'vo',
]);

export const CONTAINER_PREFIXES: ReadonlySet<string> = new Set([
  'abstract', 'create', 'delete', 'insert', 'new', 'partial', 'patch',
  'public', 'put', 'update', 'upsert',
]);

/**
 * The domain core of a container name: canonical tokens with meaningless
 * affixes stripped. Never strips to empty - a container literally named `Row`
 * keeps `row`.
 */
export function containerCore(name: string): ReadonlyArray<string> {
  let tokens: ReadonlyArray<string> = canonicalTokens(name);
  while (tokens.length > 1) {
    const first = tokens[0];
    if (first !== undefined && CONTAINER_PREFIXES.has(first)) tokens = tokens.slice(1);
    else break;
  }
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && CONTAINER_SUFFIXES.has(last)) tokens = tokens.slice(0, -1);
    else break;
  }
  return tokens;
}

export function containerCoreKey(name: string): string {
  return containerCore(name).join('_');
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

/** Levenshtein distance, iterative two-row. Inputs are capped at 96 chars. */
export function levenshtein(a: string, b: string): number {
  const s = a.length > 96 ? a.slice(0, 96) : a;
  const t = b.length > 96 ? b.slice(0, 96) : b;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = new Array<number>(n + 1);
  let curr: number[] = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const ca = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = ca === t.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n] ?? 0;
}

/** Normalized edit similarity in [0,1]. */
export function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Jaccard index over token sets, in [0,1]. */
export function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let shared = 0;
  for (const token of sa) if (sb.has(token)) shared += 1;
  const union = sa.size + sb.size - shared;
  return union === 0 ? 0 : shared / union;
}

// ---------------------------------------------------------------------------
// Name match
// ---------------------------------------------------------------------------

/**
 * How a pair of names matched. Ordered from strongest to weakest; the variant
 * is recorded on every emitted edge so a wrong join can be traced to the rule
 * that produced it.
 */
export const NAME_VARIANTS = [
  'identical', 'convention', 'canonical', 'reordered', 'affix', 'fuzzy', 'none',
] as const;
export type NameVariant = (typeof NAME_VARIANTS)[number];

export interface NameMatch {
  readonly score: number;
  readonly variant: NameVariant;
}

/** Fuzzy matching never claims parity with an exact convention match. */
export const FUZZY_CEILING = 0.85;

/** Weight of token overlap vs. character edit distance inside the fuzzy score. */
export const FUZZY_TOKEN_WEIGHT = 0.5;

/**
 * Score two names in [0,1].
 *
 *   identical   1.00  byte equality
 *   convention  1.00  equal after convention normalization (the snake/camel/
 *                     pascal/kebab case - the one that must always work)
 *   canonical   0.97  equal after abbreviation and plural normalization
 *   reordered   0.88  same canonical tokens, different order
 *   fuzzy      <0.85  blended token overlap and edit similarity
 *   none        0.00  no shared tokens and low edit similarity
 */
export function matchName(a: string, b: string): NameMatch {
  if (a === b) return { score: 1, variant: 'identical' };
  if (literalKey(a) === literalKey(b)) return { score: 1, variant: 'convention' };
  const ta = canonicalTokens(a);
  const tb = canonicalTokens(b);
  const ca = ta.join('_');
  const cb = tb.join('_');
  if (ca === cb) return { score: 0.97, variant: 'canonical' };
  if (ta.length === tb.length && ta.length > 1) {
    const sa = ta.slice().sort();
    const sb = tb.slice().sort();
    if (sa.join('_') === sb.join('_')) return { score: 0.88, variant: 'reordered' };
  }
  const overlap = jaccard(ta, tb);
  const edit = editSimilarity(ca, cb);
  // A pair with no shared token needs near-spelling-equality to survive. This
  // is what keeps `title` from fuzzily matching `body` at repository scale.
  if (overlap === 0 && edit < 0.85) return { score: 0, variant: 'none' };
  const blended = FUZZY_TOKEN_WEIGHT * overlap + (1 - FUZZY_TOKEN_WEIGHT) * edit;
  const score = Math.min(FUZZY_CEILING, blended);
  return score <= 0 ? { score: 0, variant: 'none' } : { score, variant: 'fuzzy' };
}

/**
 * Container identity is a nonempty convention/plural-normalized equality.
 * Affixes and fuzzy overlap can name different value shapes and are not proof
 * that two members belong to the same domain container.
 */
export function matchContainer(a: string, b: string): number {
  const left = canonicalKey(a);
  const right = canonicalKey(b);
  return left.length > 0 && left === right ? 1 : 0;
}

/**
 * Drop a leading container prefix from a field name's tokens.
 * `posts.post_id` becomes `id`, so it can meet `Post.id`. Returns the original
 * tokens when the prefix is absent or would strip everything.
 */
export function stripContainerPrefix(
  nameTokens: ReadonlyArray<string>,
  containerTokens: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (containerTokens.length === 0 || nameTokens.length <= containerTokens.length) return nameTokens;
  for (let i = 0; i < containerTokens.length; i += 1) {
    if (nameTokens[i] !== containerTokens[i]) return nameTokens;
  }
  return nameTokens.slice(containerTokens.length);
}

/** Penalty applied to a name match that only holds after stripping a container prefix. */
export const AFFIX_PENALTY = 0.95;

/**
 * Name match that is aware of each side's container, so that the widespread
 * convention of embedding the table name in the column name
 * (`posts.post_id` vs. `Post.id`) does not read as a mismatch.
 */
export function matchNameInContainer(
  aName: string,
  aContainer: string,
  bName: string,
  bContainer: string,
): NameMatch {
  const direct = matchName(aName, bName);
  if (direct.score >= 1) return direct;
  const aTokens = canonicalTokens(aName);
  const bTokens = canonicalTokens(bName);
  const aStripped = stripContainerPrefix(aTokens, containerCore(aContainer));
  const bStripped = stripContainerPrefix(bTokens, containerCore(bContainer));
  if (aStripped === aTokens && bStripped === bTokens) return direct;
  if (aStripped.length === 0 || bStripped.length === 0) return direct;
  const alt = matchName(aStripped.join('_'), bStripped.join('_'));
  const altScore = alt.score * AFFIX_PENALTY;
  if (altScore <= direct.score) return direct;
  return { score: altScore, variant: 'affix' };
}
