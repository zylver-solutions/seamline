# Design: one export profile format, loaded through one parser

- **Status:** implemented in 0.1.0 (status checked 2026-11-10; code: `packages/core/src/security/export-profile.ts` and `packages/core/src/security/export-policy.ts`). This record is the design the parser and its tests follow. Sections 2, 4 and 5 describe a config format and an `export` command that existed only before the first release; no published version used them.
- **Tracking:** the work toward [the aspirational state](aspirational-state.md).
- **Builds on:** `docs/design/v3.md` section 2.5 (export is default-deny) and section 9 (the deferral this record lifts), `docs/adr/ADR-0006-security-spine.md`.
- **Contract:** no change. `packages/ontology/src/contract.ts` defines the vocabulary a profile is written in (`NODE_KINDS`, `EDGE_KINDS`, `SENSITIVITY`, `PROVENANCE`, `DEFAULT_SENSITIVITY`) and no profile type. The type lives in `packages/core/src/security/export-profile.ts`.
- **Reference:** the format as a JSON Schema is `docs/reference/export-profile.schema.json`.

## 1. The problem

`docs/design/v3.md` section 9 recorded, as deferred, that two allow-list formats existed and that unifying them waited for "a named consumer [that] needs a config-declared profile served over MCP". Three consumers now need it:

1. **`seamline export`**, which read profiles only from `seamline.config.json`.
2. **`seamline mcp` and `@seamline/mcp`**, which accepted only the three shipped profiles, so a team could not serve an agent from a profile it had written and reviewed.
3. **The alignment finding packet** of ADR-0014, which needs an export-profile opt-in (`packets`) to exist in exactly one place, not two.

Two formats meant two engines, two sets of defaults, and two answers to "what may leave the store". The sections below say what each did and what the single format takes from each.

## 2. Inventory (tree of 2026-10-19)

Every place a profile was defined, parsed, validated or applied, and every place one is documented.

Note (2026-11-10): this inventory is a historical record of the tree before the format was unified. Its file and line references do not resolve against the released tree: for example `assertIsAllowList`, the CLI's own `applyProfile` and the `public-inventory` profile no longer exist, the profile type is in `packages/core/src/security/export-profile.ts`, and `seamline.config.json` now declares the profiles `alignment` and `structure`.

### 2.1 Code

| Where                                                                          | What                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/config.ts:31-45`                                             | The config format's own `ExportProfile` type: `description`, `maxSensitivity`, `nodeKinds`, `edgeKinds`, `fields`, `provenance`, `includeUntrusted`, `props`.             |
| `packages/cli/src/config.ts:72-81`, `:98`                                      | `STARTER_PROFILE`, scaffolded by `init`, and used as the profile when the config had no `exportProfiles` key (`:197`).                                                    |
| `packages/cli/src/config.ts:160-167`, `:201-232`                               | The config parser: `parseProfile`, `enumArray`.                                                                                                                           |
| `packages/cli/src/commands/export.ts:80-92`                                    | Profile lookup: `config.exportProfiles[name]` only. Shipped profiles were not reachable from `export`.                                                                    |
| `packages/cli/src/commands/export.ts:183-253`                                  | The CLI's own `applyProfile`: sensitivity ceiling on the node's stored label, provenance and untrusted filters, a flat `props` list, a free `fields` projection.          |
| `packages/core/src/security/export-policy.ts:50-59`                            | The core `ExportProfile` type: `name`, `description`, `allow` (`[kind, sensitivity]` pairs), `allowEdges`, `allowProps`, `allowEdgeProps`, `allowFields`.                 |
| `packages/core/src/security/export-policy.ts:161-223`                          | The shipped `public`, `team`, `audit` profiles and `PROFILES`.                                                                                                            |
| `packages/core/src/security/export-policy.ts:226-234`                          | `getProfile`: `PROFILES[name]`, which also answered `constructor` and `__proto__` with an inherited object.                                                               |
| `packages/core/src/security/export-policy.ts:269-480`                          | `projectNode`, `projectEdge`, `applyProfile`, `profileView`: the engine, effective sensitivity (the kind default as a floor).                                             |
| `packages/core/src/security/export-policy.ts:491-549`                          | `assertIsAllowList`: the core validator.                                                                                                                                  |
| `packages/mcp/src/profiled.ts:46-55`                                           | `pinProfile`: clone, `assertIsAllowList`, freeze. Called from `packages/mcp/src/server.ts:90`; `profileView` at `server.ts:133`.                                          |
| `packages/mcp/src/bin.ts:65`                                                   | The standalone `seamline-mcp` binary serves `PUBLIC_PROFILE`.                                                                                                             |
| `packages/cli/src/commands/mcp.ts:87-104`                                      | `resolveProfile`: shipped profiles only, by `getProfile`.                                                                                                                 |
| `seamline.config.json:8-33`, `examples/harbor-books/seamline.config.json:8-33` | The only profile files in the repository: the config format, one profile, `public-inventory`. There are no YAML or standalone profile files under `docs/` or `examples/`. |
| `packages/core/src/semantic/disclosure.ts:73-76` and `checkRecordFilter`       | The semantic layer's disclosure: `RecordFilter` and `ReleaseScope`, an allow-list over registry type ids and field names. Not an `ExportProfile`.                         |

### 2.2 Documentation

| Where                                                                     | What it said                                                                                                                                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THREATMODEL.md:126` (C2)                                                 | A profile names "node kinds, edge kinds, fields, provenance levels, and maximum sensitivity": the config format.                                                                        |
| `THREATMODEL.md:132` (C8)                                                 | MCP evaluates every tool inside "an export profile's view (`profileView`, the same allow-list `applyProfile` enforces)": the core format.                                               |
| `README.md:202`, `packages/mcp/README.md:9,11`                            | MCP profiles are `public`, `team`, `audit`, or "your own allow-list": the core format.                                                                                                  |
| `packages/cli/README.md:26`                                               | `seamline export --profile team`: a shipped name that the config-only lookup rejected, so the example failed.                                                                           |
| `docs/design/v3.md:105`, `:270`; `docs/adr/ADR-0006-security-spine.md:31` | "A profile is an allow-list"; section 9 recorded the two formats as deferred.                                                                                                           |
| `docs/design/external-symbols.md:184` (section 4.4)                       | When a declared profile releases a third-party decorator stub: the config format's `nodeKinds`, `maxSensitivity`, `provenance` and flat `props`. Restated when this format was adopted. |

