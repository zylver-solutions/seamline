# Using the semantic foundation

The semantic foundation adds extensible domain state to Seamline while preserving the existing code-analysis ontology, extraction store and SIF behavior. It is a working local library with behavioral and integration tests. It is not a hosted service or a migration of existing applications. It is an optional layer: the contradiction pipeline does not import it and a default run does not load it ([ADR-0015](adr/ADR-0015-semantic-engine-optional-profile-layer.md)).

Status (2026-11-10): this page describes what ships in 0.1.0 (`packages/core/src/semantic/`). Its implementation specification is [design/semantic-foundation.md](design/semantic-foundation.md). The broader target design in [design/atelier-composition/](design/atelier-composition/README.md) is a design record and is not implemented beyond what this page lists.

## Quick example

After building the repository, run:

```sh
node examples/semantic-world/demo.mjs
```

The example defines an equipment extension, creates a world, transfers custody of a tool, damages it through an extension command, queries its placement, and reads its earlier state. The equipment extension requires no kernel edits.

The public import is:

```ts
import {
  CompiledRegistry,
  SemanticEngine,
  builtInProfiles,
  type Profile,
} from '@seamline/core/semantic';
```

## What is implemented

| Building block   | Behavior                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profiles         | Exact version dependencies, namespace ownership, collision/cycle rejection, immutable compilation, deterministic declaration/registered-function fingerprint                |
| Types and facets | Reusable recursive facets, strings/enums, booleans, finite numbers, safe integers, lists, records, typed entity references and explicitly opaque JSON                       |
| Unknown values   | Fields can opt into `{$state: 'unknown' \| 'unavailable' \| 'redacted' \| 'notApplicable', reason?: string}`; distinct from optional absence and explicit nullable values   |
| Relationships    | Typed/faceted endpoints, structured properties, exclusive source/target cardinality and acyclic relations                                                                   |
| Universes/worlds | Tenant-scoped universes pin a compiled registry; each world has its own identities, timelines and state                                                                     |
| Timelines        | Named integer-tick timelines with a positive rational ticks-per-unit timebase; records on different timelines do not silently compare                                       |
| Branches         | Fork a pinned revision into an independent branch; parent edits cannot leak into the fork                                                                                   |
| History          | Valid-time half-open intervals and recorded revisions; immutable snapshots plus accepted command metadata and receipts                                                      |
| Transactions     | SQLite `BEGIN IMMEDIATE`, expected revision, atomic validation/rollback, and payload-aware retry receipts                                                                   |
| Identity         | Stable world-scoped category/type persists even when every active interval is deleted; labels and state can evolve                                                          |
| Query            | Typed outgoing traversal with depth/result/work bounds and explicit truncation; record filter, or admin opt-in for classified registries                                    |
| Export           | Explicit type/field allowlist; record filter required for classified types unless an admin opts out; endpoints omitted when the related entity is not included              |
| Legacy bridge    | Actual extracted code nodes/edges enter the semantic store with redaction, source status and provenance; tests traverse real TypeScript CALLS output after reopening SQLite |

All writes flow through registered command handlers and the same final-state schema/invariant validation. Command input and output are checked at runtime; a custom extension cannot become validated merely by assigning an arbitrary type name.

## Built-in domain packs

`world@1.0.0` supplies agents, places, objects, coordinate frames, poses and observations. Reusable facets include locatable, container, ownable, agent and described. Commands create and update validated records, bind relationships, move entities and record poses. Placement is exclusive and acyclic; inherited location follows the typed placement chain. Poses check the declared frame dimension, but no transform solver is provided.

`inventory@1.0.0` supplies stock, reservations, ownership, custody and equipment. Its commands create/consume/transfer stock, reserve/release capacity, transfer ownership, lend/return items and equip/unequip. Quantities are canonical nonnegative integer strings in a declared base unit, using exact arithmetic up to 78 digits. Unit and commodity must match for transfer; reservations cannot exceed stock. Custom conserving transformations can split stock without privileged kernel changes. Minting and consumption have explicit trusted command boundaries. Ownership transfer does not move an object. Equipment requires matching custody.

