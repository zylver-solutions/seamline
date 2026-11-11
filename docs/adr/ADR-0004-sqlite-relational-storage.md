# ADR-0004: SQLite and a relational schema; no graph database

- **Status:** Accepted
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §3
- **Council finding:** C4 (CONFIRMED CRITICAL), raised independently by five lenses: architect (A6), data (D4/D5/D6), grill-me (F3), devil's advocate (DA-12), DevEx (S-1). Reconciled with the licensing lens's Round-1 correction; see below.
- **Corroborating prior art:** an earlier internal project reached the same store and traversal-bound decisions independently. That project is not published, so a reader cannot check this; it is context, and the decision does not rest on it (see the note in the [index](README.md)).
- **Contract:** `packages/ontology/src/contract.ts` (`GraphStore`, `TraverseQuery`)
- **Status of implementation (2026-11-10):** as of release 0.1.0 the one store is SQLite on `node:sqlite` (`packages/core/src/store/sqlite-store.ts`), with typed bounded traversal (`packages/core/src/store/traverse.ts`) and no query language (Decision items 1, 2, 5 and 7). Three parts of the Decision are not implemented. (a) Item 1 says the schema is generated from `ontology/seamline.yaml`: the DDL in `packages/core/src/store/schema.ts` is generated from the `NODE_KINDS`, `EDGE_KINDS`, `PROVENANCE` and `SENSITIVITY` arrays in `packages/ontology/src/contract.ts`, and no code reads the YAML at run time; `ontology/lint.mjs` keeps those arrays equal to the YAML, which is how the two stay in step. (b) Item 3: there is no `graphology` dependency and no in-memory projection; no PageRank or community-detection workload is implemented. (c) Items 4 and 6: there is no Postgres adapter, so there is no second store and no parity suite to run; the "two adapters" cost under Consequences is not being paid. Items 3, 4 and 6 record intent only.

## Context

v2 specified four storage adapters behind one interface, with an embedded graph database as the default. The council found four independent problems, any one of which is disqualifying.

**The interface was not implementable on its own adapters.** `GraphStore.cypher` cannot be implemented on two of the four named backends: `graphology` has no query language, and Apache AGE requires a static `AS (col type, ...)` column list per query, so it cannot accept an arbitrary Cypher string through a uniform signature. Between AGE and an embedded engine, openCypher coverage diverges enough (MERGE idempotency, agtype coercion, variable-length path syntax) that identical output across adapters is not achievable. That is not an adapter; that is a dialect-compatibility project, taken on as a side effect of a storage choice.

**The default store carried an undisclosed continuity risk.** Two lenses returned partially conflicting evidence about LadybugDB and the reconciled position is worth recording precisely, because the weaker version of the finding is still disqualifying:

- The architect lens reported that `ladybugdb` returns 404 on npm under five name variants and inferred that the project does not exist. That inference was **wrong** and the licensing lens corrected it with direct evidence.
- The project **is** real and **is** MIT (`LadybugDB/ladybug`, ~1,685 stars, v0.20.0 released 2026-08-29, actively worked on).
- It is nonetheless an 11-month-old fork of **Kuzu, which was archived 2025-10-10** when Apple acqui-hired the Kuzu team. Its apparent contributor list is inherited git history from before the fork; those people work at Apple now. Commits since 2026-06-01: 19 from a single contributor, 1 each from two others, and all releases published by that same contributor. **Bus factor 1.** It is pre-1.0, and **three competing MIT forks are contesting the Kuzu succession.**
- v2's specific claim that it offers **"Bolt server mode" is false.** The documentation describes embedded-only operation, and upstream Kuzu never had Bolt either. That single false claim orphans v2's entire `bolt` adapter.

**No workload in the design justified a graph database.** This is the finding that decides the ADR rather than merely rejecting one product. All 24 of v2's lenses are bounded-hop traversals. The single unbounded-traversal workload (community detection and PageRank) already routed around the primary store by v2's own §7 plan, exporting to graphology. So the graph store was carrying zero workloads that a relational store with a recursive CTE cannot carry.

**Arbitrary query execution was a security finding, not just a design smell.** On the Postgres/AGE adapter, `cypher` is arbitrary query execution _inside the database_. See ADR-0006 and finding C5/S2.

## Decision

**v0.1 ships one store: SQLite with a relational schema generated from the ontology. There is no graph database, and there is no query language in the store interface.**