### 2.3 Differences

|                | Config format (`seamline export`)                                                                                   | Core format (`seamline mcp`)                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Node admission | kind in `nodeKinds`, and the node's **stored** sensitivity at or below `maxSensitivity`                             | `(kind, effective sensitivity)` pair in `allow`; the kind default is a floor an extractor cannot lower |
| Edges          | kind in `edgeKinds`, destination admitted (the walk starts from an admitted source, so the source was admitted too) | kind in `allowEdges`, both endpoints admitted, dangling endpoints withheld                             |
| Props          | one flat list for every kind and edge                                                                               | per kind (`allowProps`) and per edge kind (`allowEdgeProps`), `'*'` written per kind                   |
| Fields         | any of 16 scalar fields, named in `fields`                                                                          | fixed base fields, `path` and `sourceRef` opt-in                                                       |
| Provenance     | `provenance` list; absent meant nothing exported                                                                    | not a profile concept: every provenance released                                                       |
| Untrusted text | `includeUntrusted`, default false                                                                                   | not a profile concept: always released                                                                 |
| Version        | none (the config file has `version`, a profile does not)                                                            | none                                                                                                   |
| Unknown fields | ignored                                                                                                             | ignored                                                                                                |
| Missing fields | defaulted (`description` to empty, lists to empty)                                                                  | refused                                                                                                |
| Source         | `exportProfiles` in the config only                                                                                 | built in, three names                                                                                  |
| Where applied  | `export.ts` `applyProfile`                                                                                          | core `applyProfile` and `profileView`                                                                  |
| Tombstones     | skipped                                                                                                             | passed through whatever the caller supplied                                                            |

Two consequences were real defects, not style: `export` trusted a stored sensitivity label that the policy elsewhere treats as a floor, so a label understated by an extractor would pass a ceiling it should not; and a malformed or misspelled field in either format was silently skipped, which in an allow-list is a restriction the author believed they had written down.

## 3. Decision: one format, version 1

A profile is a JSON object. The core allow-list model is the base, because it is the more precise (per-kind levels, per-kind props, both endpoints, effective sensitivity) and the one `profileView` already enforces for agents. The two axes only the config format had, provenance and untrusted text, are added to it, so that no restriction an author could write before is lost.