`authoring@1.1.0` supplies story, beat, scene, shot, take and edit-placement definitions. `authoring.record` atomically upserts an `entities` list and optional `relations`, with explicit `removeEntities` and `removeRelations` lists (at most 100 entries per list). Only authoring records can be changed by this command; world subjects are created separately. Omission preserves existing records. Ordinary engine revisions, retry receipts and final-state reference validation apply.

Typed `hasScene`, `hasShot`, `hasTake` and `hasPlacement` edges support bounded traversal from a story to its edit placements. Edges must agree with the corresponding typed reference properties. `hasBeat` accepts an optional nonnegative `order`, unique within the story when supplied. Placements have positive durations and safe integer end ticks. See the [authoring integration specification](design/atelier-authoring-integration.md), written for a private downstream application called Atelier, for the consumer and acceptance requirements. Upgrading from 1.0.0 changes the registry fingerprint and requires a future explicit migration for existing universes.

Subjects and local relationships are typed. Snapshot tuples and external artifact strings are **authored references**, not proof that another world/revision or media artifact exists. Verification status is declared metadata; the engine does not inspect images. There is no genre or fixed cast in these definitions.

`software@1.0.0` supplies source revision, build, artifact, environment, deployment, incident, requirement and test-evidence definitions, with artifact lineage. It can run without a world/physical inventory pack. These are usable domain definitions and recording commands, not new build/deployment extractors or automatic verification of requirement satisfaction.

`code@1.0.0`, exposed as `legacyCodeProfile`, maps the actual legacy ontology kinds and exact endpoint signatures. `code.import` takes a complete materialized live graph for one repository and a run record, not incremental extractor output mixed with absent retained rows. It replaces only that repository's code projection. A transition invariant prevents other commands from rewriting imported code facts or source status; custom domain relationships to code remain allowed. Duplicate scoped legacy edges must be resolved by the source graph; the bridge rejects them rather than discard evidence arbitrarily. History starts at the first import; it does not invent previous versions from last-seen/tombstone metadata.

## Extending the engine

A `Profile` owns namespaced types, facets, relation definitions, commands and invariants. References to another pack require a direct exact dependency. Facet composition can inherit compatible fields; conflicting definitions fail at compilation. Built-in packs use this same mechanism.

Handlers are synchronous trusted functions of supplied context and input. They must be deterministic and free of external side effects: do not read wall-clock time, network data, mutable closure state or unrecorded randomness. An invariant receives detached frozen before/after snapshots and the command name. Throwing rejects the entire transaction, including identity assignments and its receipt.

Fingerprints include declarations, command/invariant versions and registered function source. They detect declaration and registered-function changes, but do not hash transitive helper implementations or captured closure values. Extension authors must bump versions whenever those dependencies change; hosts that need artifact integrity must pin the deployed package artifact separately. Type-stripped source and emitted JavaScript may have different fingerprints because their formatting differs. Reopen with the same deployed artifact. Moving a world to a different fingerprint currently requires a future explicit migration; mismatched registries fail closed. Compile a new registry before creating a new universe. Existing universes are not live mutable registries.

Opaque JSON supports external structured evidence, but it does not acquire typed-reference validation or semantic reasoning. Use declared record/list/ref schemas whenever the engine should understand a property.

## Temporal semantics

`submit` uses `validAt`, an optional exclusive `validUntil`, and `expectedRevision`. `snapshot` chooses a timeline/domain time and an optional recorded revision. A bounded descriptive correction changes current knowledge of an interval while old recorded revisions retain their original view.

A mutation cannot cross a later change boundary of a touched record. Retained per-record barriers preserve those boundaries even after complete deletion, across revisions, forks and reopen. Bound a descriptive correction at the next change or explicitly replan; the engine does not silently undo later operations. Named stock creation/consumption/transfer/reservation operations reject finite intervals so an economic effect cannot disappear automatically at an expiry boundary. Reservation release is an explicit operation.

