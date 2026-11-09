#!/usr/bin/env node
/**
 * Seamline pack gate.
 *
 * Packs every non-private workspace package with `pnpm pack` (the same tool the
 * release workflow publishes with), reads the resulting tarball back, and fails
 * on anything a consumer would trip over or a maintainer would not want on the
 * public registry. Nothing is published and nothing touches the network: `pnpm
 * pack` writes a local `.tgz` into a temporary directory that this script
 * deletes afterwards.
 *
 * What it asserts about each tarball (the artifact, not the source tree):
 *
 *  - No test files, fixtures, source maps, TypeScript source, `src/`, build
 *    info, or test-support modules. Every file under `dist/` is `.js` or
 *    `.d.ts`, and the only top-level entries are `dist/`, `package.json`,
 *    `README.md`, `LICENSE` and `NOTICE`, plus a data directory of `.json` files
 *    for the one package that is named in DATA_DIRECTORIES (the injection corpus).
 *  - `main`, `types`, every `bin` target and every `exports` target exists in
 *    the tarball, and a `bin` target starts with a shebang.
 *  - `exports` lists exactly the reviewed entry points in PUBLIC_ENTRY_POINTS
 *    (no wildcards, no unreviewed subpath), and `types` comes first in every
 *    conditional block so TypeScript resolves it.
 *  - `engines.node` is present and equals the root manifest's.
 *  - `license` is Apache-2.0 and the tarball carries `LICENSE` and `README.md`.
 *  - The tarball carries `NOTICE`, byte-equal to the repository root's
 *    (Apache-2.0 section 4(d)). `pnpm pack` copies the root `LICENSE` into each
 *    tarball by itself but not `NOTICE`, so each package keeps a committed copy,
 *    listed in its `files`, and this check fails if a copy is missing or drifts.
 *  - No `workspace:` specifier survives into the packed manifest, and no
 *    published package depends on a private workspace package.
 *  - Internal packages (INTERNAL_PACKAGES) stay `"private": true`, and every
 *    private package declares no `exports`, `files` or `publishConfig`.
 *  - `sideEffects`, when present, is `false`, and a manifest with a `bin` does
 *    not set it (the bin is the one file that has effects).
 *  - `repository.url` equals the root's and `repository.directory` is the
 *    package's path; `description`, `homepage` and `bugs.url` are present, as
 *    the provenance attestation and the registry page need them.
 *  - Every bare import in shipped code is a declared dependency (or a Node
 *    built-in), and every runtime `dependencies` entry is imported by shipped
 *    code. Static imports, `export ... from` and literal `import()` are read;
 *    `require()` and computed specifiers are not, and are reviewed by hand. A dependency only the unshipped test doubles use belongs in
 *    `devDependencies`.
 *  - Every shipped `dist/*.js` is reachable from `main`, `exports` or `bin`
 *    through relative imports, unless it compiles to an empty module. This
 *    catches a test-support module whose name the name-based list misses.
 *
 * A package that cannot be packed is a failure, never a skip: "could not check"
 * must not look like "checked and clean" (AGENTS.md invariant 3).
 *
 * Plain Node, zero dependencies, by design (v3 §2.7, §10). The tarball reader
 * below is about forty lines so the gate does not depend on a system `tar`.
 *
 * Usage:
 *   node scripts/pack-check.mjs                 human-readable report; exit 1 on any violation
 *   node scripts/pack-check.mjs --root <dir>    check another workspace (used by the tests)
 *
 * Run `pnpm build` first: the tarballs are built from `dist/`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { gunzipSync } from 'node:zlib';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The reviewed public surface: for each publishable package, the exact set of
 * `exports` keys. Adding a subpath is an API decision, so it must be made here,
 * in review, and not by editing a package.json alone. A publishable package
 * that is absent from this table fails the gate for the same reason.
 *
 * `@seamline/core/identity` is deliberately kept although the root re-exports
 * the same names: `@seamline/extract-code-ts` imports it
 * (packages/extract-code-ts/src/canonical.ts) because it is the one core entry
 * point that does not load `node:sqlite`, whose import emits an
 * ExperimentalWarning on Node 22.
 *
 * `@seamline/core/sql` is the SQL tokenizer that `@seamline/extract-data` (DDL)
 * and `@seamline/extract-code-ts` (statements in literals) both read SQL with.
 * It is a subpath for the same reason `./identity` is: it is pure and must not
 * pull in the root barrel.
 */
