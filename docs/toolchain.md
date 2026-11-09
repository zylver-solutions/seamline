# Toolchain conventions

Binding on every package in this repo. These were established by running them, not by preference — each one has a reason recorded below.

## Runtime and language

- **Node >= 22.13, developed on 24.** The floor is the `engines.node` field in the root `package.json`, and CI runs 22.13 and 24. ESM only; every `package.json` has `"type": "module"`.
- **TypeScript is type-stripped by Node at runtime.** No transpile step is needed to run tests.
- **No vitest, no jest, no esbuild, no ts-node, no tsx.** vitest pulls esbuild, whose platform binary is installed by a postinstall script that cannot run on this drvfs mount (it needs a chmod the filesystem does not support). The result is not an error but a **hang**, which is worse. The built-in runner has no native dependency and no postinstall.
- Fewer build dependencies is also the position this project takes publicly: see design v3 §2.7 and §10 on supply-chain surface.

## Imports — the one rule that bites

**Relative imports must carry the `.ts` extension:**

```ts
import { nodeId } from './contract.ts';        // correct
import { nodeId } from './contract.js';        // WRONG — fails at runtime
import { nodeId } from './contract';           // WRONG — fails at runtime
```

Node's type stripping does not rewrite specifiers, so `./contract.js` resolves to a file that does not exist in `src/`. TypeScript is configured with `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, so it rewrites `.ts` to `.js` in the emitted output. Source is runnable and `dist/` is valid.

## Erasable syntax only

`erasableSyntaxOnly: true` is set, because Node can only strip types, not transform them. This is a compile error, so you will find out immediately, but to save you the round trip:

- **No `enum`.** Use `as const` arrays plus a derived union — see `NODE_KINDS` / `NodeKind` in `contract.ts`.
- **No `namespace`**, no `import =`, no `export =`.
- **No constructor parameter properties** (`constructor(private readonly x: T)`). Declare the field, assign in the body.
- `declare` fields are fine; `abstract` is fine.

## Testing

- `node:test` + `node:assert/strict`. Tests live beside their source as `src/**/*.test.ts`.
- Run everything: `pnpm test` (`node --test 'packages/*/src/**/*.test.ts'`).
- `fast-check` is available and is **required** for the merge and identity layers (design v3 §7): merge must be proven associative, commutative, and idempotent over randomized orderings, not merely spot-checked.
- Assert authoritative outcomes, not presence. `assert.ok(typeof fn === 'function')` is not a test. This repo's own design (v3 §1) rejects presence-checking as a gate, and the test suite is held to the same standard.

## Package layout

```
packages/<name>/
├─ package.json     name "@seamline/<name>", "type": "module", license Apache-2.0
├─ README.md        shipped in the tarball
├─ NOTICE           byte-for-byte copy of the root NOTICE, shipped in the tarball
├─ tsconfig.json    extends ../../tsconfig.base.json, rootDir src, outDir dist
└─ src/
   ├─ index.ts      public surface, re-exports only
   ├─ <impl>.ts
   └─ <impl>.test.ts
```

`package.json` template (copy `packages/ontology/package.json`):

```json
{
  "name": "@seamline/<name>",
  "version": "0.0.1",
  "description": "One sentence on what the package is for.",
  "type": "module",
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/zylver-solutions/seamline.git",
    "directory": "packages/<name>"
  },
  "homepage": "https://github.com/zylver-solutions/seamline/tree/main/packages/<name>#readme",
  "bugs": { "url": "https://github.com/zylver-solutions/seamline/issues" },
  "engines": { "node": ">=22.13.0" },
  "sideEffects": false,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "files": [
    "dist",
    "!dist/**/*.test.*",
    "!dist/**/__fixtures__/**",
    "!dist/**/*.map",
    "README.md",
    "NOTICE"
  ],
  "publishConfig": { "access": "public" },
  "scripts": { "build": "tsc --build", "test": "node --test 'src/**/*.test.ts'" }
}
```

Notes on the template. Everything in this list is enforced by `pnpm gate:pack` (`scripts/pack-check.mjs`), which packs each package with `pnpm pack` and checks the tarball:

