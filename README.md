# Seamline
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The only recorded measurement is the hardened development measurement recorded 2026-10-26 ([`docs/evaluation/dev-hardened-draft.md`](docs/evaluation/dev-hardened-draft.md)). It was made on a draft source tree, not on the code you install, and not on a sealed partition. On it Seamline produced zero findings and detected 0 of 11 injected mutants (five missed, six UNKNOWN), so precision and Wilson bounds are undefined at n=0. All ten detectors are dormant on that measured scope, and X3 and X10 have no shipped producer facts. No passing sealed evaluation exists; it is deferred to 0.2.0. A quiet run is not evidence that your repository is clean. Details are under [what works today](#what-works-today-and-what-does-not).

**Seamline is designed to join your database columns, API schemas, and TypeScript types into one graph and to report where they disagree.** On the one recorded measurement it reported nothing at all, and several of its checks report UNKNOWN rather than a result.

A seamline is the line along which two overlapping datasets are merged into a single mosaic. That is the intended job: your schema, your contracts, and your code each describe the same fields, and nothing checks that the three descriptions agree. Seamline extracts the facts and infers the joins between them, and its detectors are designed to report the disagreements.

No annotations. No YAML to hand-write. No decorators to sprinkle. You run it on a repository you did not write and it produces a graph on the first run. Whether any detector can report a disagreement on your repository is a separate question; see the notice above.

**Extensible semantic foundation:** `@seamline/core/semantic` now also supplies a local, profile-based engine for typed domain objects, worlds, timelines, branches, inventory and historical state. The existing code-analysis CLI stays compatible. See the [library guide](docs/semantic-engine.md) for implemented building blocks, a runnable extension example and explicit limits; this is not a claim of new automatic extractors for every domain.

- **License:** Apache-2.0 (code), CC-BY-4.0 (ontology and specification text)
- **Contributions:** DCO sign-off, no CLA. See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Status:** early release. On the one recorded measurement it found nothing. [What works today](#what-works-today-and-what-does-not) is stated plainly below, and the list is short.

---

## The ten-minute path

```bash
npm install -g @seamline/cli     # or: pnpm add -g @seamline/cli
cd your-repo
seamline init && seamline extract && seamline why shipped_at
```

Seamline needs Node.js 22.13 or later. Commands that access SQLite may emit an `ExperimentalWarning: SQLite is an experimental feature` line on stderr, because the graph store uses Node's built-in `node:sqlite`; it is expected and does not mean anything failed.

`init` writes `seamline.config.json` and adds `seamline-out/` to your `.gitignore`. That second part is not housekeeping: the graph is a concentrated map of your attack surface, and it is never committed by default. See [THREATMODEL.md](THREATMODEL.md).

`extract` writes the graph store to `seamline-out/` (the config's `outDir`) and every other command reads it from there. To keep or read a store elsewhere, pass `--store <dir>` to `extract` and to whichever command reads it, for example `seamline extract --store ci/graph`, then the same `--store ci/graph` on the command that reads it. See [`packages/cli`](packages/cli/README.md#selecting-the-store).

The transcript below comes from the checked-in fictional fixture [`examples/harbor-books`](examples/harbor-books). This run selected the four non-history extractors, with deterministic output enabled. No real system is described here.

### `seamline extract`

```text
run run-det-e41143c60e9d9f87  repo harbor-books

PASS        extract-code-ts         9 nodes     10 edges      0ms
PASS        extract-data            9 nodes     13 edges      0ms
PASS        extract-contracts       6 nodes      5 edges      0ms
PASS        infer-join              0 nodes      5 edges      0ms

total  24 nodes, 33 edges
```

Every selected extractor reports PASS, which means its authoritative scope was read. That does not establish the value roles needed by every detector. A failed or unavailable scope and an unobserved comparison are reported as UNKNOWN.

### `seamline why shipped_at`

```text
public.orders.shipped_at  Column
  in       Table orders
  at       db/migrations/0014_orders_shipping.sql
  fact     EXTRACTED conf 1.00  sensitivity confidential

LINEAGE  1 chain(s)

  chain 1  confidence 0.90  weakest INFERRED
    Column          public.orders.shipped_at
      -> MAPS_TO_FIELD    CodeField       <root>#Order.shippedAt
         INFERRED      conf 0.90

CONTRADICTIONS  none found, but not every detector could run
2 detector(s) could not run: X1_NULLABILITY, X2_TYPE. Those checks are UNKNOWN, not clean.
  X1_NULLABILITY  VALUE_ROLE_UNOBSERVED: no joined response property states comparable nullability; generic code shapes and request properties do not prove a stored-row or insert obligation
  X2_TYPE  VALUE_ROLE_UNOBSERVED: no joined column and contract property state comparable types; generic code shapes do not prove a stored-row or insert role
```

The column and model field retain one lineage chain. `Order` and `OrderResponse` are different container names; their shared affix does not establish a mapping. The standalone schema remains extracted, and its name proves neither a response role nor a stored-value join. X1 and X2 therefore report UNKNOWN here. The former X1 demo finding was unsupported and has been retired.

`seamline check` reads the store that `seamline extract` wrote, so run `extract` first; without a store it has nothing to read. On this fixture it reports the same two UNKNOWNs with no contradictions and exit 0. That exit code is not evidence that every detector validated the repository, and `check` is not a verified gate (see the notice at the top). Mechanically, a critical or high finding produces exit 1; the response-source regression test in [`precision-response.test.ts`](packages/integration/src/precision-response.test.ts) proves a supported X1 comparison through extraction, inferred joins and the real store.

---

## Gaps and contradictions, and why the difference is the whole product

Most tools in this space report **gaps**: places where you failed to declare something. Seamline reports **contradictions**: places where two things you already wrote disagree.

|                       | Gap                               | Contradiction                                |
| --------------------- | --------------------------------- | -------------------------------------------- |
| Says                  | "you failed to declare something" | "two things you already wrote disagree"      |
| Input                 | the absence of a declared edge    | two extracted, authoritative facts           |
| Count on a fresh repo | thousands (estimated)             | by design, only disagreements between facts  |
| The fix               | write an annotation               | change the code, the schema, or the contract |
| Can you game it?      | yes, by writing the annotation    | an annotation does not clear one             |

A gap is a complaint about documentation. A contradiction is a bug.

This is not a stylistic preference. An earlier design of this project was built on gaps, and an [adversarial review](docs/audit/2026-08-29-council-review-v2.md) established that it would have produced an estimated 3,000 to 4,500 findings on a modest repository on day one, almost all of them at error severity, every one fixable by writing a comment. A gate that is permanently red is a gate that gets switched off in week one. Seamline v0.1 ships contradictions and defers gaps.

The same reasoning applies to how Seamline verifies itself. A check that asserts a link _exists_ is not evidence that anything was verified; a check must compare authoritative facts. Seamline holds its own test suite to that standard.

### The contradiction catalog

Every detector names the two authoritative facts it compares, and every detector carries a fixture pair proving it can both fire and not fire.

| Code | Contradiction                                                                           | Severity |
| ---- | --------------------------------------------------------------------------------------- | -------- |
| X1   | Nullability disagreement between a column and its joined response property | high     |
| X2   | Type disagreement across a join                                                         | high     |
| X3   | Width or constraint disagreement between a column and its validator                     | medium   |
| X4   | Response property backed by no column and no computing symbol                           | medium   |
| X5   | NOT NULL column with no default the writers supply that no traced insert writes         | medium   |
| X6   | PII-bearing column reachable from an operation with no declared auth                    | critical |
| X7   | A source-proved validated request string has no upper bound for finite-length storage | high |
| X8   | Migration referencing a table or column that no longer exists                           | low      |
| X9   | Contract drift: an operation with no handler, or a handler implementing no operation    | high     |
| X10  | A symbol that writes a PII column with no test or coverage intersecting it              | medium   |

Each code has a page covering what it compares, when it fires and when it must not, its controls, a minimal example from its fixture pair, and its current status: [`docs/contradictions`](docs/contradictions/README.md).

X3 and X10 need facts no shipped extractor supplies. X8 has authored declared-DDL extraction proof, with complete non-self-authored acceptance and independent qualification still pending. X7 has a bounded validated-write producer, but later hardening returns UNKNOWN on its measured real parent. Its earlier five-to-zero reproduction is historical; current real-source acceptance and independent precision remain unmet. X5 evaluates complete raw-insert facts but remains dormant on its measured unmodified corpus. X4 and X9 cover only part of their catalog descriptions. Each limit is listed under [what does not work](#what-works-today-and-what-does-not).

---

## How the join works

Seamline extracts facts and then infers the joins between them. Every edge is tagged with where it came from:

- `EXTRACTED` is a fact read directly out of your source. A column exists because the DDL says so.
- `INFERRED` is Seamline's own reasoning, with a heuristic confidence score. `orders.shipped_at` maps to `Order.shippedAt` because the names normalise to the same token sequence and the types are compatible.
- `DECLARED` is something a human asserted.
- `LLM_SUGGESTED` is something an agent proposed.

These have a total precedence order (`EXTRACTED > DECLARED > INFERRED > LLM_SUGGESTED`), so merging is deterministic regardless of the order the inputs arrive in. Inferences and suggestions live in a separate, insert-only table and never mutate the facts. **Contradiction detection reads facts only**: an inference can point you at a lineage chain, but it can never fail your build.

Two more properties fall out of the design and are worth knowing before you adopt it:

- **Identity survives a rename.** A node id is a path-free natural key for every kind except `File`, so a `git mv` changes no id but the `File`'s, unless it changes an input that the id is built from ([ADR-0016](docs/adr/ADR-0016-file-identity-carries-its-path.md) item 4 lists the inputs). A `File` is the one kind whose canonical name is its repo-relative path, so a moved file gets a new id; when git reports a committed rename (by default at least 60% similar and within the last 500 commits, with `extract-change` enabled), Seamline records an alias from the old id to the new one. Everywhere else, paths are properties, not identity.
- **Extraction is byte-reproducible.** Two runs over the same tree produce byte-identical output, enforced in CI by `scripts/determinism-gate.mjs`. No wall-clock timestamps in a fact, no absolute paths, sorted keys. Without this, snapshot diffing is meaningless.

---

## Documents against code: `seamline align`

A repository says things about itself in Markdown: which Node it needs, which formats the CLI prints, which detectors work, which controls are enforced. `seamline align` reads a closed set of such claims out of the tracked documents (structural anchors and whole-sentence templates, no model) and compares each with a fact from Seamline's own extraction of the same commit, or from a `package.json`. Each comparison ends in one of five classes: Observed drift, Unexplained gap, Planned gap, Unknown, or Resolved against a baseline packet you supply. A failed or unsupported extraction is Unknown and is never read as absence.

```
seamline extract --only extract-code-ts --only extract-data --only extract-contracts --only infer-join
seamline align --facts seamline-out/runs/<run>.sif                          # a summary
seamline align --facts <run>.sif --profile alignment --packet align.json         # the finding packet
seamline align --facts <run>.sif --baseline align.json                       # Resolved records
```

- **It never gates.** `seamline align` exits 0 whenever it produced a report, whatever the report holds. No flag, environment variable or configuration key makes drift fail, and `seamline check` is unchanged.
- **The packet is export-gated.** Without `--profile` it prints a summary of class counts and per-finding ids. The finding packet (schema version 1, redacted, with stable ids and run provenance) is written only through an export profile that names `"packets": ["alignment"]` and whose `allow` lists `["File", "internal"]` and `["Symbol", "internal"]` (the packet names files by path and can name symbols).
- **The pairing is stated.** A SIF carries no commit, so the file you pass with `--facts` is paired with `--at` by you, and the packet says `asserted`, not `verified`.
- **What it checks** is four kinds of claim: a runtime floor, the output formats of the CLI, whether a contradiction detector works at the level of node kinds, and whether a control row names code that something imports. **What it does not check** is code that no document mentions, severities, descriptions, counts, links, other declared entities such as `ontology/seamline.yaml`, or anything outside Markdown. Prose it cannot match yields no claim, so silence is the failure mode and a guess never is.

The design is [`docs/design/alignment.md`](docs/design/alignment.md); the decision and its limits are [ADR-0014](docs/adr/ADR-0014-alignment-drift-classes-and-finding-packet.md).

---

## What works today, and what does not

This section is deliberately blunt. An earlier version of this design claimed considerably more than it could do, and the review that followed said so in detail. Nothing below is a roadmap promise.

**Implemented, or in active development for v0.1:**

- Three source extractors: **TypeScript/JavaScript** (via ts-morph, type-checker-backed, resolving through re-exports and barrels), **data** (SQL DDL, Drizzle and Prisma schema files, migration files), and **contracts** (OpenAPI, JSON Schema, Zod).
- A git change extractor for commits, touched files, and rename detection.
- One inference pass (`infer-join`) that produces the cross-domain field joins.
- The ten contradiction detectors in the catalog above. X3 and X10 lack real producer facts. X7 has historical development proof; hardened real-source acceptance remains unmet. X8 has authored replay extraction proof; complete external acceptance remains unmet.
- CLI: `init`, `extract`, `why`, `check`, `export`, `diff`. JSON output on every command.
- Storage: embedded SQLite. One store, no listener, no network surface by default.

**Not implemented, and not scheduled without a named user asking for it:**

- **No web viewer.** The CLI prints human-readable text, and `--json` switches a command to machine-readable JSON (`export` always writes JSON, and `mcp` speaks the MCP protocol on stdout). CSV and Mermaid output are not implemented.
- **No live database introspection.** The data extractor reads static files: DDL, schema definitions, migrations. It does not connect to your database. It never reads Terraform state or plan files either.
- **Code support is TypeScript and JavaScript only.** No Python, Go, Java, Ruby, or Rust. Language support is not a small increment here: the join quality depends on type-checker-backed resolution, and a regex-grade parser would produce confident nonsense.
- **No lenses, no diagram gallery, no scorecards, no readiness matrix.** These existed in an earlier design and were cut.
- **No Neo4j, Kuzu, or graph-database adapter.** Every traversal in the design is bounded-hop and does not justify one.
- **No hosted service.** There is no server component and no telemetry. Seamline makes no network calls.
- **Domain modelling is optional and declaration-only.** The graph works without it.
- **`blast-radius` without `--ids` can list a file as changed that is not.** Seamline never lets a repository's own git settings run a program, so a clean filter (Git LFS, a line-ending converter) does not run, and a file such a filter would have normalised shows as modified. That widens the blast radius and never narrows it. If git is refused for a repository (its config defines a filter, diff or merge driver whose name cannot be passed to git on a command line, or more than 512 of them), the command stops with an error and a non-zero exit instead of reporting a clean tree. See [THREATMODEL.md](THREATMODEL.md).
- **X5 (unexposed required column) is conservative by design.** It fires on a `NOT NULL` column with no default the writers supply when no traced `INSERT` names it, for example a Prisma `@updatedAt` column (a client-side default that a raw insert does not receive) omitted by a raw `INSERT INTO t (a, b) VALUES (...)`. It is UNKNOWN for a whole repository when an extractor records a write it could not attribute (`untracedWriteCalls`), a write hook, embedded runtime DDL, or dynamic DDL, and it withholds, with a note, a table with a `BEFORE INSERT` trigger, more than one declaring source file, an insert whose column list is not fully known, or a writer the extractor could not turn into an edge. `check` prints the withheld tables under "NOT EVALUATED" so they never read as clean. The guards are lexical and do not establish every aliased delegate or concatenated statement, so a finding means "no traced insert supplies it", not "no insert does". The earlier pinned development findings were adjudicated as three false positives because runtime schema setup can supply database defaults. The runtime-DDL guard now withholds that conclusion. The development evaluation below reports UNKNOWN on all five pinned checkouts and no observed X5 firing; authored extraction fixtures remain its firing evidence. X5 is dormant on that measured scope, and its precision is unmeasured (see [design 8.1](docs/design/real-world-inputs.md)).
- **X1 and X2 have limited value-role evidence.** X1 compares only stated response nullability. X1 and X2 withhold generic code-field comparisons because no shipped fact establishes a stored-row or insert role. These are coverage limits, not evidence that those values agree. [Details](docs/design/precision-boundaries.md).
- **X3 (constraint disagreement) does not fire on real repositories yet.** It reads validator Symbol constraint props that no shipped extractor emits. SchemaProperty constraints do not feed its current traversal.
- **X7 covers one bounded source relationship.** It compares a positively unbounded request string with finite storage through a complete validated write binding. Its [five-to-zero DEV result](docs/evaluation/x7-parent-fix.md) is historical. [Later hardened candidates](docs/evaluation/x7-hardening-refusals.md) return UNKNOWN on that parent, so current real-source acceptance remains unmet and X7 is dormant on the measured hardened case. Other dimensions, general ORM lineage and independent qualification remain unsupported.
- **X8 (orphaned migration) has authored extraction proof; non-self-authored acceptance is pending.** It compares a checked reference with its group-local declared table/column state at a migration statement, using a live creation witness and current replay certificate. Supported Supabase ordering requires parsed project configuration. Unsupported order, unread inputs or incomplete replay withhold the affected claim; a non-PASS data scope blocks detection. The old target-property and tombstoned-edge routes are removed. Authored extraction and SQLite controls establish capability, while the complete named parent/fix CLI acceptance, external precision, calibration and formal recall remain pending. X8 stays dormant for evaluation until that acceptance ([details](docs/contradictions/X8.md)).
- **X9 (contract drift) detects only one of its two directions.** It reports a route the code serves that the contract does not declare. It does not yet report a declared operation that no code serves, because `extract-contracts` records an implementation for every operation it reads, so every operation looks served.
- **X4 (unbacked response property) sees only some response shapes.** A property counts as part of a response only when its schema sits under a `responses` entry; a response schema reached through `$ref` carries no direction, so X4 does not evaluate it.
- **X10 (untested PII write path) does not fire on real repositories yet.** Its verification half reads `TESTS` edges from `TestCase` nodes and `COVERS` edges from `CoverageRecord` nodes, and no shipped extractor emits any of those four kinds (`docs/design/v3.md` §9 defers the verification extractor). The other half exists today: `extract-code-ts` records a write in a SQL string literal as a `QUERIES` edge, and `extract-data` labels the PII column. The detector also reports nothing when the graph holds no `TestCase` or `CoverageRecord` at all, because a repository with no test facts has an absent test suite, not an untested PII path. So it stays silent on every repository extracted today, rather than reporting every PII write as untested. Extracting test cases and coverage is a real extraction capability, not a bug fix, and needs its own design-spec pass before it's built.
- **A table can be tombstoned while an unread file still declares it.** When a run does not read every schema file, `extract-data` protects a table only if the file of its last defining statement is unread. A table whose last defining file was read, and no longer declares it, is tombstoned even if an unread file still declares or alters it. The store keeps one path per node, so the extractor cannot test the other files. The run reads the table as removed; a later run that reads every file is expected to restore it, with no guaranteed deadline. A [design proposal](docs/design/extract-data-contributing-files.md) exists; nothing is implemented.
- **A dependency with a moderate advisory ships at runtime.** `@seamline/extract-code-ts` pulls in `minimatch@10.2.6` through `ts-morph` 28.0.0 and `@ts-morph/common` 0.29.0. It is affected by GHSA-g3hv-75wg-m249 (CVE-2026-118764, affected `>=7.0.0 <11.0.1`, patched `>=11.0.1`), a denial of service in pattern preprocessing that needs `optimizationLevel >= 2`. `@ts-morph/common` passes no options, so the default configuration does not trigger it, and no `ts-morph` release yet accepts the patched version. Details are in [SECURITY.md](SECURITY.md#known-dependency-advisories).

The historical [X7 parent/fix reproduction](docs/evaluation/x7-parent-fix.md) and [later hardening refusals](docs/evaluation/x7-hardening-refusals.md) are separate from the measurement below. None replaces another report or its missed-mutant denominator.

### Measured development coverage

The one recorded measurement is the hardened development measurement recorded 2026-10-26: [`docs/evaluation/dev-hardened-draft.md`](docs/evaluation/dev-hardened-draft.md), with a [machine-readable summary](docs/evaluation/dev-hardened-draft.json). It was made on a draft source tree, not on the code you install, and no sealed source was analysed. It reports zero findings and 0 of 11 mutant detections (five missed, six UNKNOWN, all retained in the denominator). Precision and Wilson bounds are undefined at n=0, and all ten detectors are dormant on that measured non-self corpus. The record lists, for each detector, its UNKNOWN pins and the reason it was dormant.

Confidence calibration has zero labelled groups and no estimable bands. Independent-review metadata is missing. The sealed release bar remains at least 30 independently labelled clusters, precision at least 0.90 and a 95% Wilson lower bound at least 0.75, with the existing per-detector checks. This measurement establishes none of those requirements and is not release or sealed qualification evidence.

If your repository is not TypeScript, Seamline has close to nothing to say to you today. That is a real limitation, not a phrasing choice.

---

## Security posture in one paragraph

The artifact Seamline produces is, in one queryable file, a map of your attack surface: every entry point, every endpoint's auth mode including the missing ones, every secret reference and the function that reads it, every IAM role, the under-tested high-risk paths, and the ownership map. Aggregation makes the whole strictly more sensitive than any part. So: `seamline-out/` is gitignored by `init`; every node carries a sensitivity level defaulted per kind; **export is default-deny** and refuses to run without a named allow-list profile; a redactor is the sole writer to the store and replaces matched secrets with references rather than values; extractors run under a capability manifest with a scrubbed environment and no network; and text that came from a third party (dependency metadata, commit messages, issue text, code comments) is tagged `untrusted` and delimited when it is served into an agent's context.

The redactor and the delimiting of untrusted text live in [`@seamline/security`](packages/security/README.md), together with a public corpus of canary secrets and injection payloads that both are tested against; contributions to the corpus are welcome.

If you are writing an extractor of your own, `npx seamline conformance ./my-extractor.mjs` checks it against these controls on generated fixtures; see [docs/conformance.md](docs/conformance.md), which also says what a pass does not promise.

The full analysis, including the residual risks that are **not** mitigated in this version, is in [THREATMODEL.md](THREATMODEL.md). Report vulnerabilities per [SECURITY.md](SECURITY.md).

---

## Using Seamline from an agent

Seamline ships an MCP server (`@seamline/mcp`). In v0.1 it is stdio-only, exposes parameterized tools only, and has **no raw query tool**: there is no endpoint that accepts a query language, because that is arbitrary code execution wearing a friendly name. Traversal depth is bounded by construction and results are capped.

Serve an extracted repository with `seamline mcp --profile <name>` (after `seamline extract`), and point your MCP client at that command. The profile is required: like export, the server is default-deny, and every tool is evaluated inside the named profile, so a node the profile withholds is never returned, counted, or used as a hop. A profile is the same thing for `export` and `mcp`: one format, either a shipped profile (`public`, `team`, `audit`) or one you declare under `exportProfiles` in `seamline.config.json`. See [the export profile design](docs/design/export-profile.md) and its [JSON Schema](docs/reference/export-profile.schema.json). `--audit` logs one JSON line per tool call to stderr. `--store <dir>` serves a store other than the config's `outDir`.

`context` and `impact` take a `tokenBudget` to fit an answer to a context budget (an estimate, not a tokenizer count), and `impact` with `targets: "tests"` returns the tests a change reaches, justified by extracted facts only. When no test facts were extracted the answer is UNKNOWN, never "no affected tests". See [`packages/mcp/README.md`](packages/mcp/README.md).

---

## Documentation

|                                                                                            |                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/design/v3.md`](docs/design/v3.md)                                                   | The authoritative design. Invariants, ontology, contradiction catalog, license policy.                                                                                                 |
| [`docs/audit/2026-08-29-council-review-v2.md`](docs/audit/2026-08-29-council-review-v2.md) | The nine-lens adversarial review that blocked the previous design and forced this one. Read it before proposing a large feature; it is the record of what was already argued and lost. |
| [`docs/design/alignment.md`](docs/design/alignment.md) | The alignment report: drift classes, the four claim kinds, their probes, and the finding packet. Decided in ADR-0014. |
| [`docs/contradictions`](docs/contradictions/README.md) | One page per contradiction code: what it compares, when it fires, its controls, and whether it can fire on real extraction today. |
| [`docs/reference/ontology.md`](docs/reference/ontology.md) | Generated reference for every node kind, edge kind and enumeration, with the extractor that produces each. Checked against `ontology/seamline.yaml` on every `pnpm verify`. |
| [`docs/conformance.md`](docs/conformance.md) | `seamline conformance`: run an extractor you wrote through the sandbox and get a PASS, FAIL or UNAVAILABLE per property (reads, network, ceiling, budget, UNAVAILABLE-never-PASS), and what a pass does not promise. |
| [`THREATMODEL.md`](THREATMODEL.md) | Assets, trust boundaries, adversaries, controls, and unmitigated residual risk. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | DCO, toolchain, tests, review expectations. |

---

## Project layout

```
packages/
  ontology/          the shared contract every package compiles against
  security/          the redactor, untrusted-text delimiting, and the public injection corpus
  core/              merge, identity resolution, lifecycle, run bookkeeping
  extract-code-ts/   TypeScript and JavaScript facts, via ts-morph
  extract-data/      SQL DDL, Drizzle, Prisma, migrations
  extract-contracts/ OpenAPI, JSON Schema, Zod
  extract-change/    git commits, touched files, rename detection
  infer-join/        the cross-domain field join
  contradictions/    the detector catalog
  align/             the alignment report: documents against code
  cli/               seamline
  mcp/               the MCP server
ontology/            seamline.yaml, the LinkML source of truth
scripts/             license, determinism and dogfood gates
```

## License

Code is [Apache-2.0](LICENSE). The ontology and the specification text under `docs/design/` are CC-BY-4.0. Attribution obligations and the trademark reservation are recorded in [NOTICE](NOTICE).

Apache-2.0 rather than MIT for two specific reasons: the express patent grant, and the section 6 trademark reservation, which is the only mechanism available to defend a new project's name. Dependencies are restricted to a permissive allow-list enforced in CI by `scripts/license-gate.mjs` from the first commit, and a package with a missing or unrecognised license field fails that gate.