1. **Default store: SQLite, via `node:sqlite`.** Nodes and edges are ordinary tables; the schema is generated from `ontology/seamline.yaml`, so ontology and DDL cannot drift. Bounded traversal is a recursive CTE with a depth cap, a `statement_timeout` equivalent, and a result cap.
2. **`node:sqlite`, not `better-sqlite3`,** which refines v3 §3's parenthetical. `better-sqlite3` is a native module: it needs a prebuild download or a local compile in a `postinstall` script. `docs/toolchain.md` records that postinstall-driven binary installation on this project's development mount does not error but **hangs**, which is a worse failure than an error. Independently, this project has publicly committed to minimizing supply-chain surface (v3 §2.7, §10), and a store that is part of the Node runtime has no supply-chain surface at all. Standard library over dependency is the stated house rule; here it also happens to be the faster path to a working install.
3. **`graphology` (MIT), in memory, for algorithm workloads** (PageRank, community detection). This is not a second store: it is a projection built on demand and thrown away. v2 already planned this; v3 keeps it and stops pretending the primary store was doing that work.
4. **A Postgres adapter is the Zylver-internal deployment target.** Same generated schema, same traversal API, `org_id NOT NULL` plus `FORCE ROW LEVEL SECURITY` from the first migration, and **no new Postgres extension**. This satisfies the platform's Postgres-only rule without adding a datastore, and it removes the `CREATE EXTENSION` that AGE would have required. An earlier internal project reached the same row-level-security shape independently, under an earlier tenancy-column name since superseded on the platform; copy the RLS _shape_, not any specific column name from it.
5. **`cypher` is removed from the store interface entirely.** What replaces it is a typed traversal API (`TraverseQuery`) whose depth is bounded by construction. See ADR-0006.
6. **Parity rule:** two stores are "supported" only when both pass the identical traversal conformance suite. Adapter-compatible is not dialect-compatible, and the difference is exactly what C4 is about.
7. **Dropped from v0.1:** LadybugDB, Apache AGE, Kuzu, and Bolt (the mode does not exist). Each may return as an adapter when a named consumer requires it and it passes the parity suite.

## Consequences

### Positive

- Zero runtime dependencies for the default store. No native build, no prebuild download, no postinstall script, no CVE surface, nothing to audit at release time.
- Embedded means no listener and no default network surface. The council explicitly confirmed that an embedded default is _not_ a network-exposure finding; exposure only appeared in v2's opt-in server modes, whose auth and TLS were unspecified.
- SQLite is the most widely deployed and most thoroughly tested database in existence. For a single-maintainer project, "boring" is a load-bearing property, not an aesthetic one.
- Generating the DDL from the ontology makes ADR-0001's "one source of truth for the vocabulary" real in the storage layer as well.
- Dropping the graph store also drops the Cypher dialect-compatibility project and the `CREATE EXTENSION` that the platform forbids. One decision, three problems removed.

### Negative

- **`node:sqlite` is not yet a stable Node API.** On Node 24.12 it imports without a flag but emits `ExperimentalWarning: SQLite is an experimental feature and might change at any time`. Two real costs follow: the warning is visible to users unless suppressed, and the API may change under us within the support window. We accept this because the API surface we use (`DatabaseSync`, `StatementSync`) is small, and because a breaking change there is a contained, mechanical fix, whereas a native-module supply chain is a permanent tax. It does mean the `engines.node` floor will need raising when the store package lands, and that floor should be chosen against the first release where `node:sqlite` is available unflagged, not against the floor of `>=22.11` that applied when this was written (the root `package.json` now declares `>=22.13.0`).
- **Deep or unbounded traversal is genuinely worse than on a graph engine.** Recursive CTEs are fine to a handful of hops and degrade beyond that. The design mitigates this by making every query bounded-hop by construction, which is a real constraint on what Seamline will ever be able to answer directly from the store.
- Pattern-matching queries that Cypher expresses in one readable line become multi-CTE SQL. That cost lands on maintainers, not users, because users never write the SQL.
- **Two adapters, one conformance suite, forever.** SQLite and Postgres differ in type affinity, `RETURNING` behaviour, and recursive-CTE performance characteristics. The parity rule is the control, and running it on every change is a standing cost.
- Some evaluators will read "no graph database" as unserious, since the category is "graph tooling". That is an accepted positioning cost.

## Alternatives considered

**LadybugDB as the default, per v2.** Rejected on continuity, not on licence: bus factor 1, pre-1.0, an 11-month-old fork of an archived database, three forks contesting the succession, and a false capability claim in v2's own description of it. A single-maintainer project cannot afford a single-maintainer dependency at the storage layer.

**Apache AGE.** Rejected, although it was the licensing lens's recommendation as the safer _graph_ default, and that recommendation is correct given the premise that a graph store is needed. v3 rejects the premise instead, which is the cheaper answer to the same problem. AGE additionally requires `CREATE EXTENSION`, which this project's platform-deployment rules forbid, and its per-query static column list is one half of why the v2 interface was unimplementable.

**Neo4j.** Rejected: the server is GPL/commercial, which collides with the permissive-only distribution policy in ADR-0010, and the whole point of an embeddable tool is that adopters do not stand up a database to use it.

**Keep the four-adapter interface and make `cypher` optional.** Rejected: an interface method that only some implementations support is not an interface. Every consumer then branches on adapter identity, and the abstraction has negative value.

**A plain JSON or JSONL file as the store.** Rejected: finding H7 measured this. At roughly 5M edges a committed JSONL graph is about 1 GB regenerated per commit, and union-merging a derived artifact is meaningless anyway. Canonical SIF remains the _interchange_ format (ADR-0009); it is not the store.
