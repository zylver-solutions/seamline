# ADR-0002: Path-free natural-key identity, with aliases for renames

- **Status:** Accepted. Amended by [ADR-0016](ADR-0016-file-identity-carries-its-path.md): a `File` id carries its path, and ADR-0016 states the inputs whose change under a move or rename changes another id.
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §2.1
- **Council finding:** C3 (CONFIRMED CRITICAL), raised independently by five lenses: architect (A3), data (D3), grill-me (F2), QA (F9), devil's advocate (DA-11).
- **Corroborating prior art:** an earlier internal project reached the same identity design independently, including the same rejection of a synthetic surrogate key.
- **Contract:** `packages/ontology/src/contract.ts` (`NodeId`, `nodeId()`, `parseNodeId()`)

## Context

v2 minted node ids by embedding the file path:

```
sym:{service}:{path}#{Class}.{method}
```

There was no alias mechanism, no `SAME_AS` relation, and no rename detection anywhere in §3 or §4. One `git mv` therefore orphans every edge touching that file and duplicates every symbol in it. Everything downstream is invalidated at once: hand-written annotations, `TESTS` / `COVERS` / `TOUCHES` edges, stored queries, and all historical findings. The same defect fires a second time at any extractor swap, because two extractors resolving the same symbol through different paths mint different ids for it.

The failure has a particular sting for this project: refactoring becomes taxed by the tool whose stated purpose is making refactoring safe.

The obvious remedy, and the one most systems reach for, is a synthetic surrogate id: a UUID or ULID minted the first time a node is seen, with the natural key stored as an attribute. This organization's own earlier internal project considered exactly that and rejected it. The reasoning is specific to derived graphs and is worth stating in full, because it is counterintuitive.

**A synthetic id is only stable if the mint table is durable.** Seamline's central architectural claim is the inverse: *the registries are the truth and the graph is derived*, so the store must be deletable and rebuildable from source at any time. A ULID minted at first sight survives an incremental update and does not survive `rm -rf seamline-out && seamline extract`. Two rebuilds of the same commit would produce two different graphs, which breaks byte-reproducibility (ADR-0009), breaks `seamline diff`, and makes golden-file testing impossible. Keeping the ids stable would require persisting and versioning the mint table, which is a durable, non-derivable database, which is the CMDB-rot failure mode the design exists to avoid.

## Decision

**A node id is a path-free natural key: `{repo}:{kind}:{canonicalName}`. There is no synthetic id.**

1. `path` is a **property of the node, never part of its identity.** It is stored on the node and additionally as `srcFile` / `dstFile` on every edge, because the re-run invalidation rule needs to find every edge whose source or destination file changed.
2. The natural key differs per kind, and each is chosen to be reproducible from source alone:
   - symbol: `(repo, canonical_qualified_name)`, resolved **through re-exports and barrels to the declaration site** using the TypeScript type checker (ts-morph). Resolving to the import site rather than the declaration site would make identity depend on which file happened to be scanned, which is a path dependency wearing a different name.
   - column: `(datasource, schema, table, column)`.
   - schema property: `(contract, json_pointer)`.
3. **Renames are handled by aliasing, not by id churn.** A rename pass consumes `git diff -M` rename detection plus content hashes. When a canonical qualified name changes, an `ALIAS_OF` row records old to new and history is preserved across the rename. `Alias` is a first-class node kind; `RENAMED_FROM` carries `File → File` and `Symbol → Symbol`.
4. `nodeId()` rejects a `repo` containing `:` so that `parseNodeId` is a total inverse. `canonicalName` may contain `:`; the parser splits on the first two separators only.

**Conformance gate (CI, not guidance):** `git mv` a file, re-extract, assert every node id and every edge is unchanged.

## Consequences

### Positive

- **Rebuild-from-scratch is exact.** Delete the store, re-run, get byte-identical output. This is what makes ADR-0009's determinism gate achievable at all, and it is what makes the store genuinely disposable.
- Ids are human-readable, greppable, and diffable. A failing test that prints a node id tells a maintainer what the node is without a lookup. This matters disproportionately for a tool whose output humans and agents both read.
- Two independent extractors that resolve the same symbol agree on its id by construction, because the id is a function of the symbol, not of the observation. Merge (ADR-0007) can therefore be a pure function of its inputs.
- A rename preserves history without a migration: the alias row is data, not a schema change.

### Negative

- **Ids are long and can be unwieldy**, particularly for deeply nested schema properties addressed by JSON pointer. This is a real ergonomic cost against surrogate keys, and it shows up in index size on the SQLite and Postgres stores.
- **A natural key can collide** where the underlying language permits two declarations to share a canonical name (declaration merging, overloads, conditional exports). Each such case needs an explicit, documented disambiguation rule, and getting one wrong silently merges two distinct nodes. This is strictly harder than a surrogate key, where collision is impossible by construction.
- **Renames are detected heuristically**, because git's own rename detection is a similarity heuristic. A rename combined with a heavy edit can fall below the similarity threshold and be recorded as delete-plus-create, losing the alias link. The graph stays correct (the old node is tombstoned, the new one exists); the *history* across that rename is what is lost.
- A change to a canonical-name rule is a change to every id it produces, so such changes are ontology-breaking and require a major version (see `ontology/README.md`).

## Alternatives considered

**Synthetic UUID/ULID with the natural key as an attribute.** Rejected: stated at length above. An id minted at first sight is not stable across rebuild-from-scratch, and rebuild-from-scratch is the operation the whole design rests on. An earlier internal project's review reached this same conclusion independently.

**Content-addressed ids (hash of the declaration's source text).** Rejected: every whitespace edit changes the id. This is the C3 failure with a smaller trigger, not a fix for it. It also destroys the property that a maintainer can read an id.

**Keep path in the id and add a rename-migration pass that rewrites ids.** Rejected: the rewrite is a stateful migration over persisted data, so it cannot run on a fresh rebuild, so the two paths (incremental and from-scratch) produce different graphs. It also requires the graph to be durable, contradicting "registries are truth, the graph is derived".

**Path in the id, plus `SAME_AS` edges to stitch renames.** Rejected: it merely postpones the cost. Every consumer (every detector, every traversal, every export) must then transitively close `SAME_AS` before it can answer any question correctly, and any consumer that forgets is silently wrong. Correctness by construction beats correctness by universal remembering.