Persistence uses bounded full temporal snapshots for each revision. `history` returns accepted command name, actor, valid interval, previous revision and receipt. Raw arguments are not stored in receipts; only their actor-bound digest is retained, so imported source secrets cannot leak through an audit copy of the request. This supports historical reconstruction and idempotent retries, **not replaying reducers from a full event log**. A fork's own history begins at its revision zero; the pinned parent snapshot supplies the inherited state.

No automatic branch merge, calendar/clock conversion, causal event scheduler or schema migration is exposed. Different timelines remain explicit, independent coordinates. Snapshot references in authoring records are not dereferenced by the kernel.

## Trust, disclosure and bounds

The host constructs a handle with tenant, actor and an `authorize` callback. Only literal `true` authorizes an operation; promises and other truthy values are rejected. This is an embedding contract, not authentication: never construct a privileged handle directly from untrusted client strings. A host can restrict reads/writes/admin/export by world and branch. Field-level private perspective authorization and a network protocol are not included.

Queries and snapshots are authorized reads, default-deny for classified data as described below. Export adds an explicit allowlist and export authorization. Allowlisting a property deliberately releases its value, including any references it contains; hosts must choose policies accordingly.

A field can carry a classification when its schema holds a string enum or a boolean, at the top level or inside a list or record; opaque `json` counts too, because it can hold any value. Reading is default-deny for such data. Without a record filter, a snapshot or query is refused when any type in the registry has such a field, and an export is refused when any allowlisted type, or any type their `ref` fields and relation endpoints can point at, has one. The admin-only way past that refusal is `unfiltered: true`, on the request for snapshot and query and on the policy for export. It requires `admin` authorization from the host callback, on the branch being read and on every source branch it was forked from (a fork holds its sources' records), in addition to `read` or `export`. It cannot be combined with `where`, and it releases records as they are stored. Registries, or exported types, with no such field still read without a filter. A request or policy is copied once on entry, and a property defined by a getter is rejected, so no later check can see a different value.

A type and field allowlist releases every record of an allowed type. To release only some of them, pass a record filter as `where` on a snapshot or query request, or on the export policy. For example, `{'notes.note': {visibility: ['public']}, 'notes.person': {visibility: ['public']}}` releases a note or person only when its `visibility` is `public`. Snapshot, query and export apply a filter through one shared read path, and a record is released only when all of the following hold:

- **It passes the filter in every version.** A filter maps entity or relation types to their enum fields and allowed values. Every named field must hold one of the listed values; an absent, null or uncertain value is withheld. The check covers every version of the id recorded at the head revision, on every timeline and valid-time interval, so a record classified private at any valid time is withheld at every `validAt`. Fields, types, and a policy filter together with a request filter all combine with AND.
- **Its references stay inside the released set.** A record whose released fields reference (through a declared `ref` field, directly or inside a list or record) an entity that is not released is withheld too, transitively, whatever its type. "Not released" includes an entity withheld by the filter, an entity of a type outside the export's type allowlist, and an id that is not in the snapshot. A reference in a field that the export does not release withholds nothing, because it is not released. A relation needs both endpoints released. The engine withholds the referrer rather than nulling the reference, because a nulled reference can violate the field's schema and would read as stored state; released records are never rewritten.
- **Its classification can be named.** A filter can name only top-level enum fields. Records of a type with a classification a filter cannot name (an enum inside a list or record, such as `labels: ['private']` or `meta.visibility`, or any boolean, such as a restricted flag) are withheld under every filter, whatever their values, and so are records that reference them. A filtered export that allowlists such a type is rejected, because none of its records could be released. This rule depends on the schema alone. The `code` profile's types carry an `untrusted` boolean, so under a filter they are withheld, and they leave only through an admin unfiltered export.
- **It releases no opaque json.** A `json` value is not interpreted and could carry any id, so a filtered snapshot or query withholds every record that holds a non-null `json` value, and an export policy with a filter that allowlists a field containing `json` is rejected.

The filter itself is checked before anything is read, and fails closed:

- It must name every releasable type that has a top-level enum field, except types withheld wholesale because their classification cannot be named. For snapshot and query every registered type is releasable; for export, the allowlisted types plus every type their `ref` fields and relation endpoints can point at. A type without a top-level enum field cannot be classified by a filter; its records are released subject to the reference and json rules. To release every record of a named type, list every value of a required enum field. With large registries, export is the practical path, because its type allowlist bounds which types the filter must name.
- A filter that names an unknown type or field, a field that is not an enum, a value outside the enum, or a repeated value is rejected. An empty filter is rejected rather than read as "release everything".
- A filtered read uses the head revision: a request with both `where` and `revision` is rejected. Withholding by the head classification keeps valid-time reads available, but checking an earlier revision against every later one would require loading all intervening revisions, and a record deleted after being reclassified leaves nothing at head to check. Rejecting the explicit revision is the option that can be verified exactly.
- A filtered read of a fork also follows its sources. A branch created by `fork` inherits its source's state at the fork point. Under a filter, an inherited record is withheld when the source branch's head no longer holds it, or holds a version of it that fails the filter. This applies along the whole chain of sources, so reclassifying or removing a record on the source also hides it on every fork taken earlier. Records created on the fork itself are judged by the fork's own versions. Unfiltered reads of a fork are unchanged.
- `history` with `where` is refused: it lists the command id, actor, valid time and ledger fingerprint of every accepted command, including commands that only touched withheld records, and cannot be filtered per record.

A query starts from and walks through released records only. A withheld start id gives the same result as an unknown id, and traversal steps count released records only. Without `where`, history behaves as before; snapshot, query and export behave as before only when nothing they may release can carry a classification, and otherwise need an admin `unfiltered: true`.

What a filter does not hide: the returned `revision` is the branch head, which counts every accepted command, including ones that only changed withheld records. It is the branch's concurrency token, so a filtered reader can learn how many commands were accepted, but not what they changed. Plain strings are released as stored and are not interpreted as references. Record filters are per call: there is no filter bound to the handle, so a host serving a less trusted reader must pass it on every read and export, and must not expose `history` without it. Filters narrow what reads and exports release; commands, invariants and their validation errors still see the full state.

Legacy import applies the existing redactor even if the caller bypasses the preparation helper. As everywhere else (ADR-0013), a closed-format credential in an id, `path`, `sourceRef` or locator prop makes the import throw `RedactionError` instead of rewriting the identity. Raw code-source properties remain sensitive according to their metadata and host policy.

Generic traversal does not interpret code source availability. Before treating missing code data as meaningful, consumers must use `legacyScopeStatus`; `UNAVAILABLE` is never a clean result. `legacyIsFact` preserves the legacy extracted/declared versus inferred/suggested distinction. A readable record is not automatically a verified fact.

Current conservative limits:

- 128 profiles; schema/value nesting and count budgets enforced by the registry.
- 2,000 active entities and 4,000 active relations per validated snapshot.
- 12,000 temporal records plus retained barriers combined, 512 temporal boundary points, and 4 MB per serialized state/request budget.
- 16 timelines per world.
- Traversal: 64 starting IDs, 32 relationship kinds, depth 8, 500 results, 10,000 traversal steps maximum.
- History: at most 500 entries per call, with revision pagination.
- Record filters: at most 128 types per filter.

These are intentionally bounded local foundation limits, not a large-codebase scale claim. Traversal step budgets cover traversal work; bounded snapshot materialization is additional work. Revision retention is currently caller-managed through keeping/replacing the database; no automatic pruning or history compaction is implemented.

## Verification

Tests cover profile failures and immutability, custom equipment behavior, conserving stock extensions, precision, custody, temporal corrections, branch isolation, identity retention, two-handle write conflicts, rollback, reopen, export restrictions, record filters applied alike to snapshot, query and export (including a randomized property test over several types, cross-type references, relations, valid-time versions and revisions that no output releases a withheld id or value), classification that a filter cannot name, default-deny export with its admin opt-out, filtered reads of forks, and a real extractor-to-store bridge. The [council review record](audit/2026-09-09-semantic-council.md) documents findings and fixes. The existing code-analysis suite remains the regression baseline.