export const PUBLIC_ENTRY_POINTS = Object.freeze({
  '@seamline/align': ['.'],
  '@seamline/cli': ['.'],
  '@seamline/contradictions': ['.'],
  '@seamline/core': ['.', './identity', './semantic', './sql'],
  '@seamline/extract-change': ['.'],
  '@seamline/extract-code-ts': ['.'],
  '@seamline/extract-contracts': ['.'],
  '@seamline/extract-data': ['.'],
  '@seamline/infer-join': ['.'],
  '@seamline/mcp': ['.'],
  '@seamline/ontology': ['.'],
  // The corpus subpaths are data files for tools that do not run JavaScript.
  '@seamline/security': ['.', './corpus', './corpus/secrets.json', './corpus/injections.json'],
});

/**
 * Modules a publishable package starts by path rather than imports, so no relative
 * import reaches them: the sandbox child (`seamline extract` spawns it with
 * `node --permission`), and the two modules `seamline conformance` starts the same
 * way: the wrapper it runs in place of the extractor under test, and the child that
 * reads an extractor module's manifest. They are roots for the reachability check,
 * and each must be in the tarball. Like the exports above, adding one is a decision
 * to make here.
 */
export const PROCESS_ENTRY_POINTS = Object.freeze({
  '@seamline/cli': [
    'dist/sandbox/child.js',
    'dist/conformance/wrapper.js',
    'dist/conformance/describe-child.js',
  ],
});

/** Workspace packages that exist only to test the others. They must never be published. */
export const INTERNAL_PACKAGES = Object.freeze(['@seamline/integration']);

/**
 * Extra top-level directories a named package may ship, each holding `.json`
 * data and nothing else. The public injection corpus is data, not compiled
 * output, so it sits beside `dist/` rather than inside it. A package that is not
 * listed here may not ship any directory but `dist/`.
 */
export const DATA_DIRECTORIES = Object.freeze({
  '@seamline/security': ['corpus'],
});

/** The only top-level entries a tarball may contain (after the leading `package/`). */
export const ALLOWED_TOP_LEVEL = Object.freeze([
  'dist',
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
]);

/**
 * Test-support modules that compile into `dist/` because tests import them.
 * They are not reachable through `exports` and have no business in a tarball.
 * `graph-memory` is named explicitly because its name does not say "test".
 */
const TEST_SUPPORT_BASENAME =
  /^(testing|fixtures?|graph-memory|test-[a-z0-9-]+|[a-z0-9-]+-fixtures?)(\.d)?\.[cm]?[jt]s$/;

/**
 * Relative specifiers in emitted JavaScript and declarations: `from './x.js'`,
 * `import './x.js'` and `import('./x.js')`. Comments are stripped before this
 * runs; a hit names the file and the specifier so it is easy to judge.
 */
const RELATIVE_SPECIFIER =
  /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * Every module specifier in emitted code; relative ones are told apart by their
 * first character. Static forms are anchored to the start of a statement (tsc
 * emits one per line start), so the word "from" inside a string is not an import.
 */
