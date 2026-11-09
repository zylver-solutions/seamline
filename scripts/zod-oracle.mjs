#!/usr/bin/env node
/**
 * Zod null-ness and presence oracle for `@seamline/extract-contracts`.
 *
 * Generates seeded, nested Zod expressions (about 40 atoms, about 40 wrappers:
 * `.catch`, `.default`, `.nullish`, `.brand`, `.pipe`, `z.coerce.*`, unions,
 * intersections, containers, the Zod 4 list `z.literal`, ...), and judges each
 * one twice:
 *
 *   1. SYM: a truth table written by reasoning about Zod semantics (does the
 *      schema accept `null`? does it accept a missing key?).
 *   2. REAL: the real library, `z.object({ p: <expr> }).safeParse({ p: null })`
 *      and `.safeParse({})`.
 *
 * SYM is checked against REAL first, so the oracle is not trusted blindly: below
 * Zod 4.4.0 a mismatch means the table or the installed Zod is wrong, and the run
 * fails. The extractor is then compared with REAL. Four counts matter, and all
 * four should be zero:
 *
 *   - `nullable: false` stated while real Zod accepts null
 *     (a false X1 finding: the contract is said to reject a null it accepts)
 *   - `nullable: true` stated while real Zod rejects null
 *   - `required: false` stated while real Zod rejects a missing key
 *   - `required: true` stated while real Zod accepts a missing key
 *
 * A property whose facet the extractor leaves unread (unknown) is never counted:
 * unknown is the correct answer when a facet cannot be read.
 *
 * The SYM table is written for Zod 3.25 (and its `zod/v4`) and describes presence
 * before Zod 4.4.0; it agreed with the library on every release below that it was
 * run on (3.20 to 4.3.6). Presence moved in Zod 4.4.0: from there a missing key
 * is rejected where the table says it is accepted, for `z.any()`, `z.unknown()`,
 * `z.undefined()`, `z.void()`, a `z.literal` of `undefined`, `z.coerce.string()`,
 * `z.coerce.boolean()` and the two options spelled `{ coerce: true }`, and for
 * any expression holding one (and, on 4.4.0 to 4.4.2 only, for a `.catch(...)`
 * whose receiver rejects a missing key). So the table is compared with the
 * library only when the installed Zod is below 4.4.0. From 4.4.0 the mismatches
 * are printed as information, the table being out of date for that release and
 * not the extractor (which states presence only where the releases agree), and
 * the exit status is the four counts alone.
 *
 * A run that proves nothing does not pass either: the exit status is 1 unless the
 * extractor's status is PASS and at least one property states a facet. An
 * extractor that returned UNAVAILABLE, or one that read every property and stated
 * nothing, has not been checked against the library.
 *
 * Zod is NOT a dependency of this repository and this script is not part of
 * `pnpm verify`. It runs only against an external install:
 *
 *   mkdir /some/scratch && cd /some/scratch && npm init -y && npm i zod@3.25.76
 *   ZOD_ORACLE_DIR=/some/scratch node scripts/zod-oracle.mjs --zod 3 --seed 1
 *
 * `ZOD_ORACLE_DIR` is a directory whose `node_modules` holds `zod` (or a
 * `node_modules` directory itself). Build first (`./node_modules/.bin/tsc --build`).
 *
 * Usage:
 *   ZOD_ORACLE_DIR=<dir> node scripts/zod-oracle.mjs [--zod 3|4] [--seed N] [--count N]
 *                                                    [--extractor <path>] [--show N]
 *
 *   --zod 3|4        Zod major to judge against: `zod` (3, the default) or `zod/v4`.
 *   --seed N         Generator seed (default 1). Same seed, same expressions.
 *   --count N        Expressions to generate per run (default 3000).
 *   --extractor P    Module exporting `extractContracts` (default: the built
 *                    `packages/extract-contracts/dist/index.js`). Pass a `.ts`
 *                    entry to compare another revision, and run node with
 *                    `--experimental-strip-types`.
 *   --show N         List up to N offending expressions per count (default 25).
 *
 * Exit status: 0 when all four counts are zero, the extractor's status is PASS,
 * at least one property states a facet and, below Zod 4.4.0, SYM agrees with
 * REAL; 1 otherwise; 2 when the run is not configured (no `ZOD_ORACLE_DIR`).
 */

