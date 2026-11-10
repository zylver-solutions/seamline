# Seamline

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The only recorded measurement is the hardened development measurement of the 2026-10-23 draft ([`docs/evaluation/dev-hardened-draft.md`](docs/evaluation/dev-hardened-draft.md)). It was made on a draft source tree, not on the code you install, and not on a sealed partition. On it Seamline produced zero findings and detected 0 of 11 injected mutants (five missed, six UNKNOWN), so precision and Wilson bounds are undefined at n=0. All ten detectors are dormant on that measured scope, and X3 and X10 have no shipped producer facts. No passing sealed evaluation exists; it is deferred to 0.2.0. A quiet run is not evidence that your repository is clean. Details are under [what works today](#what-works-today-and-what-does-not).

**Seamline is designed to join your database columns, API schemas, and TypeScript types into one graph and to report where they disagree.** On the one recorded measurement it reported nothing at all, and several of its checks report UNKNOWN rather than a result.

A seamline is the line along which two overlapping datasets are merged into a single mosaic. That is the intended job: your schema, your contracts, and your code each describe the same fields, and nothing checks that the three descriptions agree. Seamline extracts the facts and infers the joins between them, and its detectors are designed to report the disagreements.

No annotations. No YAML to hand-write. No decorators to sprinkle. You run it on a repository you did not write and it produces a graph on the first run. Whether any detector can report a disagreement on your repository is a separate question; see the notice above.

**Extensible semantic foundation:** `@seamline/core/semantic` also supplies a local, profile-based engine for typed domain objects, worlds, timelines, branches, inventory and historical state. The existing code-analysis CLI stays compatible. See the [library guide](docs/semantic-engine.md) for implemented building blocks, a runnable extension example and explicit limits; this is not a claim of new automatic extractors for every domain.

- **License:** Apache-2.0 (code), CC-BY-4.0 (ontology and specification text)
- **Contributions:** DCO sign-off, no CLA. See [CONTRIBUTING.md](CONTRIBUTING.md)
- **Status:** 0.1.0, the first release, published to npm on 2026-11-10. It is an early release: on the one recorded measurement it found nothing, no detector has measured precision or recall, and the project is pre-1.0, so library exports and output can change in any 0.x release and fixes land on the latest 0.x only. [What works today](#what-works-today-and-what-does-not) is stated plainly below, and the list is short.
- **Problems:** report bugs in [GitHub Issues](https://github.com/zylver-solutions/seamline/issues). Report a suspected vulnerability privately, as [SECURITY.md](SECURITY.md) describes, not in an issue.

---

## The ten-minute path

```bash
npm install -g @seamline/cli     # or: pnpm add -g @seamline/cli
cd your-repo
seamline init
seamline extract
seamline check
seamline why <column-or-field>   # a column, model field or schema property that exists in your repository
```

Seamline needs Node.js 22.13 or later. `@seamline/cli` installs the `seamline` command and brings in the other eleven `@seamline/*` packages as dependencies ([the packages](#packages)). Without a global install, run `npm install @seamline/cli` in a project and then `npx seamline`, or run it once with `npx --package @seamline/cli seamline --version`. The unscoped npm name `seamline` is not this project, so a bare `npx seamline` works only where `@seamline/cli` is already installed.

Two things you will see and can expect. Every command, `--version` included, prints an `ExperimentalWarning: SQLite is an experimental feature` line on stderr, because the graph store uses Node's built-in `node:sqlite`; it does not mean anything failed. And `npm install` ends by reporting moderate severity vulnerabilities: they are one advisory in `minimatch`, a dependency of `ts-morph`, for which npm offers no fix. It is disclosed under [known dependency advisories](SECURITY.md#known-dependency-advisories) in SECURITY.md.

`init` writes `seamline.config.json` and adds `seamline-out/` to your `.gitignore` (it keeps a config that already exists). That second part is not housekeeping: the graph is a concentrated map of your attack surface, and it is never committed by default. See [THREATMODEL.md](THREATMODEL.md).

`extract` prints one status line per extractor and writes the graph store to `seamline-out/` (the config's `outDir`); every other command reads it from there. An extractor with nothing it can read reports UNAVAILABLE, not PASS: for example `extract-change` outside a git work tree, or in a repository with no commit. To keep or read a store elsewhere, pass `--store <dir>` to `extract` and to whichever command reads it, for example `seamline extract --store ci/graph`, then the same `--store ci/graph` on the command that reads it. See [`packages/cli`](packages/cli/README.md#selecting-the-store).

`check` reports contradictions and lists every detector that could not run as UNKNOWN. `why` takes a name from your own repository; a name that matches no column, field or schema property is a usage error (exit 2).

### On the bundled example

The steps above work on any repository. The transcripts below come from the checked-in fictional example app [`examples/harbor-books`](examples/harbor-books); no real system is described there. To reproduce them:

```bash
git clone https://github.com/zylver-solutions/seamline
cd seamline/examples/harbor-books
SEAMLINE_DETERMINISTIC=1 seamline extract --only extract-code-ts --only extract-data --only extract-contracts --only infer-join
seamline why shipped_at
seamline check
```

The example ships its own `seamline.config.json`, so `init` is not needed there (it would report `kept`). `SEAMLINE_DETERMINISTIC=1` freezes the clock and derives the run id from the inputs, which is why the id below is stable and the durations read `0ms`; `--only` selects the four extractors that do not read git history. A plain `seamline extract` prints a time-based run id and real durations, and adds a line for `extract-change`: PASS with the history of the clone, or UNAVAILABLE (`not a git work tree`) if you copied the example out of the repository.

### `seamline extract`

```text
run run-det-59ab7ec19bf217c2  repo harbor-books

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
4 detector(s) could not run: X1_NULLABILITY, X2_TYPE, X7_VALIDATOR_DIVERGENCE, X8_ORPHANED_MIGRATION. Those checks are UNKNOWN, not clean.
  X1_NULLABILITY  VALUE_ROLE_UNOBSERVED: no joined response property states comparable nullability; generic code shapes and request properties do not prove a stored-row or insert obligation
  X2_TYPE  VALUE_ROLE_UNOBSERVED: no joined column and contract property state comparable types; generic code shapes do not prove a stored-row or insert role
  X7_VALIDATOR_DIVERGENCE  X7_NO_OBSERVABLE_LENGTH_PAIR: no current finite-length column and completely bound validated string input can be compared
  X8_ORPHANED_MIGRATION  migration group db/migrations: no supported framework ordering policy
```

The column and model field retain one lineage chain. `Order` and `OrderResponse` are different container names; their shared affix does not establish a mapping. The standalone schema remains extracted, and its name proves neither a response role nor a stored-value join. X1 and X2 therefore report UNKNOWN here, and X7 and X8 report UNKNOWN for the reasons printed on their lines. The former X1 demo finding was unsupported and has been retired.

`seamline check` reads the store that `seamline extract` wrote, so run `extract` first; without a store it has nothing to read. On this fixture it reports the same four UNKNOWNs with no contradictions and exit 0. That exit code is not evidence that every detector validated the repository, and `check` is not a verified gate (see the notice at the top). Mechanically, a critical or high finding produces exit 1; the response-source regression test in [`precision-response.test.ts`](packages/integration/src/precision-response.test.ts) proves a supported X1 comparison through extraction, inferred joins and the real store.

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

| Code | Contradiction                                                                         | Severity |
| ---- | ------------------------------------------------------------------------------------- | -------- |
| X1   | Nullability disagreement between a column and its joined response property            | high     |
| X2   | Type disagreement across a join                                                       | high     |
| X3   | Width or constraint disagreement between a column and its validator                   | medium   |
| X4   | Response property backed by no column and no computing symbol                         | medium   |
| X5   | NOT NULL column with no default the writers supply that no traced insert writes       | medium   |
| X6   | PII-bearing column reachable from an operation with no declared auth                  | critical |
| X7   | A source-proved validated request string has no upper bound for finite-length storage | high     |
| X8   | Migration referencing a table or column that no longer exists                         | low      |
| X9   | Contract drift: an operation with no handler, or a handler implementing no operation  | high     |
| X10  | A symbol that writes a PII column with no test or coverage intersecting it            | medium   |

Each code has a page covering what it compares, when it fires and when it must not, its controls, a minimal example from its fixture pair, and its current status: [`docs/contradictions`](docs/contradictions/README.md).

X3 and X10 need facts no shipped extractor supplies. X8 has authored declared-DDL extraction proof, with complete non-self-authored acceptance and independent qualification still pending. X7 has a bounded validated-write producer, but later hardening returns UNKNOWN on its measured real parent. Its earlier five-to-zero reproduction is historical; current real-source acceptance and independent precision remain unmet. X5 evaluates complete raw-insert facts but remains dormant on its measured unmodified corpus. X4 and X9 cover only part of their catalog descriptions. Each limit is listed under [what does not work](#what-works-today-and-what-does-not).

---

## How the join works

Seamline extracts facts and then infers the joins between them. Every edge is tagged with where it came from:

- `EXTRACTED` is a fact read directly out of your source. A column exists because the DDL says so.
- `INFERRED` is Seamline's own reasoning, with a heuristic confidence score. `orders.shipped_at` maps to `Order.shippedAt` because the names normalise to the same token sequence and the types are compatible.
- `DECLARED` is something a human asserted.
- `LLM_SUGGESTED` is something an agent proposed.

These have a total precedence order (`EXTRACTED > DECLARED > INFERRED > LLM_SUGGESTED`), so merging is deterministic regardless of the order the inputs arrive in, and an inference never overwrites a fact about the same node or edge. Facts and inferences are stored in the same `nodes` and `edges` tables, told apart by a `provenance` column. **A finding needs facts at both ends**: the two nodes a contradiction names must be `EXTRACTED` or `DECLARED`, and an `INFERRED` or `LLM_SUGGESTED` node never justifies one. The join between those two facts is normally an `INFERRED` edge, and it does affect the result: its confidence caps the finding's severity (at least 0.9 for critical, 0.75 for high, 0.5 for medium) and a join below 0.35 produces no finding. So a finding that fails `check` (critical or high) can rest on an inferred join between two disagreeing facts, but an inference cannot create a finding without them, and an `LLM_SUGGESTED` edge is never followed.

Two more properties fall out of the design and are worth knowing before you adopt it:

- **Identity survives a rename.** A node id is a path-free natural key for every kind except `File`, so a `git mv` changes no id but the `File`'s, unless it changes an input that the id is built from ([ADR-0016](docs/adr/ADR-0016-file-identity-carries-its-path.md) item 4 lists the inputs). A `File` is the one kind whose canonical name is its repo-relative path, so a moved file gets a new id; when git reports a committed rename (by default at least 60% similar and within the last 500 commits, with `extract-change` enabled), Seamline records an alias from the old id to the new one. Everywhere else, paths are properties, not identity.
- **Extraction is byte-reproducible under `SEAMLINE_DETERMINISTIC=1`.** With that switch set, two runs over the same tree write a byte-identical snapshot (the run id becomes `run-det-<digest of the inputs>`); the CI gate `scripts/determinism-gate.mjs` runs with it. Paths are repo-relative and keys are sorted in every run. Without the switch, the run id, the start and finish times and the extractor durations differ between runs, and in 0.1.0 the run id also appears in a `replayEpoch` property of `DataSource` and `Migration` nodes, so `seamline diff` of two plain runs over an unchanged tree lists those nodes as changed.

---

## Documents against code: `seamline align`

A repository says things about itself in Markdown: which Node it needs, which formats the CLI prints, which detectors work, which controls are enforced. `seamline align` reads a closed set of such claims out of the tracked documents (structural anchors and whole-sentence templates, no model) and compares each with a fact from Seamline's own extraction of the same commit, or from a `package.json`. Each comparison that finds something ends in one of five classes: Observed drift, Unexplained gap, Planned gap, Unknown, or Resolved against a baseline packet you supply; the summary also counts the subjects that are `Aligned`. A failed or unsupported extraction is Unknown and is never read as absence.

```bash
seamline extract
seamline align                                            # a summary for HEAD, facts read from the store
seamline align --profile alignment --packet align.json    # the finding packet
seamline align --baseline align.json                      # Resolved records against that packet
```

`align` runs inside a git repository: it reads the documents of a commit (`--at <rev>`, default `HEAD`) from the git object database, or the working tree with `--worktree`. `--facts <run>.sif` reads the facts from a snapshot under `seamline-out/runs/` instead of the store. No shipped profile can emit the packet, and `init` does not scaffold one, so the second command is refused (exit 2) until you declare a profile such as this under `exportProfiles` in `seamline.config.json`:

```json
"alignment": {
  "version": 1,
  "description": "Lets seamline align emit its finding packet.",
  "allow": [["File", "internal"], ["Symbol", "internal"]],
  "allowEdges": [], "allowProps": {}, "allowEdgeProps": {},
  "allowFields": ["id"], "allowProvenance": ["EXTRACTED"], "includeUntrusted": false,
  "packets": ["alignment"]
}
```

Three of the four probes parse TypeScript with the `typescript` package, an optional peer dependency that `npm install @seamline/cli` does not install. Without it the report is much thinner and does not say why: on this repository `align` then read 7 claims where it reads 65 with `typescript` present, and the two it could not check were Unknown with the bare reason `probe-failed`. Install `typescript` next to the CLI before reading an `align` report.

- **It never gates.** `seamline align` exits 0 whenever it produced a report, whatever the report holds. No flag, environment variable or configuration key makes drift fail, and `seamline check` is unchanged.
- **The packet is export-gated.** Without `--profile` it prints a summary of class counts and per-finding ids. The finding packet (schema version 1, redacted, with stable ids and run provenance) is written only through an export profile that names `"packets": ["alignment"]` and whose `allow` lists `["File", "internal"]` and `["Symbol", "internal"]` (the packet names files by path and can name symbols).
- **The pairing is stated.** Whether the facts come from the store or from `--facts`, their pairing with the evaluated commit is asserted by you, and the report says `asserted`, not `verified`.
- **What it checks** is four kinds of claim: a runtime floor, the output formats of the CLI, whether a contradiction detector works at the level of node kinds, and whether a control row names code that something imports. **What it does not check** is code that no document mentions, severities, descriptions, counts, links, other declared entities such as `ontology/seamline.yaml`, or anything outside Markdown. Prose it cannot match yields no claim, so silence is the failure mode and a guess never is.

The design is [`docs/design/alignment.md`](docs/design/alignment.md); the decision and its limits are [ADR-0014](docs/adr/ADR-0014-alignment-drift-classes-and-finding-packet.md).

---

## What works today, and what does not

This section is deliberately blunt. An earlier version of this design claimed considerably more than it could do, and the review that followed said so in detail. Nothing below is a roadmap promise.

**Shipped in 0.1.0:**

- Three source extractors: **TypeScript/JavaScript** (via ts-morph, type-checker-backed, resolving through re-exports and barrels), **data** (SQL DDL, Prisma schema files, migration files, and Drizzle schema modules for Postgres, that is `pgTable`, `pgSchema` and `pgEnum`; other Drizzle dialects are recorded as unread, not parsed), and **contracts** (OpenAPI, JSON Schema, Zod).
- A git change extractor for commits, touched files, and rename detection.
- One inference pass (`infer-join`) that produces the cross-domain field joins.
- The ten contradiction detectors in the catalog above. X3 and X10 lack real producer facts. X7 has historical development proof; hardened real-source acceptance remains unmet. X8 has authored replay extraction proof; complete external acceptance remains unmet.
- CLI, ten commands: `init`, `extract`, `why`, `check`, `export`, `diff`, `blast-radius`, `mcp`, `align` and `conformance` (`seamline --help` lists them, and [`packages/cli`](packages/cli/README.md#commands) has the table). `--json` gives machine-readable output on every command except `mcp`, which speaks the MCP protocol on stdout.
- Storage: embedded SQLite. One store, no listener, no network surface by default.

**Not implemented, and not scheduled without a named user asking for it:**

- **No web viewer.** The CLI prints human-readable text, and `--json` switches a command to machine-readable JSON (`export` always writes JSON, and `mcp` speaks the MCP protocol on stdout). CSV and Mermaid output are not implemented.
- **No live database introspection.** The data extractor reads static files: DDL, schema definitions, migrations. It does not connect to your database. It never reads Terraform state or plan files either.
- **Code support is TypeScript and JavaScript only.** No Python, Go, Java, Ruby, or Rust. Language support is not a small increment here: the join quality depends on type-checker-backed resolution, and a regex-grade parser would produce confident nonsense.
- **No lenses, no diagram gallery, no scorecards, no readiness matrix.** These existed in an earlier design and were cut.
- **No Neo4j, Kuzu, or graph-database adapter.** Every traversal in the design is bounded-hop and does not justify one.
- **No hosted service.** There is no server component and no telemetry. Seamline makes no network calls.
- **Domain modelling is optional and declaration-only.** The graph works without it.
- **The ontology names more than is extracted.** Its 29 node kinds include reserved vocabulary that no shipped extractor produces (`TestCase`, `TestRun`, `CoverageRecord`, `Lens`, `ThreatModel`, `Owner`, `Entity`, `DomainProperty`), so finding a kind in the ontology does not mean the feature behind it exists; the [ontology reference](docs/reference/ontology.md) names the producer of each kind, or `none declared`.
- **`blast-radius` without `--ids` can list a file as changed that is not.** Seamline never lets a repository's own git settings run a program, so a clean filter (Git LFS, a line-ending converter) does not run, and a file such a filter would have normalised shows as modified. That widens the blast radius and never narrows it. If git is refused for a repository (its config defines a filter, diff or merge driver whose name cannot be passed to git on a command line, or more than 512 of them), the command stops with an error and a non-zero exit instead of reporting a clean tree. See [THREATMODEL.md](THREATMODEL.md).
- **X5 (`X5_UNWRITTEN_COLUMN`, unwritten required column) is conservative by design.** It fires on a `NOT NULL` column with no default the writers supply when no traced `INSERT` names it, for example a Prisma `@updatedAt` column (a client-side default that a raw insert does not receive) omitted by a raw `INSERT INTO t (a, b) VALUES (...)`. It is UNKNOWN for a whole repository when an extractor records a write it could not attribute (`untracedWriteCalls`), a write hook, embedded runtime DDL, or dynamic DDL, and it withholds, with a note, a table with a `BEFORE INSERT` trigger, more than one declaring source file, an insert whose column list is not fully known, or a writer the extractor could not turn into an edge. `check` prints the withheld tables under "NOT EVALUATED" so they never read as clean. The guards are lexical and do not establish every aliased delegate or concatenated statement, so a finding means "no traced insert supplies it", not "no insert does". The earlier pinned development findings were adjudicated as three false positives because runtime schema setup can supply database defaults. The runtime-DDL guard now withholds that conclusion. The development evaluation below reports UNKNOWN on all five pinned checkouts and no observed X5 firing; authored extraction fixtures remain its firing evidence. X5 is dormant on that measured scope, and its precision is unmeasured (see [design 8.1](docs/design/real-world-inputs.md)).
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

The one recorded measurement is the hardened development measurement of the 2026-10-23 draft: [`docs/evaluation/dev-hardened-draft.md`](docs/evaluation/dev-hardened-draft.md), with a [machine-readable summary](docs/evaluation/dev-hardened-draft.json). It was made on a draft source tree, not on the code you install, and no sealed source was analysed. It reports zero findings and 0 of 11 mutant detections (five missed, six UNKNOWN, all retained in the denominator). Precision and Wilson bounds are undefined at n=0, and all ten detectors are dormant on that measured non-self corpus. The record lists, for each detector, its UNKNOWN pins and the reason it was dormant.

Confidence calibration has zero labelled groups and no estimable bands. Independent-review metadata is missing. The sealed release bar remains at least 30 independently labelled clusters, precision at least 0.90 and a 95% Wilson lower bound at least 0.75, with the existing per-detector checks. This measurement establishes none of those requirements and is not release or sealed qualification evidence.

If your repository is not TypeScript, Seamline has close to nothing to say to you today. That is a real limitation, not a phrasing choice.

---

## Security posture in one paragraph

The artifact Seamline produces is, in one queryable file, a map of your attack surface: every entry point, every endpoint's auth mode including the missing ones, every secret reference and the function that reads it, every IAM role, the under-tested high-risk paths, and the ownership map. Aggregation makes the whole strictly more sensitive than any part. So: `seamline-out/` is gitignored by `init`; every node carries a sensitivity level defaulted per kind; **export is default-deny** and refuses to run without a named allow-list profile; a redactor is the sole writer to the store and replaces matched secrets with references rather than values; extractors run under a capability manifest with a scrubbed environment and no network; and text that came from a third party (dependency metadata, commit messages, issue text, code comments) is tagged `untrusted` and delimited when it is served into an agent's context.

The redactor and the delimiting of untrusted text live in [`@seamline/security`](packages/security/README.md), together with a public corpus of canary secrets and injection payloads that both are tested against; contributions to the corpus are welcome.

If you are writing an extractor of your own, `seamline conformance ./my-extractor.mjs` (or, with nothing installed, `npx --package @seamline/cli seamline conformance ./my-extractor.mjs`) checks it against these controls on generated fixtures; see [docs/conformance.md](docs/conformance.md), which also says what a pass does not promise.

The full analysis, including the residual risks that are **not** mitigated in this version, is in [THREATMODEL.md](THREATMODEL.md). Report vulnerabilities per [SECURITY.md](SECURITY.md).

---

## Using Seamline from an agent

Seamline ships an MCP server (`@seamline/mcp`). In v0.1 it is stdio-only, exposes parameterized tools only, and has **no raw query tool**: there is no endpoint that accepts a query language, because that is arbitrary code execution wearing a friendly name. Traversal depth is bounded by construction and results are capped.

Serve an extracted repository with `seamline mcp --profile <name>` (after `seamline extract`), and point your MCP client at that command. In a client configured with a command and an argument list (an `mcpServers` entry, for example), the command is `seamline` and the arguments are `mcp`, `--repo`, `/path/to/repo`, `--profile`, `team`. The server prints nothing when it starts: it waits for MCP messages on stdin and exits when stdin closes. The `seamline-mcp` binary of `@seamline/mcp` is not this server; it has no store behind it and answers every tool call over an empty graph. The profile is required: like export, the server is default-deny, and every tool is evaluated inside the named profile, so a node the profile withholds is never returned, counted, or used as a hop. A profile is the same thing for `export` and `mcp`: one format, either a shipped profile (`public`, `team`, `audit`) or one you declare under `exportProfiles` in `seamline.config.json`. See [the export profile design](docs/design/export-profile.md) and its [JSON Schema](docs/reference/export-profile.schema.json). `--audit` logs one JSON line per tool call to stderr. `--store <dir>` serves a store other than the config's `outDir`.

`context` and `impact` take a `tokenBudget` to fit an answer to a context budget (an estimate, not a tokenizer count), and `impact` with `targets: "tests"` returns the tests a change reaches, justified by extracted facts only. When no test facts were extracted the answer is UNKNOWN, never "no affected tests". See [`packages/mcp/README.md`](packages/mcp/README.md).

---

## Verifying a release

Every `@seamline/*` 0.1.0 package was published from GitHub Actions with an npm provenance attestation (SLSA provenance v1). The attestation names the source repository `https://github.com/zylver-solutions/seamline`, the workflow `.github/workflows/release.yml`, the ref `refs/tags/v0.1.0` and the commit `af1d3aca53a6b25a3d1539852bd685e12f783a51`. To check what you installed, run this in a project directory where the package is installed:

```bash
npm install @seamline/cli
npm audit signatures
```

```text
audited 23 packages in 0s

23 packages have verified registry signatures

15 packages have verified attestations
```

The 23 are the twelve `@seamline/*` packages and their eleven third-party dependencies; the twelve are among the 15 with attestations. A package whose signature or attestation is missing or invalid is listed instead of counted as verified. On npm, `latest` and `next` both point at 0.1.0. How releases are cut, and how to inspect one attestation, is in [`docs/RELEASING.md`](docs/RELEASING.md).

---

## Documentation

|                                                                                            |                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/README.md`](docs/README.md)                                                         | An index of everything under `docs/`.                                                                                                                                                                                |
| [`docs/design/v3.md`](docs/design/v3.md)                                                   | The authoritative design. Invariants, ontology, contradiction catalog, license policy.                                                                                                                               |
| [`docs/audit/2026-08-29-council-review-v2.md`](docs/audit/2026-08-29-council-review-v2.md) | The nine-lens adversarial review that blocked the previous design and forced this one. Read it before proposing a large feature; it is the record of what was already argued and lost.                               |
| [`docs/design/alignment.md`](docs/design/alignment.md)                                     | The alignment report: drift classes, the four claim kinds, their probes, and the finding packet. Decided in ADR-0014.                                                                                                |
| [`docs/contradictions`](docs/contradictions/README.md)                                     | One page per contradiction code: what it compares, when it fires, its controls, and whether it can fire on real extraction today.                                                                                    |
| [`docs/reference/ontology.md`](docs/reference/ontology.md)                                 | Generated reference for every node kind, edge kind and enumeration, with the extractor that produces each. Checked against `ontology/seamline.yaml` on every `pnpm verify`.                                          |
| [`docs/conformance.md`](docs/conformance.md)                                               | `seamline conformance`: run an extractor you wrote through the sandbox and get a PASS, FAIL or UNAVAILABLE per property (reads, network, ceiling, budget, UNAVAILABLE-never-PASS), and what a pass does not promise. |
| [`docs/RELEASING.md`](docs/RELEASING.md)                                                   | How a release is cut, what the npm dist-tags mean, and how to verify the provenance of a published package.                                                                                                          |
| [`THREATMODEL.md`](THREATMODEL.md)                                                         | Assets, trust boundaries, adversaries, controls, and unmitigated residual risk.                                                                                                                                      |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                       | DCO, toolchain, tests, review expectations.                                                                                                                                                                          |

---

## Packages

Twelve packages are published to npm, all at the same version. Most people install only `@seamline/cli`: it depends on the other eleven, so they arrive with it. Each has a README under `packages/`.

| Package                                                               | What it is for                                                                                                     | How you get it                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [`@seamline/cli`](packages/cli/README.md)                             | The `seamline` command: the ten commands above.                                                                    | Install it directly.                                                                         |
| [`@seamline/mcp`](packages/mcp/README.md)                             | The MCP server that serves the graph to an agent through five parameterized tools.                                 | With the CLI (`seamline mcp`). Directly only to embed the server over your own graph source. |
| [`@seamline/security`](packages/security/README.md)                   | The secret redactor, the delimiting of untrusted text for agent context, and a public corpus that tests both.      | With the CLI. Directly if you want the redactor, the delimiting or the corpus alone.         |
| [`@seamline/ontology`](packages/ontology/README.md)                   | The typed contract: node and edge kinds, sensitivity, provenance and identity rules.                               | With the CLI. Directly to write an extractor or a tool that reads the graph.                 |
| [`@seamline/core`](packages/core/README.md)                           | The SQLite store, identity, merge, traversal, export profiles and the extractor sandbox; also the semantic engine. | With the CLI. Directly to read a store from code or to use `@seamline/core/semantic`.        |
| [`@seamline/extract-code-ts`](packages/extract-code-ts/README.md)     | TypeScript and JavaScript facts, read through the ts-morph type checker.                                           | With the CLI (`seamline extract`).                                                           |
| [`@seamline/extract-data`](packages/extract-data/README.md)           | Database schema facts from SQL DDL, Drizzle, Prisma and migrations.                                                | With the CLI (`seamline extract`).                                                           |
| [`@seamline/extract-contracts`](packages/extract-contracts/README.md) | API-contract facts from OpenAPI, JSON Schema and Zod.                                                              | With the CLI (`seamline extract`).                                                           |
| [`@seamline/extract-change`](packages/extract-change/README.md)       | Git history facts: commits, touched files and renames.                                                             | With the CLI (`seamline extract`).                                                           |
| [`@seamline/infer-join`](packages/infer-join/README.md)               | The inferred joins between columns, fields, schema properties and validators.                                      | With the CLI (`seamline extract`).                                                           |
| [`@seamline/contradictions`](packages/contradictions/README.md)       | The ten contradiction detectors.                                                                                   | With the CLI (`seamline check`, `seamline why`).                                             |
| [`@seamline/align`](packages/align/README.md)                         | The alignment report: documents against code.                                                                      | With the CLI (`seamline align`).                                                             |

Two more workspace packages, `@seamline/eval` (the evaluation harness, see [`eval/README.md`](eval/README.md)) and `@seamline/integration` (cross-package tests), are private and are not published to npm.

Elsewhere in the repository: `ontology/` holds `seamline.yaml`, the LinkML source of the vocabulary; `examples/` holds the example app used above and a semantic-engine demo; `eval/` holds the evaluation corpus; `scripts/` holds the license, determinism, pack and dogfood gates; `docs/` holds the design, the decision records and the reference pages.

## License

Code is [Apache-2.0](LICENSE). The ontology and the specification text under `docs/design/` are CC-BY-4.0. Attribution obligations and the trademark reservation are recorded in [NOTICE](NOTICE).

Apache-2.0 rather than MIT for two specific reasons: the express patent grant, and the section 6 trademark reservation, which is the only mechanism available to defend a new project's name. Dependencies are restricted to a permissive allow-list enforced in CI by `scripts/license-gate.mjs` from the first commit, and a package with a missing or unrecognised license field fails that gate.
