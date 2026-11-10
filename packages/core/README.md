# @seamline/core

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

Seamline's storage, identity, merge, traversal and evidence infrastructure: the SQLite graph store, node identity and rename aliases, provenance-ordered merge, bounded traversal, the SIF snapshot format, export profiles and the extractor sandbox. A separate entry point, `@seamline/core/semantic`, holds an extensible semantic engine.

## Install

```bash
npm install @seamline/core
```

Requires Node.js 22.13 or later. Most users should not install or import this directly: `@seamline/cli` depends on it and wires it for you. Import it directly only if you are building a tool that reads or writes a Seamline store from code, or that uses the semantic engine. The store uses Node's built-in `node:sqlite`, so Node prints an `ExperimentalWarning: SQLite is an experimental feature` line on stderr when the package loads.

## Usage

Open the store that `seamline extract` wrote and read facts from it:

```js
import { SqliteStore } from '@seamline/core';

const store = new SqliteStore({ path: 'seamline-out/graph.db' });
for (const column of store.nodesByKind('Column')) {
  console.log(column.id, column.provenance, column.sensitivity);
}
const [latest] = await store.listRuns(1);
console.log(latest.runId, store.scopeStatus('data')); // the latest run, and PASS, FAIL or UNAVAILABLE
await store.close();
```

`SqliteStore` implements the `GraphView` and `GraphStore` interfaces of `@seamline/ontology`, so it can be handed to `@seamline/infer-join`, `@seamline/contradictions` and `@seamline/mcp` as it is. Without a `path` it opens an in-memory database.

## Entry points

| Import                    | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@seamline/core`          | The root export. `SqliteStore` and its errors; merge (`mergeAll`, `mergeBatches`, `mergeLifecycle`); traversal (`bfs`, `validateTraverseQuery`); SIF snapshots (`readSif`, `writeSif`, `compareSif`); export profiles (`parseExportProfile`, `getProfile`, `applyProfile`, `profileView`, and the shipped `PUBLIC_PROFILE`, `TEAM_PROFILE`, `AUDIT_PROFILE`); `wrapWithRedaction`, the store decorator that makes the redactor the sole writer; the extractor sandbox; and everything under `@seamline/core/identity`. It also re-exports the redactor and the `delimit` family of `@seamline/security`, name for name. |
| `@seamline/core/identity` | Node id construction (`makeNodeId` and one canonical-name helper per node kind, such as `columnName` and `symbolCanonicalName`) and rename aliases (`AliasTable`, `applyRenames`, `materializeAliases`).                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@seamline/core/sql`      | The shared SQL lexer (`tokenizeSql`, `splitStatements`) that the data and code extractors use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@seamline/core/semantic` | The semantic engine, described below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## The semantic engine

`@seamline/core/semantic` supplies a local, profile-based engine for typed domain objects, worlds, timelines, branches, inventory and historical state. It is separate from the code-analysis graph above and does not add extractors. See [the semantic foundation guide](https://github.com/zylver-solutions/seamline/blob/main/docs/semantic-engine.md) for supported operations, runtime limits, extension examples and compatibility rules; a runnable demo is [`examples/semantic-world/demo.mjs`](https://github.com/zylver-solutions/seamline/blob/main/examples/semantic-world/demo.mjs) in the repository.

The semantic API includes:

- `CompiledRegistry`: immutable, dependency-checked profiles, runtime schemas and reusable facets.
- `SemanticEngine`: SQLite universes/worlds/timelines, temporal state, branches, atomic commands, bounded queries, history and allowlisted export.
- `worldProfile`, `inventoryProfile`, `authoringProfile`, `softwareProfile`: ready-to-compose domain building blocks.
- `legacyCodeProfile`, `prepareLegacyImport`, `legacyScopeStatus`, `legacyIsFact`: a redacted bridge from existing code intelligence, retaining evidence and availability.

This is trusted local embedding. Applications supply authentication/authorization at their host boundary. Profile handlers are installed trusted code, not executable input accepted from a remote caller. The engine has no runtime dependency outside `@seamline/ontology` and `@seamline/security`.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0. Both the root export and `@seamline/core/semantic` are pre-1.0.

See the [repository README](https://github.com/zylver-solutions/seamline#readme) for what works today and what does not. License: Apache-2.0 ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)).