```json
{
  "version": 1,
  "description": "Structural inventory: repo, modules and files, extracted facts only.",
  "allow": [
    ["File", "internal"],
    ["Module", "internal"],
    ["Repo", "internal"]
  ],
  "allowEdges": ["CONTAINS", "IMPORTS"],
  "allowProps": {},
  "allowEdgeProps": {},
  "allowFields": ["id", "kind", "name", "path", "src", "dst"],
  "allowProvenance": ["EXTRACTED"],
  "includeUntrusted": false
}
```

| Field              | Type                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | the number `1`                           | Required. A profile without it, or with another value, is refused.                                                                                                                                                                                                                                                                                                                                                     |
| `name`             | string                                   | The profile's name. **Never a field in a file**: under `exportProfiles` the key is the name, and a `name` inside the object is an error. In memory (`ExportProfile`) it is always present. 1 to 64 characters from `A-Z a-z 0-9 . _ -`, starting with a letter or digit.                                                                                                                                               |
| `description`      | string                                   | Required, at most 500 characters, counted as Unicode code points (as JSON Schema's `maxLength` counts them, so an emoji is one), no control characters (it is printed by `--list-profiles`). May be empty.                                                                                                                                                                                                             |
| `allow`            | array of `[NodeKind, Sensitivity]`       | Required, never empty, no duplicate pair. A node is released only if its **effective** sensitivity (the kind default raised, never lowered, by the node's own label) matches a listed pair for its kind.                                                                                                                                                                                                               |
| `allowEdges`       | array of `EdgeKind`                      | Required, may be empty, no duplicates. An edge is released only if its kind is listed, its provenance is allowed, and both endpoints are released.                                                                                                                                                                                                                                                                     |
| `allowProps`       | object, node kind to `'*'` or prop names | Required, may be `{}`. A kind without an entry releases no props. Each key must be a kind `allow` admits. Prop names are non-empty and not repeated. If any entry is `'*'` or a non-empty list, `allowFields` must name `props` (section 3.1).                                                                                                                                                                         |
| `allowEdgeProps`   | object, edge kind to `'*'` or prop names | Same, for edges; each key must be a kind `allowEdges` lists, and an entry that is `'*'` or a non-empty list needs `props` in `allowFields`.                                                                                                                                                                                                                                                                            |
| `allowFields`      | array of record fields (section 3.1)     | Required, may be empty, no duplicates. In a file, a released node or edge carries exactly the fields named here and no others; nothing is released by being a "base" field, so `id`, `kind` and `name` are named like the rest. An empty list is accepted and writes `{}` for each released record, which discloses only counts. On the agent surface it governs the location and lifecycle fields only (section 3.2). |
| `allowProvenance`  | array of `Provenance`                    | Required, never empty, no duplicates. A node or edge with another provenance is withheld.                                                                                                                                                                                                                                                                                                                              |
| `packets`          | array of `'alignment'`                   | Optional (implemented in 0.1.0, section 6). Finding packets that may leave through this profile. Absent or empty means none, and the canonical form omits the key when no packet is named.                                                                                                                                                                                                                             |
| `includeUntrusted` | boolean                                  | Required, written down in every profile. A node tagged `untrusted` is withheld unless true. When true, `allowFields` must name `untrusted`, so untrusted text never leaves in a file without its marker (section 3.1).                                                                                                                                                                                                 |

### 3.1 Record fields: a declared profile releases only what it selects

`allowFields` is a closed list of the record fields a released node or edge may carry. The names are the ones the earlier config format called `fields`, plus `props`:

- **Both:** `kind`, `provenance`, `confidence`, `sourceRef`, `props`, `firstSeenRun`, `lastSeenRun`, `deletedAt`.
- **Nodes only:** `id`, `name`, `path`, `sensitivity` (always the effective level), `untrusted` (written only when the node has the tag).
- **Edges only:** `src`, `dst`, `srcFile`, `dstFile`.

A file carries a field if and only if the profile names it. `props` selects whether the `props` object is present; `allowProps` and `allowEdgeProps` still select which props it holds, so a profile that names `props` and no props writes `"props": {}`. The one shape difference from the earlier command is exactly that: it left the key out when nothing on the record matched.

Two relations between `allowFields` and the rest of the profile are checked by the parser, because a profile that breaks them would say different things to a file and to an agent. Each refusal names the profile and the field and points at this document:

- **Props need `props`.** A profile whose `allowProps` or `allowEdgeProps` has an entry that is `'*'` or a non-empty list must name `props` in `allowFields`. Otherwise a file would carry none of those props while the agent surface printed them (section 3.2). An entry that is an empty list releases no prop on either surface, so it does not count, and a profile whose entries are all empty lists (or that has no entries) may leave `props` out.
- **Untrusted text needs its marker.** A profile with `includeUntrusted: true` must name `untrusted` in `allowFields`. `untrusted` is written only on a node that has the tag, so naming it costs nothing on any other record, and an untrusted node can never be written without it.

`allowFields: []` is accepted. It writes `{}` for every released node and edge, which discloses the counts and nothing else.

For `File` nodes the id and the name are the path: a node id is `{repo}:{kind}:{canonicalName}` and the canonical name of a file is its repository-relative path. A profile that admits `File` and names `id`, `name`, `src` or `dst` therefore releases the path whatever it says about `path`.

The lifecycle fields, `firstSeenRun`, `lastSeenRun` and `deletedAt`, are never released unless a profile names them. A run id is `run-<ISO timestamp>-<random>` under the real clock, so releasing one writes the extraction's wall-clock time into every released record and makes the file change on every re-extraction even when nothing else did. `deletedAt` is the deletion time of a tombstone. A profile that wants them says so.

**The shipped profiles' fields (decided before 0.1.0).** `team` and `audit` name every field, as they always released them, so their export is byte-identical to what it was before (section 4). `public` names every field except the four location fields and the three lifecycle fields, so it no longer releases `firstSeenRun`, `lastSeenRun` or `deletedAt`: its audience is external, nothing about a summary of the system's shape needs the extraction time, and keeping them made the file change on every re-extraction of an unchanged repository. This changes the bytes `seamline export --profile public` writes (each released node and edge loses those three keys), which is free before the first release and would be a breaking change after it. Note (2026-11-10): 0.1.0, the first published release, shipped with this decision, so no published `public` export carries those three fields. `team` and `audit` keep the lifecycle fields on purpose: both are internal, an auditor reads when a fact was first and last seen and whether it is a tombstone, and an engineering team diffing two exports wants the same. Their exports still change on every re-extraction; a team that commits one should declare a profile that leaves the three fields out. Every other field in `public` was checked for time, host, path and identity: `id`, `src` and `dst` are path-free natural keys (`{repo}:{kind}:{name}`), `name` is a repo, module, contract or operation name, `kind`, `sensitivity` and `provenance` are closed vocabularies, `confidence` is a number, and the only prop is an operation's `method`. One name is not operator-chosen by default: the `Repo` node's name, and the `{repo}` prefix of every id, is `config.repo`, which `seamline init` and the missing-config fallback set to the repository directory's basename, so `public` releases that basename unless `repo` is changed in `seamline.config.json` (unchanged behaviour). A declared profile is different in one way only: in a file it starts from nothing and adds, so nothing is released by default. The agent surface is not like that; section 3.2 says what it always prints.

Migrating a profile therefore does not widen it: `fields` becomes `allowFields` name for name (section 5), and a field the old profile did not list is a field the new one does not list.

### 3.2 The agent view and the file

`applyProfile` writes a file, and it carries exactly the fields above. `profileView` serves a `GraphView`, whose nodes and edges are whole `SeamlineNode` and `SeamlineEdge` values (the contract fixes their shape, and `packages/ontology/src/contract.ts` is not changed): the traversal and the detectors read `provenance`, `confidence` and `deletedAt` from them, and a record without `deletedAt` would read as a tombstone. So the view keeps those fields internally, and **the boundary is what a tool prints**. The two surfaces are not the same, and `allowFields` does not mean the same thing on both.

**What `allowFields` governs on the agent surface:**

- The location fields (`path`, `sourceRef`, `srcFile`, `dstFile`) are stripped from the view unless named, exactly as in the file.
- The lifecycle fields (`firstSeenRun`, `lastSeenRun`, `deletedAt`) are printed only when named. Only `explain` prints them. It always says whether a node is a tombstone, because a node that no longer exists is the substance of the answer, but it gives the deletion time only when `deletedAt` is named.

**What the MCP tools print whatever `allowFields` says:** `id`, `kind`, `name`, `src`, `dst`, `untrusted`, `provenance`, `confidence`, `sensitivity`, and the props that `allowProps` and `allowEdgeProps` name. A profile with `allowFields: []` writes `{}` per record to a file and serves an agent exactly the same answers as one that names all of these. Because the parser refuses a profile that names props without selecting `props` (section 3.1), the props an agent sees and the props a file carries are always the same props. The reasons, field by field:

- **`id`, `kind`, `name`, `src`, `dst`.** Identity. Every tool takes ids and returns nodes and edges, so an agent cannot use one without them.
- **`untrusted`.** The marker must travel with untrusted text: the tools neutralize it and reproduce it inside a delimited block only because they know the node carries the tag.
- **`provenance`, `confidence`.** An agent cannot tell a fact from an inference without them (invariant 5). They describe a fact the profile already released, not repository content, and `allowProvenance` bounds which provenance a released record can carry.
- **`sensitivity`.** It is the effective level, `max(kind default, node label)`, so it is a function of the released `(kind, level)` pair, not a separate disclosure: a node is released only if its pair is in `allow`, so the level printed is one the profile author listed for that kind. For a profile that lists one level per kind (`public`, `team` and `structure`; `audit` lists every level and names `sensitivity` itself) it reveals nothing the kind does not. It adds information only when a profile lists several levels for a kind and omits `sensitivity` from `allowFields`, or when a producer raises a label; an agent then learns which listed level a node holds. It does not expose personal data: the `pii*` props are props, and `allowProps` gates them. The provenance argument does not cover this field, which is why it is justified separately here.

This is how the agent surface behaved before the format was unified, and `team` and `audit` name every field, so their MCP answers are unchanged. `public` no longer names the lifecycle fields (decided before 0.1.0), so `explain` under it no longer prints the run ids or a deletion time. `packages/mcp/src/agent-surface.test.ts` pins it: profiles that differ only in the fields outside the location and lifecycle groups give byte-identical answers from `context` and `explain`, no location or lifecycle value is printed unless named, and no registered tool prints a run id or `deletedAt` under a profile that names none (a new tool fails that test until its calls are added to it).

### 3.3 Closed vocabulary and the unknown-field policy

Every list is checked against the contract's constants, so a new node kind changes what a profile may name only by changing `contract.ts`. An unknown field at any level is an error, with the pre-version-1 names called out when they appear, so an old file is recognised rather than half-read. The rule is one sentence: **a field the reader does not understand is a restriction the author may believe is in force, so it is refused.**

### 3.4 Evolution

- A change that adds an optional key whose absence means "deny" or "none" (`packets`, section 6) stays in version 1. An older build reading a file that uses it refuses it as an unknown field, which fails closed.
- A change that renames or removes a key, makes an optional key required, or alters what an existing key means is version 2. A build reads only the versions it lists; there is no best-effort read of a newer one.
- Adding a value to a closed vocabulary (a node kind) is made in the contract, and `docs/reference/export-profile.schema.json` must be updated by hand in the same change (there is no generator, section 7); a test fails until it is.

### 3.5 Where profiles live, and what is accepted

- **JSON only.** The repository's config is JSON ("no expression language, because it is read by a tool whose whole point is that its inputs are auditable"), and Node has no YAML parser; adding one is a dependency this project commits to minimizing.
- **Shipped profiles** (`public`, `team`, `audit`) are defined in `packages/core/src/security/export-policy.ts` and built through the parser, so a malformed edit to one fails when the module loads.
- **Declared profiles** are values of `exportProfiles` in `seamline.config.json`, keyed by name, validated when the config loads (so `seamline extract` also refuses a bad profile, as it did before). A declared profile may not take a shipped name: `team` means the same thing in every repository.
- **No standalone profile file and no `--profile-file`.** No named consumer needs one (section 6). `--profile` takes a name, and nothing else.
- An absent `exportProfiles` key means none declared. It no longer injects the starter profile; the shipped ones are always available.

### 3.6 One parser, one resolution, one engine

- **Parser:** `parseExportProfile(input)` in `packages/core/src/security/export-profile.ts`. It copies the input to plain data (so an accessor is read once), validates the copy, and returns a deep-frozen, canonical value (every set sorted, so two files that say the same thing are deep-equal and serialize to the same bytes). `parseDeclaredProfiles(exportProfiles)` applies it to the config key and adds the name and shadowing rules.
- **Callers, all of them:** the shipped profiles; `loadConfig` (so `export` and `mcp`); `pinProfile` in `@seamline/mcp` (so an embedder passing an `ExportProfile` to `createServer` gets the same checks). `assertIsAllowList` is removed; there is no second validator.
- **Resolution:** `getProfile(name, declared)`. A shipped name, then a declared one, otherwise an `ExportPolicyError`. Own properties only (`constructor` and `__proto__` are not profiles).
- **Engine:** `applyProfile` (a file) and `profileView` (an agent) share `nodeVerdict`, `edgeVerdict` and the projection. `seamline export` calls `applyProfile`; its own engine is deleted. The withheld report gains two reasons, `provenance-not-allowed` and `untrusted-not-allowed`.

### 3.7 Error messages

Every message names the profile and the field: `export profile 'mine': <field>: <problem>`. A pointer to the documentation is a URL on the public repository (`FORMAT_DOC_URL`), because `docs/` is not in the published packages. Examples, all asserted by the corpus in `packages/core/src/security/__fixtures__/export-profile-cases.ts`:

- ``missing `version`; this build reads export profile format version 1``
- `unknown field "allowAll"; a version 1 profile has only: version, name, ...`
- `found maxSensitivity, nodeKinds, ... from the pre-version-1 profile format, which is not read; see <URL of this document>#5-migration`
- `export profile "two words": the key under `exportProfiles` is the profile's name, and must be 1 to 64 characters ...` (a bad key names the key; it is not reported as a missing `name`)
- `export profile 'mine': an export profile must be a JSON object, found a string`
- `` `allow` admits nothing; refusing to treat an empty allow-list as "everything" ``
- `` `allow[2]` names unknown node kind "Widget" ``
- `` `allowProps.Symbol` names a kind that `allow` does not admit ``
- `` `allowProps` is not empty but `allowFields` does not name `props`, so a file would carry none of those props while the agent surface prints them; add `props` to `allowFields` or empty `allowProps` (see <URL of this document>) ``
- `` `includeUntrusted` is true but `allowFields` does not name `untrusted`, so untrusted text would be written without its marker; add `untrusted` to `allowFields` or set `includeUntrusted` to false (see <URL of this document>) ``

A value echoed into a message is JSON-escaped and truncated, so a control character in a profile cannot reach a terminal.

## 4. Behaviour that changes for `seamline export`

The shipped profiles were unchanged in effect by this unification (a later change removed the lifecycle fields from `public`, section 3.1): they list every provenance level, `includeUntrusted: true` and every record field they always released, which is what they did before those axes were fields, and their export on harbor-books is byte-identical before and after (section 7). Note (2026-11-10): the output from before the unification is not in this repository, so no committed test makes that comparison; `packages/cli/src/commands/export.test.ts` asserts, on a real extraction of `examples/harbor-books`, that each shipped profile exports exactly what the engine releases from the same store and that two exports are byte-identical. For a **declared** profile, moving to the shared engine changes:

1. **Sensitivity is the effective level.** A `Column` labelled `internal` by an extractor is still `confidential`, and a profile admitting `(Column, internal)` does not release it. This is the one change that can withhold something the earlier command released.
2. **`fields` is `allowFields`, and selects the same things.** A declared profile releases the fields it names and nothing else, run ids and `deletedAt` included (section 3.1). Three shape differences, none of which releases more: `props` is written as `{}` when named and nothing matched, where the earlier command left the key out; `srcFile` and `dstFile` are named on their own, as they were before, not implied by `path`; and the keys of each record are written in the canonical order of `RECORD_FIELDS` (`id`, `kind`, `name`, ...), where the earlier command wrote them alphabetically, so a committed export gets a one-time reorder diff.
3. **The report is `withheld`, not `excluded`.** The `--out --json` summary reports `withheld` (counts by reason) in place of `excluded`. It lists no ids; the ids of withheld items never leave through the command.
4. **`--profile team` now works** with `export`, as `packages/cli/README.md` always showed.

Not a change: an edge is released only when both endpoints are. The earlier command walked the edges of each admitted node, so the source was admitted by construction and checking the destination made it both; the withheld edge sets are equal. A dangling endpoint is withheld in both.

## 5. Migration

Note (2026-11-10): no published release read the pre-version-1 format; 0.1.0 is the first release. This section remains because the parser's refusal of an old-shape profile points here (section 3.7).

There is no automatic translation. A lossy translation would widen one of the formats, and a file that is read half-way is the failure this record removes. A file in the old shape is refused with the error in section 3.7, and these are the rules for rewriting it by hand.

| Old field                      | New field                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none)                         | `version: 1` (required)                                                                                                                                                                                                                                                                                                                              |
| `description`                  | `description` (now required)                                                                                                                                                                                                                                                                                                                         |
| `nodeKinds` + `maxSensitivity` | `allow`: for each kind `k`, a pair `[k, s]` for every level `s` from `k`'s default up to `maxSensitivity`. A kind whose default is above the ceiling can never match and is dropped (the starter profile of the earlier format, `public-inventory`, named `Repo`, `Module`, `File` at `public`; they default to `internal`, so it released nothing). |
| `edgeKinds`                    | `allowEdges`                                                                                                                                                                                                                                                                                                                                         |
| `props` (flat)                 | `allowProps`: the same list under each kind in `allow` that should release it, and under `allowEdgeProps` for each edge kind that should; and add `props` to `allowFields` (an old profile with no props adds neither)                                                                                                                               |
| `fields`                       | `allowFields`, name for name (`id`, `kind`, `name`, `path`, `sensitivity`, `provenance`, `confidence`, `sourceRef`, `untrusted`, `firstSeenRun`, `lastSeenRun`, `deletedAt`, `src`, `dst`, `srcFile`, `dstFile`). A name the old profile did not list stays unlisted, so nothing is widened                                                          |
| `provenance`                   | `allowProvenance` (now required and non-empty; an absent list used to release nothing)                                                                                                                                                                                                                                                               |
| `includeUntrusted`             | `includeUntrusted` (now required). If it is true and the old `fields` did not list `untrusted`, the parser refuses the result: add `untrusted` to `allowFields` (its only effect is an `untrusted: true` key on tagged records) or set `includeUntrusted` to false                                                                                   |

Files migrated when this format was adopted: `seamline.config.json`, `examples/harbor-books/seamline.config.json`, and the profile `seamline init` scaffolds.

**The starter profile is renamed `structure` and releases more than its predecessor.** The earlier `public-inventory` released nothing (its kinds default to `internal`, above the `public` ceiling it named). `structure` names the level its kinds actually have, so it releases a structural inventory: file paths, the module tree and the import graph. That is internal-level information, and the name no longer says "public". Its description says so, and so does the output of `seamline init`. It remains a template to narrow or widen on purpose, not a default to ship. It does not release run ids.

## 6. Consumers, and what stays out

**Named consumers:** `seamline export`; `seamline mcp` and `@seamline/mcp`'s `createServer`; and the alignment packet of ADR-0014.

**The alignment packet (see `alignment.md`).** That design adds an optional `packets: ['alignment']` key to the profile, absent meaning none, and requires a profile opt-in to emit any packet. This format is built for that, and the note below is the contract between the two changes.

- **Where `packets` goes.** It is an additive optional key whose absence denies (section 3.4), so it lands inside version 1, in the change that implements alignment. That change adds the name to `EXPORT_PROFILE_FIELDS`, the field to the `ExportProfile` type, an optional (not `required`) property to `docs/reference/export-profile.schema.json`, and an accepted and a rejected fixture to the corpus. It leaves the key out of the canonical output when it is absent, so the shipped profiles stay deep-equal to what they are now. An older build reading a file that uses it refuses it as an unknown field, which fails closed. It is **not** added now, because nothing consumes it and vocabulary without a consumer is the pattern `AGENTS.md` warns against. Note (2026-11-10): the key is implemented in 0.1.0 as this bullet describes (`EXPORT_PROFILE_FIELDS`, `PACKET_KINDS` and `ExportProfile.packets` in `packages/core/src/security/export-profile.ts`, and the `packets` property of the schema); its consumer is `seamline align --profile <name>` (`packages/cli/src/commands/align.ts`), and the repository's own `seamline.config.json` declares an `alignment` profile that uses it.
- **The packet's sensitivity is a per-kind statement, not a ceiling.** `maxSensitivity` is not a field of this format: `allow` lists `(kind, sensitivity)` pairs, so there is no single level to compare a packet against. Alignment's packet export therefore needs a per-kind statement: for every node kind a packet carries, the profile's `allow` must admit that kind at the level the packet's content has, and a packet whose content spans kinds is released only if every one of them is admitted. That is a rule for the alignment change to write down and test; this change does not decide it.
- **Two lines of that design refer to the old shape** and need rewording when it lands: the citation of the type at `packages/cli/src/config.ts:31-45` (the type now lives in `packages/core/src/security/export-profile.ts`), and "`maxSensitivity` must be at least the packet's sensitivity". Note (2026-11-10): both are reworded; `alignment.md` section 8.8 states the per-kind rule.
- **One resolver.** The alignment change can reuse `resolveProfile(config, name)` from `@seamline/cli` rather than add a third lookup. Note (2026-11-10): as implemented, `seamline align` reads the named profile from the config's `exportProfiles` directly and does not call `resolveProfile`, because only a declared profile can carry `packets` (the shipped profiles name none), see `packages/cli/src/commands/align.ts`.

**The semantic layer's disclosure stays its own optional layer.** The inventory shows it does not use `ExportProfile`: `RecordFilter` and `ReleaseScope` (`packages/core/src/semantic/disclosure.ts`) allow-list registry type ids and field names, a different vocabulary. ADR-0015 says its "Profile" is not an export profile, and limits the layer to five named imports, none of which is the security parser. Nothing here changes that, and the layer neither reads nor emits this format.

**Out of scope, each needing a named consumer and its own pass:** a standalone profile file or `--profile-file`; YAML; profile inheritance; a `migrate` command; tightening the shipped profiles further (for example excluding `INFERRED` nodes from `public`; the run ids and `deletedAt` were left out of `public` before 0.1.0, section 3.1); strict unknown-key handling for the rest of `seamline.config.json` (only `exportProfiles` is strict here).

## 7. Tests

- `packages/core/src/security/export-profile.test.ts`: the corpus (`__fixtures__/export-profile-cases.ts`) is grouped by the part of the profile it checks, most groups have rejected fixtures with the precise message, the baseline profile covers the accepting side of most rules, and the rules whose accepting side is a boundary (an empty list, a wildcard, the longest description in characters and in emoji) have an accepted fixture of their own; the JSON Schema file and the parser agree on the whole corpus, the schema's vocabulary equals the live contract constants, every shipped profile validates against the schema; provenance and untrusted decisions in `applyProfile` and `profileView`; shipped profiles still release inferred and untrusted nodes; canonical form and deep freeze; resolution refuses inherited names.
- `packages/core/src/security/export-policy.test.ts`: a file carries exactly the fields the profile names (nodes and edges), never the run ids or `deletedAt` unless named, `team` and `audit` keep releasing every field while `public` releases neither locations nor lifecycle fields and writes the same bytes whatever run stamped the records, and the view keeps what traversal reads while stripping locations.
- `packages/cli/src/commands/export.test.ts`: a profile that allows props without `props`, or sets `includeUntrusted` without `untrusted`, is refused with no output; a migrated profile with `fields: [id, kind, name]` releases exactly those keys (plus `props` when named); no profile, no output; an old-format or unknown-field profile is refused with no output; shipped names cannot be shadowed; on a real extraction of `examples/harbor-books`, each shipped profile exports exactly what the engine releases, `export` and `mcp` release the same set for a declared copy of a shipped profile, and two exports are byte-identical.
- `packages/mcp/src/profile.test.ts`: the server refuses a profile with no `version`, an unknown field, props without `props` among the fields, or `includeUntrusted` without `untrusted`, and still pins a copy; `explain` prints the run ids and `deletedAt` only when the profile names them.
- `packages/mcp/src/agent-surface.test.ts`: the contract of section 3.2. Profiles that differ only in fields outside the location and lifecycle groups give byte-identical `context` and `explain` answers; the props that print are the ones `allowProps` names; no location or lifecycle value prints unless named; and every registered tool, called under a profile that names no lifecycle field, prints no run id and no `deletedAt`.

The drift guard for the schema is deliberately a test, not a generator: the schema is a reviewed reference file, and a new node kind fails `export-profile.test.ts` until the file lists it.

### Structured-document availability under projection

Before projecting nodes, `profileView` checks the measured `unreadStructuredDocuments` count on fact Contract and Operation nodes. A missing, invalid or nonzero count makes the projected `contracts` scope UNAVAILABLE when its producer otherwise reports PASS. Existing FAIL and UNAVAILABLE statuses remain unchanged. Only this availability status crosses the profile; withheld nodes, counts and source paths do not. This prevents a profile from hiding the current coverage witness while retaining older operations stamped with zero. The conservative status also withholds present-fact contract detectors in that view. The source graph still permits present-fact comparisons and makes X9 UNKNOWN through its own coverage gate. This rule is tested in `packages/core/src/security/export-policy.test.ts`.