import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
}

const oracleDir = process.env['ZOD_ORACLE_DIR'];
if (oracleDir === undefined || oracleDir === '') {
  console.error(
    'zod-oracle: ZOD_ORACLE_DIR is not set. Point it at an external zod install ' +
      '(see the header of this file). This script never runs in `pnpm verify`.',
  );
  process.exit(2);
}

const ZV = option('zod', '3');
if (ZV !== '3' && ZV !== '4') {
  console.error('zod-oracle: --zod must be 3 or 4');
  process.exit(2);
}
const SEED = Number(option('seed', '1'));
const COUNT = Number(option('count', '3000'));
const SHOW = Number(option('show', '25'));
const extractorPath = option(
  'extractor',
  join(REPO_ROOT, 'packages/extract-contracts/dist/index.js'),
);

const req = createRequire(join(resolve(oracleDir), 'noop.js'));
const zodRoot = req('zod');
const zodVersion = req('zod/package.json').version;
const zNs = ZV === '4' ? req('zod/v4') : (zodRoot.z ?? zodRoot);
// The SYM table describes presence before Zod 4.4.0 (see the header), so it is
// compared with the library only on a release below that.
const [zodMajor, zodMinor] = zodVersion.split('.').map(Number);
const symComparable = zodMajor < 4 || (zodMajor === 4 && zodMinor < 4);

const { extractContracts } = await import(pathToFileURL(resolve(extractorPath)).href);

// The source the extractor reads. The bindings are shared by name with `realEnv`.
const PRE = `import { z } from 'zod';
import { EXT } from './elsewhere';
const OPTIONS = [z.string(), z.null()] as const;
const NUL = null;
const UND = undefined;
const NS = z.string().nullable();
const NB = z.null();
const NSTR = z.string();
function make() { return [z.string(), z.null()] as const; }
function f(x: unknown) { return x; }
function ok(x: unknown) { return true; }
`;
const realEnv = {
  z: zNs,
  EXT: { A: 'a', B: 'b' },
  OPTIONS: [zNs.string(), zNs.null()],
  NUL: null,
  UND: undefined,
  NS: zNs.string().nullable(),
  NB: zNs.null(),
  NSTR: zNs.string(),
  make: () => [zNs.string(), zNs.null()],
  f: (x) => x,
  ok: () => true,
};
const envNames = Object.keys(realEnv);
const envValues = Object.values(realEnv);

