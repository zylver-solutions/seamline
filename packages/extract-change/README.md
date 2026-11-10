# @seamline/extract-change

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

Git history facts at provenance `EXTRACTED`: commits, `TOUCHES` edges, and rename detection via `git log --find-renames` (a `git` subprocess; there is no git library dependency). `seamline extract` turns the committed file renames it reports into `Alias` nodes and `ALIAS_OF` edges, so a moved file's retired id still resolves (design v3 §2.1). No contradiction detector reads the commit facts.

## Install

```bash
npm install @seamline/extract-change
```

Requires Node.js 22.13 or later, and `git` on the `PATH`. Most users should not install or import this directly: `seamline extract` in `@seamline/cli` runs it as part of the normal pipeline. Import it directly only if you are building a tool that needs to run this extractor standalone.

## Usage

```js
import { extractChange } from '@seamline/extract-change';

const { result, nodes, edges } = extractChange({
  repoRoot: process.cwd(), // an absolute path to a git work tree
  repo: 'my-repo',
  runId: 'run-1',
  depth: 20, // commits to walk; the default is 500
});
console.log(result.status, nodes.length, edges.length);
```

It needs history to read: outside a git work tree, or in a repository with no commit, the status is `UNAVAILABLE` (never `PASS` with nothing), and `nodes` and `edges` are empty.

From `seamline.config.json`, this extractor's `options` accept `depth` (default 500 commits), `since`, `until` (default `HEAD`), `renameThreshold` (default 0.6), `detectCopies` (default true), `gitBin` and `maxBufferBytes`.

Main exports:

- `extractChange`: the extractor entry point.
- `readRenames`, `renameLedgerFrom`: rename detection and the rename ledger.
- `CHANGE_MANIFEST`, `EXTRACTOR_NAME`, `EXTRACTOR_VERSION`, `changeManifest`: the extractor manifest.
- `epochToIsoUtc`: deterministic timestamp formatting.
- `CHANGE_SCOPE`, `CHANGE_STATUSES`, `DEFAULT_DEPTH`, `DEFAULT_RENAME_THRESHOLD`, and the `ChangeExtraction`, `ChangeExtractorOptions`, `ChangeStatus`, `CommitRecord`, `FileChange`, `RangeDescriptor`, `RenameLedger`, `RenameRecord`, `SymbolResolver` types.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0.

See the [repository README](https://github.com/zylver-solutions/seamline#readme) and [design v3](https://github.com/zylver-solutions/seamline/blob/main/docs/design/v3.md). License: Apache-2.0 ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)).