- `engines.node` equals the root `package.json`'s. `sideEffects`, if present, is `false`, and a package that ships a `bin` leaves it out.
- `repository.url` equals the root's and `repository.directory` is the package's path; `description`, `homepage` and `bugs.url` are present. Do not add a person, an email or any other contact field.
- `exports` lists only reviewed entry points: a new subpath, or a new package, is added to `PUBLIC_ENTRY_POINTS` in that script in the same review.
- The only top-level entries are `dist/`, `package.json`, `README.md`, `LICENSE` and `NOTICE`, plus a `.json`-only data directory for a package named in `DATA_DIRECTORIES` in that script (today `@seamline/security`'s `corpus/`). Add the directory to the package's `files` and to that table in the same review.
- No test, fixture, source map or TypeScript source ships, and every shipped `dist/*.js` is reachable from `main`, `exports` or `bin` through relative imports (a module that compiles to nothing is allowed). A test-support module under `src/` (a double or fixture builder that tests import) compiles into `dist/` but must not ship: add a `!dist/<file>.*` line to `files` for it, and keep it out of `index.ts`.
- Every bare import in shipped code is a declared dependency, and every `dependencies` entry is imported by shipped code. A package that only the test doubles import belongs in `devDependencies`. Static imports, `export ... from` and literal `import()` are read; `require()` and computed specifiers are not, so review those by hand.
- `NOTICE` is copied into each package from the root (`cp NOTICE packages/<name>/NOTICE`) because `pnpm pack` copies the root `LICENSE` by itself but not `NOTICE`, and Apache-2.0 section 4(d) asks redistributions to carry it. The gate fails if a copy is missing, not listed in `files`, or differs from the root file.
- A package that is not meant to be published (`@seamline/integration`) sets `"private": true`, and every private package declares no `exports`, `files` or `publishConfig`.

Reviewed by hand, not enforced: `"sideEffects": false` is only true when no module has top-level effects beyond declarations and pure builders, so check the new module's top-level statements before copying the line.

Cross-package imports use the workspace protocol: `"@seamline/ontology": "workspace:*"`, and inside the workspace they resolve through `dist/`, so run `pnpm -w exec tsc --build` before a cross-package test.

## The contract is shared and frozen

`packages/ontology/src/contract.ts` is the seam every package is written against. **Do not edit it.** If you believe it is wrong or missing something, say so in your report and work around it locally; a contract change has to be coordinated because every other package compiles against it.

## Dependencies

- Permissive licenses only: MIT, Apache-2.0, BSD-2/3, ISC, CC0, Unlicense, 0BSD, Zlib, PostgreSQL, MPL-2.0 (unmodified dependency only). This is enforced by `pnpm gate:license` and is a release gate, not a guideline.
- **Prefer the standard library.** Every runtime dependency is a supply-chain liability this project has publicly committed to minimizing.
- Adding a runtime dependency requires naming it and its license in your report.

## Determinism is a gate

Design v3 §2.3. Byte-identical output across two runs is a CI gate, so:

- **No wall-clock time in a node or edge body.** Time belongs to the `Run` record. The contract has no `createdAt` on nodes, deliberately.
- Sort before serialize: object keys sorted, arrays sorted by stable id.
- **Repo-relative POSIX paths only.** Never an absolute path, never a backslash.
- No `Math.random()`, no unseeded iteration over a `Set`/`Map` whose insertion order depends on filesystem traversal order.

## Dogfood is a gate too

Design v3 §7 ("Dogfood" row), ADR-0009 §4 gate 4. `pnpm gate:dogfood`
(`scripts/dogfood-gate.mjs`) runs `seamline extract`, `why` and `check` on
Seamline's own repository and diffs what they report against the reviewed
baseline under `docs/dogfood/baseline/`. This is a different check from the
determinism gate above: determinism asks whether two runs *today* agree with
each other (and still proves the full self-extraction is byte-reproducible);
the dogfood gate asks whether today's run still agrees with the last
*reviewed* run, so an unreviewed regression in what Seamline finds about its
own codebase fails the build instead of landing on `main` unnoticed.

The baseline is the reviewed regression surface, not a copy of the
self-extraction, so an ordinary code change does not move it:

| File | Holds |
|---|---|
| `findings.json` | what `seamline check` reports: every contradiction, every UNKNOWN, each extractor's PASS/FAIL/UNAVAILABLE status |
| `examples.sif` | the part of the self-extraction that comes from `examples/`, byte for byte |
| `code-ts-coverage.json` | the tracked TS/JS files no tsconfig project reads (`unread`), compared exactly |
| `why-orders-customer-email.json` | `seamline why orders.customer_email`, the flagship chain |

The baseline moves when what Seamline reports about itself moves: an
extractor or detector change that alters a finding, a status or the `examples/`
extraction, a change to the examples themselves, or a TS/JS file that no
tsconfig project reads being added or removed (a new `scripts/*.mjs`, for
instance). An intentional move is regenerated with
`node scripts/dogfood-gate.mjs --update` and reviewed with
`git diff -- docs/dogfood/baseline`. The gate never moves or deletes a tracked
file, the baseline included. How to land a baseline change is in
[CONTRIBUTING.md](../CONTRIBUTING.md#dogfood-baseline-changes). This is
deliberate friction on exactly the changes that most need review (ADR-0009).

## Commands

| | |
|---|---|
| install | `pnpm install` |
| build | `./node_modules/.bin/tsc --build` |
| test | `node --test 'packages/*/src/**/*.test.ts'` |
| single test file | `node --test packages/<pkg>/src/<file>.test.ts` |

Use `./node_modules/.bin/<bin>` rather than `pnpm exec` — `pnpm exec` runs a dependency-status check that spawns a subprocess and fails on this mount. `npx` resolves to npm and warns about pnpm-specific `.npmrc` keys; do not use it.