// xorshift32, seeded: the same seed always yields the same expressions.
let state = SEED >>> 0 || 1;
function rnd() {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 0x100000000;
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

function realAccepts(src, valueSrc) {
  try {
    const schema = new Function(...envNames, `return ${src};`)(...envValues);
    const value = new Function(...envNames, `return ${valueSrc};`)(...envValues);
    return schema.safeParse(value).success;
  } catch {
    return false;
  }
}

// One expression with its hand-written truth: does `parse(null)` succeed
// (nullOK) and does `parse(undefined)` succeed, i.e. may the key be missing
// (undefOK). `sym` is false where the table makes no claim (refinements and
// transforms may reject anything), and such expressions skip the SYM check.
const e = (src, nullOK, undefOK, sym = true) => ({ src, nullOK, undefOK, sym });

const ATOMS = [
  e('z.string()', false, false),
  e('z.number()', false, false),
  e('z.boolean()', false, false),
  e('z.date()', false, false),
  e('z.bigint()', false, false),
  e('z.string().email()', false, false),
  e('z.number().int()', false, false),
  e('z.null()', true, false),
  e('z.undefined()', false, true),
  e('z.void()', false, true),
  e("z.literal('a')", false, false),
  e('z.literal(1)', false, false),
  e('z.literal(true)', false, false),
  e('z.literal(null)', true, false),
  e('z.literal(NUL)', true, false),
  e('z.literal(UND)', false, true),
  e("z.enum(['a', 'b'])", false, false),
  e('z.nativeEnum(EXT)', false, false),
  e('z.any()', true, true),
  e('z.unknown()', true, true),
  e('z.never()', false, false),
  e('z.nan()', false, false),
  e('z.symbol()', false, false),
  // Coercion runs first: String(null) is 'null', String(undefined) is 'undefined',
  // Number(null) is 0 but Number(undefined) is NaN (rejected), and so on.
  e('z.coerce.string()', true, true),
  e('z.coerce.number()', true, false),
  e('z.coerce.boolean()', true, true),
  e('z.coerce.date()', true, false),
  e('z.coerce.bigint()', false, false),
  // The same coercion spelled as a constructor option. `BigInt(null)` throws, so
  // a bigint rejects the null the others accept.
  e('z.string({ coerce: true })', true, true),
  e('z.number({ coerce: true })', true, false),
  e('z.boolean({ coerce: true })', true, true),
  e('z.date({ coerce: true })', true, false),
  e('z.bigint({ coerce: true })', false, false),
  e('NS', true, false),
  e('NB', true, false),
  e('NSTR', false, false),
  e('z.object({ a: z.string() })', false, false),
  e('z.array(z.string())', false, false),
  e('z.record(z.string(), z.number())', false, false),
  e('z.tuple([z.string()])', false, false),
  e('z.set(z.string())', false, false),
  e('z.map(z.string(), z.string())', false, false),
  e('z.instanceof(Date)', false, false),
  e('z.custom<string>((v) => typeof v === "string")', false, false, false),
  e('z.function()', false, false),
  e('z.promise(z.string())', false, false),
];
if (ZV === '4') {
  ATOMS.push(
    e("z.literal(['a', null])", true, false),
    e("z.literal(['a', 'b'])", false, false),
    e("z.literal(['a', undefined])", false, true),
    e('z.int()', false, false),
    e('z.email()', false, false),
    e('z.strictObject({ a: z.string() })', false, false),
    e('z.looseObject({ a: z.string() })', false, false),
    e('z.nullish(z.string())', true, true),
    e('z.stringbool()', false, false),
    e('z.iso.datetime()', false, false),
  );
}

const UNARY = [
  ['nullable', (x) => e(`${x.src}.nullable()`, true, x.undefOK)],
  ['optional', (x) => e(`${x.src}.optional()`, x.nullOK, true)],
  ['nullish', (x) => e(`${x.src}.nullish()`, true, true)],
  [
    'default',
    (x) => {
      const c = pick(["'x'", '1', 'true', 'null', 'NUL']);
      return realAccepts(x.src, c) ? e(`${x.src}.default(${c})`, x.nullOK, true) : x;
    },
  ],
  ['catch', (x) => e(`${x.src}.catch('x')`, true, true)],
  ['catch-null', (x) => e(`${x.src}.catch(null)`, true, true)],
  ['describe', (x) => e(`${x.src}.describe('d')`, x.nullOK, x.undefOK)],
  ['readonly', (x) => e(`${x.src}.readonly()`, x.nullOK, x.undefOK)],
  ['array', (x) => e(`${x.src}.array()`, false, false)],
  ['brand', (x) => e(`${x.src}.brand()`, x.nullOK, x.undefOK)],
  ['refine', (x) => e(`${x.src}.refine(ok)`, x.nullOK, x.undefOK, false)],
  ['transform', (x) => e(`${x.src}.transform(f)`, x.nullOK, x.undefOK, false)],
  ['superRefine', (x) => e(`${x.src}.superRefine(ok)`, x.nullOK, x.undefOK, false)],
  ['pipe-null', (x) => e(`${x.src}.pipe(z.null())`, false, false, false)],
  ['pipe-any', (x) => e(`${x.src}.pipe(z.any())`, x.nullOK, x.undefOK, false)],
  ['or-null', (x) => e(`${x.src}.or(z.null())`, true, x.undefOK)],
  ['or-str', (x) => e(`${x.src}.or(z.string())`, x.nullOK, x.undefOK)],
  ['and-str', (x) => e(`${x.src}.and(z.string())`, false, false, false)],
  ['and-self', (x) => e(`${x.src}.and(${x.src})`, x.nullOK, x.undefOK, false)],
  ['and-NS', (x) => e(`${x.src}.and(NS)`, x.nullOK, false, false)],
  ['nonoptional', (x) => e(`${x.src}.nonoptional()`, x.nullOK, false, false)],
  ['prefault', (x) => e(`${x.src}.prefault('x')`, x.nullOK, true, false)],
  ['meta', (x) => e(`${x.src}.meta({ a: 1 })`, x.nullOK, x.undefOK)],
  ['lazy', (x) => e(`z.lazy(() => ${x.src})`, x.nullOK, x.undefOK)],
  ['z.optional', (x) => e(`z.optional(${x.src})`, x.nullOK, true)],
  ['z.nullable', (x) => e(`z.nullable(${x.src})`, true, x.undefOK)],
  ['z.array', (x) => e(`z.array(${x.src})`, false, false)],
  ['z.set', (x) => e(`z.set(${x.src})`, false, false)],
  ['z.tuple', (x) => e(`z.tuple([${x.src}])`, false, false)],
  ['z.record', (x) => e(`z.record(z.string(), ${x.src})`, false, false)],
  ['z.object', (x) => e(`z.object({ a: ${x.src} })`, false, false)],
  ['z.map', (x) => e(`z.map(z.string(), ${x.src})`, false, false)],
  ['z.preprocess', (x) => e(`z.preprocess(f, ${x.src})`, x.nullOK, x.undefOK, false)],
  ['union1', (x) => e(`z.union([${x.src}])`, x.nullOK, x.undefOK, false)],
  ['unionOPT', () => e('z.union(OPTIONS)', true, false)],
  ['unionMAKE', () => e('z.union(make())', true, false)],
];
const BINARY = [
  [
    'union',
    (a, b) => e(`z.union([${a.src}, ${b.src}])`, a.nullOK || b.nullOK, a.undefOK || b.undefOK),
  ],
  [
    'union3',
    (a, b) =>
      e(`z.union([${a.src}, ${b.src}, z.number()])`, a.nullOK || b.nullOK, a.undefOK || b.undefOK),
  ],
  [
    'intersection',
    (a, b) =>
      e(`z.intersection(${a.src}, ${b.src})`, a.nullOK && b.nullOK, a.undefOK && b.undefOK, false),
  ],
  ['or', (a, b) => e(`${a.src}.or(${b.src})`, a.nullOK || b.nullOK, a.undefOK || b.undefOK)],
  [
    'and',
    (a, b) => e(`${a.src}.and(${b.src})`, a.nullOK && b.nullOK, a.undefOK && b.undefOK, false),
  ],
];

function gen(depth) {
  if (depth <= 0 || rnd() < 0.25) return pick(ATOMS);
  const r = rnd();
  if (r < 0.65) {
    const [, f] = pick(UNARY);
    const inner = gen(depth - 1);
    const out = f(inner);
    return { ...out, sym: out.sym && inner.sym };
  }
  const [, g] = pick(BINARY);
  const a = gen(depth - 1);
  const b = gen(depth - 1);
  const out = g(a, b);
  return { ...out, sym: out.sym && a.sym && b.sym };
}

const seen = new Set();
const exprs = [];
for (let guard = 0; exprs.length < COUNT && guard < COUNT * 20; guard += 1) {
  const x = gen(1 + Math.floor(rnd() * 3));
  if (seen.has(x.src)) continue;
  seen.add(x.src);
  exprs.push(x);
}

// REAL: what the library does. `null` marks an expression it cannot construct.
const real = exprs.map((x) => {
  try {
    const schema = new Function(...envNames, `return z.object({ p: ${x.src} });`)(...envValues);
    return {
      nullOK: schema.safeParse({ p: null }).success,
      undefOK: schema.safeParse({}).success,
    };
  } catch {
    return null;
  }
});

// SYM against REAL.
let symChecked = 0;
const symMismatch = [];
exprs.forEach((x, i) => {
  const r = real[i];
  if (r === null || !x.sym) return;
  symChecked += 1;
  if (r.nullOK !== x.nullOK || r.undefOK !== x.undefOK)
    symMismatch.push(`${x.src}  sym=(${x.nullOK},${x.undefOK}) real=(${r.nullOK},${r.undefOK})`);
});

// The extractor, over the same expressions, in chunks of 400 per file.
const root = mkdtempSync(join(tmpdir(), 'seamline-zod-oracle-'));
const stated = [];
let status = '';
try {
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let off = 0; off < exprs.length; off += 400) {
    const part = exprs
      .slice(off, off + 400)
      .map((x, j) => `export const C${off + j} = z.object({ p: ${x.src} });`)
      .join('\n');
    writeFileSync(join(root, 'src', `a${off}.ts`), `${PRE}${part}\n`);
  }
  const run = extractContracts({ repoRoot: root, repo: 'oracle', runId: 'r1' });
  status = run.result.status;
  const byContract = new Map();
  for (const n of run.nodes) {
    if (n.kind !== 'SchemaProperty' || n.name !== 'p') continue;
    const m = /SchemaProperty:(C\d+)#/.exec(String(n.id));
    if (m !== null) byContract.set(m[1], n.props);
  }
  exprs.forEach((_, i) => stated.push(byContract.get(`C${i}`)));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const total = {
  generated: exprs.length,
  constructible: 0,
  withheld: 0,
  nullableFalse: 0,
  nullableTrue: 0,
  nullableUnknown: 0,
  requiredTrue: 0,
  requiredFalse: 0,
  requiredUnknown: 0,
};
const bad = {
  nullableFalseWhileAcceptsNull: [],
  nullableTrueWhileRejectsNull: [],
  requiredFalseWhileRejectsMissing: [],
  requiredTrueWhileAcceptsMissing: [],
};
exprs.forEach((x, i) => {
  const r = real[i];
  if (r === null) return;
  total.constructible += 1;
  const props = stated[i];
  if (props === undefined) {
    total.withheld += 1;
    return;
  }
  const n = props['nullable'];
  const q = props['required'];
  if (n === false) total.nullableFalse += 1;
  else if (n === true) total.nullableTrue += 1;
  else total.nullableUnknown += 1;
  if (q === true) total.requiredTrue += 1;
  else if (q === false) total.requiredFalse += 1;
  else total.requiredUnknown += 1;
  if (n === false && r.nullOK) bad.nullableFalseWhileAcceptsNull.push(x.src);
  if (n === true && !r.nullOK) bad.nullableTrueWhileRejectsNull.push(x.src);
  if (q === false && !r.undefOK) bad.requiredFalseWhileRejectsMissing.push(x.src);
  if (q === true && r.undefOK) bad.requiredTrueWhileAcceptsMissing.push(x.src);
});

const catchOrCoerce = (src) => /\.catch\(|z\.coerce\.|coerce: true/.test(src);
console.log(
  JSON.stringify({
    zod: `${zodVersion} (${ZV === '4' ? 'zod/v4' : 'zod'})`,
    seed: SEED,
    extractorStatus: status,
    ...total,
    symChecked,
    symMismatches: symMismatch.length,
    symCompared: symComparable,
  }),
);
const report = (title, list) => {
  const involved = list.filter(catchOrCoerce).length;
  console.log(
    `${title}: ${list.length} (${involved} involve .catch()/z.coerce, ${list.length - involved} other)`,
  );
  for (const src of list.slice(0, SHOW)) console.log(`   ${src}`);
};
if (symComparable)
  report('SYM != REAL (the truth table or the installed Zod is wrong)', symMismatch);
else
  report(
    `SYM != REAL, information only: the table describes presence before 4.4.0; not compared on ${zodVersion}`,
    symMismatch,
  );
report('nullable:false while real Zod accepts null', bad.nullableFalseWhileAcceptsNull);
report('nullable:true while real Zod rejects null', bad.nullableTrueWhileRejectsNull);
report('required:false while real Zod rejects a missing key', bad.requiredFalseWhileRejectsMissing);
report('required:true while real Zod accepts a missing key', bad.requiredTrueWhileAcceptsMissing);

// An extractor that is not PASS, or that states no facet at all, has not been
// checked against the library: a stub that returns UNAVAILABLE counts zero in
// every list above and must not exit 0.
const statedFacets =
  total.nullableFalse + total.nullableTrue + total.requiredTrue + total.requiredFalse;
const reasons = [];
if (symComparable && symMismatch.length > 0) reasons.push('SYM != REAL');
if (Object.values(bad).some((list) => list.length > 0)) reasons.push('a wrong fact');
if (status !== 'PASS') reasons.push(`the extractor status is ${status}, not PASS`);
else if (statedFacets === 0) reasons.push('no property states a facet');
console.log(reasons.length === 0 ? 'oracle: ok' : `oracle: FAILED (${reasons.join('; ')})`);
process.exit(reasons.length === 0 ? 0 : 1);