const ANY_SPECIFIER =
  /^\s*(?:import|export)\s[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

const BUILTINS = new Set(builtinModules);

/** tsc keeps comments, and a doc comment may quote an import as an example. */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** A module that compiles to nothing, such as one holding only types. */
const isEmptyModule = (text) => /^(export\s*\{\s*\}\s*;?)?$/.test(stripComments(text).trim());

/** The package a bare specifier belongs to: `@scope/name/sub` is `@scope/name`, `a/b` is `a`. */
const packageOf = (spec) =>
  spec.startsWith('@') ? spec.split('/', 2).join('/') : spec.split('/')[0];

// ---------------------------------------------------------------------------
// Tarball reader
// ---------------------------------------------------------------------------

function parsePax(body) {
  const out = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number.parseInt(body.subarray(at, space).toString('utf8'), 10);
    if (!Number.isInteger(len) || len <= 0) break;
    const record = body.subarray(space + 1, at + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/**
 * Reads a gzipped tar into `Map<path, { content, mode, type }>`, with the
 * conventional leading `package/` removed. Handles ustar prefixes, pax and GNU
 * long names. Only what `pnpm pack` and `npm pack` produce is supported.
 */
export function readTarball(gz) {
  const buf = gunzipSync(gz);
  const files = new Map();
  let at = 0;
  let pax = null;
  let longName = null;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const text = (from, to) => {
      const slice = h.subarray(from, to);
      const nul = slice.indexOf(0);
      return slice.subarray(0, nul < 0 ? slice.length : nul).toString('utf8');
    };
    const size = Number.parseInt(text(124, 136).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const mode = Number.parseInt(text(100, 108).trim() || '0', 8);
    let name = text(0, 100);
    if (text(257, 262) === 'ustar' && text(345, 500) !== '') name = `${text(345, 500)}/${name}`;
    const body = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = parsePax(body);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (pax?.path !== undefined) name = pax.path;
    if (longName !== null) name = longName;
    pax = null;
    longName = null;
    if (type === '5') continue; // directory
    files.set(name.startsWith('package/') ? name.slice('package/'.length) : name, {
      content: body,
      mode,
      type,
      underPackageDir: name.startsWith('package/'),
    });
  }
  return files;
}

// ---------------------------------------------------------------------------
// Workspace discovery and packing
// ---------------------------------------------------------------------------

/** Workspace package directories, from `pnpm-workspace.yaml`'s `packages:` list. Sorted. */
export function workspaceDirs(root) {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const dirs = [];
  let inPackages = false;
  for (const line of yaml) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const m = inPackages ? /^\s+-\s+['"]?([^'"#\s]+)['"]?\s*(#.*)?$/.exec(line) : null;
    if (!m) continue;
    const glob = m[1];
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/\*$/.test(glob)) {
      throw new Error(`pack-check supports only "<dir>/*" workspace globs, found "${glob}"`);
    }
    const base = join(root, glob.slice(0, -2));
    for (const entry of readdirSync(base).sort()) {
      const dir = join(base, entry);
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

/** Packs `dir` into `destDir` with `pnpm pack` and returns the tarball path. Throws on failure. */
export function packPackage(dir, destDir) {
  const out = execFileSync('pnpm', ['pack', '--json', '--pack-destination', destDir], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`pnpm pack printed no JSON for ${dir}: ${out.slice(0, 200)}`);
  const { filename } = JSON.parse(out.slice(start));
  if (typeof filename !== 'string') throw new Error(`pnpm pack reported no filename for ${dir}`);
  return filename;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** The most telling line of a failure's output: the first one that says "error", else the first. */
const firstLine = (text) => {
  const lines = String(text ?? '')
    .trim()
    .split('\n');
  return lines.find((l) => /error/i.test(l)) ?? lines[0];
};

const normalize = (target) => target.replace(/^\.\//, '');

/** Every string leaf of an `exports` value, with its dotted path. `null` targets are legal blockers. */
function exportLeaves(value, path, out, problems) {
  if (typeof value === 'string') {
    out.push({ path, target: value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => exportLeaves(v, `${path}[${i}]`, out, problems));
  } else if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.includes('types') && keys[0] !== 'types') {
      problems.push({
        code: 'TYPES_NOT_FIRST',
        message: `${path}: the "types" condition must come first or TypeScript will not use it`,
      });
    }
    for (const k of keys) exportLeaves(value[k], `${path}.${k}`, out, problems);
  } else if (value !== null) {
    problems.push({ code: 'EXPORT_TARGET_INVALID', message: `${path} is not a string` });
  }
}

/**
 * Pure: judges one package from its source manifest, its packed manifest and the
 * tarball's file map. Returns a list of `{ code, message }` violations; an empty
 * list means clean.
 *
 * @param {object} input
 * @param {object} input.manifest      the package's source package.json
 * @param {object} input.packed        package.json as it appears inside the tarball
 * @param {Map<string, {content: Buffer, underPackageDir?: boolean, type?: string}>} input.files
 * @param {string} input.expectedNode  the root manifest's engines.node
 * @param {Buffer} input.rootNotice    the repository root's NOTICE file
 * @param {string} input.rootRepositoryUrl the root manifest's repository.url
 * @param {string} input.relDir        this package's directory relative to the root, with "/"
 * @param {ReadonlySet<string>} input.privateNames names of private workspace packages
 */
export function checkPackage({
  manifest,
  packed,
  files,
  expectedNode,
  rootNotice,
  rootRepositoryUrl,
  relDir,
  privateNames,
}) {
  const v = [];
  const add = (code, message) => v.push({ code, message });
  const name = manifest.name;

  // Which package is this, and is its surface reviewed?
  if (!Object.hasOwn(PUBLIC_ENTRY_POINTS, name)) {
    add(
      'UNREVIEWED_PACKAGE',
      `${name} is publishable but not in PUBLIC_ENTRY_POINTS; add it there (and to the release workflow's provenance list) in the same review`,
    );
  }

  // Manifest fields.
  const node = packed.engines?.node;
  if (node === undefined) add('ENGINES_MISSING', 'engines.node is not declared');
  else if (node !== expectedNode) {
    add('ENGINES_MISMATCH', `engines.node is "${node}", the root declares "${expectedNode}"`);
  }
  if (packed.license !== 'Apache-2.0') {
    add('LICENSE_FIELD', `license is ${JSON.stringify(packed.license)}, expected "Apache-2.0"`);
  }
  if (packed.publishConfig?.access !== 'public') {
    add('ACCESS_NOT_PUBLIC', 'publishConfig.access is not "public"');
  }
  if (packed.sideEffects !== undefined && packed.bin !== undefined) {
    add('SIDE_EFFECTS_WITH_BIN', 'a package that ships a bin must not set sideEffects');
  } else if (packed.sideEffects !== undefined && packed.sideEffects !== false) {
    add(
      'SIDE_EFFECTS_INVALID',
      `sideEffects is ${JSON.stringify(packed.sideEffects)}; use false or omit it`,
    );
  }
  const repository = packed.repository;
  if (repository === null || typeof repository !== 'object') {
    add('REPOSITORY_MISSING', 'repository is not declared as an object');
  } else {
    if (repository.url !== rootRepositoryUrl) {
      add(
        'REPOSITORY_URL',
        `repository.url is ${JSON.stringify(repository.url)}, the root declares ${JSON.stringify(rootRepositoryUrl)}`,
      );
    }
    if (repository.directory !== relDir) {
      add(
        'REPOSITORY_DIRECTORY',
        `repository.directory is ${JSON.stringify(repository.directory)}, expected "${relDir}"`,
      );
    }
  }
  for (const field of ['description', 'homepage']) {
    if (typeof packed[field] !== 'string' || packed[field].trim() === '') {
      add(`${field.toUpperCase()}_MISSING`, `${field} is not declared`);
    }
  }
  if (typeof packed.bugs?.url !== 'string' || packed.bugs.url.trim() === '') {
    add('BUGS_MISSING', 'bugs.url is not declared');
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dep, range] of Object.entries(packed[section] ?? {})) {
      if (String(range).startsWith('workspace:')) {
        add('WORKSPACE_PROTOCOL', `${section}.${dep} is "${range}" in the packed manifest`);
      }
    }
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      if (privateNames.has(dep)) {
        add('PRIVATE_DEPENDENCY', `${section}.${dep} is a private workspace package`);
      }
    }
  }

  // Files that must be present.
  if (!files.has('LICENSE')) add('LICENSE_MISSING', 'LICENSE is not in the tarball');
  if (!files.has('README.md')) add('README_MISSING', 'README.md is not in the tarball');
  const notice = files.get('NOTICE');
  if (notice === undefined) {
    add('NOTICE_MISSING', 'NOTICE is not in the tarball; copy the root NOTICE into the package');
  } else if (!notice.content.equals(rootNotice)) {
    add(
      'NOTICE_DRIFT',
      'NOTICE differs from the repository root NOTICE; copy the root file over it',
    );
  }

  // Files that must not be. `flagged` keeps later checks from reporting them twice.
  const dataDirectories = Object.hasOwn(DATA_DIRECTORIES, name) ? DATA_DIRECTORIES[name] : [];
  const flagged = new Set();
  const flag = (code, path, message) => {
    flagged.add(path);
    add(code, message);
  };
  for (const [path, entry] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const top = path.split('/')[0];
    const forbid = (why) => flag('FORBIDDEN_FILE', path, `${path}: ${why}`);
    if (entry.underPackageDir === false) {
      flag('OUTSIDE_PACKAGE_DIR', path, `${path} is not under package/`);
    } else if (entry.type !== undefined && entry.type !== '0') {
      flag('NOT_A_REGULAR_FILE', path, `${path} is a tar entry of type "${entry.type}"`);
    } else if (!ALLOWED_TOP_LEVEL.includes(top) && !dataDirectories.includes(top)) {
      flag(
        'UNEXPECTED_TOP_LEVEL',
        path,
        `${path}: only ${[...ALLOWED_TOP_LEVEL, ...dataDirectories].join(', ')} belong at the top level`,
      );
    } else if (/(^|\/)(src|node_modules)\//.test(path)) {
      forbid('source and dependency directories are not published');
    } else if (/\.map$/.test(base)) {
      forbid('source map');
    } else if (/\.(test|spec)\.[cm]?[jt]s$/.test(base) || /\.(test|spec)\.d\.[cm]?ts$/.test(base)) {
      forbid('test file');
    } else if (/(^|\/)__?fixtures?__?\//.test(path) || /(^|\/)fixtures?\//.test(path)) {
      forbid('fixture');
    } else if (/\.tsbuildinfo$/.test(base)) {
      forbid('TypeScript build info');
    } else if (/\.[cm]?ts$/.test(base) && !/\.d\.[cm]?ts$/.test(base)) {
      forbid('TypeScript source');
    } else if (TEST_SUPPORT_BASENAME.test(base)) {
      forbid('test-support module');
    } else if (top === 'dist' && !/\.js$/.test(base) && !/\.d\.ts$/.test(base)) {
      forbid('dist holds only .js and .d.ts');
    } else if (dataDirectories.includes(top) && !/\.json$/.test(base)) {
      forbid(`${top} holds only .json data`);
    }
  }

  // A shipped module must not import a file the tarball leaves out. Excluding a
  // test-support module is only safe if nothing shipped still reaches it.
  for (const [path, entry] of files) {
    if (!/\.js$/.test(path) && !/\.d\.ts$/.test(path)) continue;
    const text = stripComments(entry.content.toString('utf8'));
    for (const m of text.matchAll(RELATIVE_SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const target = posix.normalize(posix.join(posix.dirname(path), spec));
      // Emitted declarations keep the source's `./x.ts` specifier (only the JS
      // output is rewritten to `./x.js`), and TypeScript resolves either to `x.d.ts`.
      const candidates = [target, target.replace(/\.(js|ts)$/, '.d.ts')];
      if (!candidates.some((c) => files.has(c))) {
        add('DANGLING_IMPORT', `${path} imports "${spec}", which is not in the tarball`);
      }
    }
  }

  // Entry points must exist in the tarball.
  const entries = [];
  const need = (label, target) => {
    if (
      typeof target !== 'string' ||
      !target.startsWith('./') ||
      target.split('/').includes('..')
    ) {
      add(
        'EXPORT_TARGET_INVALID',
        `${label} "${target}" must be a "./"-relative path inside the package`,
      );
    } else if (!files.has(normalize(target))) {
      add('ENTRY_MISSING', `${label} "${target}" is not in the tarball`);
    } else {
      entries.push(normalize(target));
    }
  };
  for (const field of ['main', 'types']) {
    if (packed[field] === undefined) add('ENTRY_FIELD_MISSING', `${field} is not declared`);
    else need(field, packed[field]);
  }
  const bins = typeof packed.bin === 'string' ? { [name]: packed.bin } : (packed.bin ?? {});
  for (const [binName, target] of Object.entries(bins)) {
    need(`bin.${binName}`, target);
    const file = files.get(normalize(String(target)));
    if (file && !file.content.subarray(0, 2).equals(Buffer.from('#!'))) {
      add('BIN_NO_SHEBANG', `bin.${binName} "${target}" does not start with a shebang`);
    }
  }

  // Modules started by path (see PROCESS_ENTRY_POINTS) are roots too.
  for (const target of Object.hasOwn(PROCESS_ENTRY_POINTS, name)
    ? PROCESS_ENTRY_POINTS[name]
    : []) {
    if (!files.has(target)) add('ENTRY_MISSING', `process entry "${target}" is not in the tarball`);
    else entries.push(target);
  }

  // The exports map: every target exists, and the keys are the reviewed ones.
  if (
    packed.exports === undefined ||
    packed.exports === null ||
    typeof packed.exports !== 'object'
  ) {
    add('EXPORTS_MISSING', 'exports is not declared as an object of subpaths');
  } else {
    const keys = Object.keys(packed.exports);
    if (keys.some((k) => !k.startsWith('.'))) {
      add(
        'EXPORTS_CONDITIONS_AT_ROOT',
        'exports mixes conditions and subpaths, or declares no subpath',
      );
    }
    for (const key of keys) {
      if (key.includes('*'))
        add('EXPORTS_PATTERN', `exports "${key}" is a wildcard; list entry points explicitly`);
      const leaves = [];
      const problems = [];
      exportLeaves(packed.exports[key], `exports[${JSON.stringify(key)}]`, leaves, problems);
      for (const p of problems) add(p.code, p.message);
      for (const { path, target } of leaves) need(path, target);
    }
    const reviewed = Object.hasOwn(PUBLIC_ENTRY_POINTS, name)
      ? PUBLIC_ENTRY_POINTS[name]
      : undefined;
    if (reviewed !== undefined) {
      for (const key of keys.filter((k) => !reviewed.includes(k))) {
        add('EXPORTS_UNREVIEWED', `exports "${key}" is not a reviewed entry point of ${name}`);
      }
      for (const key of reviewed.filter((k) => !keys.includes(k))) {
        add('EXPORTS_REMOVED', `reviewed entry point "${key}" is no longer exported by ${name}`);
      }
    }
  }

  // Bare imports in shipped code against the declared dependencies, both ways.
  const declared = new Set([
    ...Object.keys(packed.dependencies ?? {}),
    ...Object.keys(packed.optionalDependencies ?? {}),
    ...Object.keys(packed.peerDependencies ?? {}),
  ]);
  const imported = new Set();
  const textOf = new Map();
  for (const [path, entry] of files) {
    if (flagged.has(path) || (!/\.js$/.test(path) && !/\.d\.ts$/.test(path))) continue;
    const text = stripComments(entry.content.toString('utf8'));
    textOf.set(path, text);
    const seen = new Set();
    for (const m of text.matchAll(ANY_SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const pkg = packageOf(spec);
      if (BUILTINS.has(pkg) || pkg === name) continue;
      imported.add(pkg);
      if (!declared.has(pkg) && !seen.has(pkg)) {
        seen.add(pkg);
        add('UNDECLARED_IMPORT', `${path} imports "${pkg}", which the manifest does not declare`);
      }
    }
  }
  for (const dep of Object.keys(packed.dependencies ?? {})) {
    if (!imported.has(dep)) {
      add(
        'UNUSED_DEPENDENCY',
        `dependencies.${dep} is not imported by any shipped file; if only tests use it, make it a devDependency`,
      );
    }
  }

  // Reachability: every shipped .js is reached from an entry point through relative
  // imports, or compiles to nothing.
  const reached = new Set();
  const queue = entries.filter((e) => /\.js$/.test(e));
  while (queue.length > 0) {
    const path = queue.pop();
    if (reached.has(path) || !textOf.has(path)) continue;
    reached.add(path);
    for (const m of textOf.get(path).matchAll(RELATIVE_SPECIFIER)) {
      const target = posix.normalize(posix.join(posix.dirname(path), m[1] ?? m[2] ?? m[3]));
      if (/\.js$/.test(target) && files.has(target)) queue.push(target);
    }
  }
  for (const [path, entry] of files) {
    if (!/\.js$/.test(path) || flagged.has(path) || reached.has(path)) continue;
    if (!isEmptyModule(entry.content.toString('utf8'))) {
      add('UNREACHABLE_MODULE', `${path} is not reachable from main, exports or bin`);
    }
  }
  return v;
}

/** Pure: a private workspace package must not look publishable. */
export function checkPrivatePackage(manifest) {
  return ['exports', 'files', 'publishConfig']
    .filter((field) => manifest[field] !== undefined)
    .map((field) => ({
      code: 'PRIVATE_HAS_PUBLISH_FIELDS',
      message: `${manifest.name} is private but declares "${field}"`,
    }));
}

/**
 * Judges the whole workspace. `pack` is injectable so tests can hand in
 * deliberately broken tarballs; the default is the real `pnpm pack`.
 *
 * @returns {{ packages: Array<{ name: string, dir: string, fileCount: number, bytes: number, violations: object[] }>, violations: object[] }}
 */
export function checkWorkspace(root, { pack = packPackage } = {}) {
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const expectedNode = rootManifest.engines?.node;
  const rootRepositoryUrl = rootManifest.repository?.url;
  const noticePath = join(root, 'NOTICE');
  const rootNotice = existsSync(noticePath) ? readFileSync(noticePath) : undefined;
  const manifests = workspaceDirs(root).map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')),
  }));
  const privateNames = new Set(
    manifests.filter((m) => m.manifest.private === true).map((m) => m.manifest.name),
  );

  const workspaceLevel = [];
  if (rootNotice === undefined) {
    workspaceLevel.push({
      code: 'ROOT_NOTICE_MISSING',
      message: 'the repository root has no NOTICE file to compare the packages against',
    });
  }
  if (typeof rootRepositoryUrl !== 'string' || rootRepositoryUrl === '') {
    workspaceLevel.push({
      code: 'ROOT_REPOSITORY_MISSING',
      message: 'the root package.json declares no repository.url to compare the packages against',
    });
  }
  for (const m of manifests.filter((x) => x.manifest.private === true)) {
    workspaceLevel.push(...checkPrivatePackage(m.manifest));
  }
  for (const internal of INTERNAL_PACKAGES) {
    const found = manifests.find((m) => m.manifest.name === internal);
    if (found === undefined) {
      workspaceLevel.push({
        code: 'INTERNAL_PACKAGE_UNKNOWN',
        message: `${internal} is not in the workspace`,
      });
    } else if (found.manifest.private !== true) {
      workspaceLevel.push({
        code: 'INTERNAL_NOT_PRIVATE',
        message: `${internal} must declare "private": true`,
      });
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'seamline-pack-'));
  const packages = [];
  try {
    for (const { dir, manifest } of manifests) {
      if (manifest.private === true) continue;
      const violations = [];
      let files = new Map();
      let bytes = 0;
      try {
        const tarball = readFileSync(pack(dir, tmp));
        bytes = tarball.length;
        files = readTarball(tarball);
        const packedEntry = files.get('package.json');
        if (packedEntry === undefined) {
          violations.push({
            code: 'MANIFEST_MISSING',
            message: 'package.json is not in the tarball',
          });
        } else {
          violations.push(
            ...checkPackage({
              manifest,
              packed: JSON.parse(packedEntry.content.toString('utf8')),
              files,
              expectedNode,
              rootNotice: rootNotice ?? Buffer.alloc(0),
              rootRepositoryUrl,
              relDir: relative(root, dir).split(sep).join('/'),
              privateNames,
            }),
          );
        }
      } catch (error) {
        violations.push({
          code: 'PACK_FAILED',
          message: `could not pack or read the tarball: ${firstLine(error?.stderr) || firstLine(error?.message) || String(error)}`,
        });
      }
      packages.push({ name: manifest.name, dir, fileCount: files.size, bytes, violations });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return {
    packages,
    violations: [
      ...workspaceLevel,
      ...packages.flatMap((p) => p.violations.map((x) => ({ package: p.name, ...x }))),
    ],
  };
}

function main(argv) {
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag >= 0 && argv[rootFlag + 1] ? resolve(argv[rootFlag + 1]) : REPO_ROOT;
  const started = Date.now();
  const report = checkWorkspace(root);
  for (const p of report.packages) {
    const status = p.violations.length === 0 ? 'PASS' : 'FAIL';
    console.log(
      `${status}  ${p.name}  (${p.fileCount} files, ${(p.bytes / 1024).toFixed(1)} KiB packed)`,
    );
    for (const x of p.violations) console.log(`      ${x.code}: ${x.message}`);
  }
  for (const x of report.violations.filter((x) => x.package === undefined)) {
    console.log(`FAIL  workspace\n      ${x.code}: ${x.message}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (report.violations.length > 0) {
    console.error(`\npack-check: ${report.violations.length} violation(s) in ${seconds}s`);
    process.exit(1);
  }
  console.log(`\npack-check: ${report.packages.length} packages clean in ${seconds}s`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
