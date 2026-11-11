<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# The Seamline ontology

`seamline.yaml` is the normative vocabulary for Seamline: **29 node kinds and 26 edge kinds**, with **every edge declaring its domain and range as an enumerated list of (source, target) pairs**, plus the provenance, sensitivity, extractor-status, and contradiction-code enumerations.

It describes one thing that nothing else in this space describes: a **field-level join across code, data, and contract**. A database column, the ORM or model field it maps to, the API schema property it is exposed as, the validator that checks it, and the tests that cover it, addressed in a single vocabulary with a single identity scheme. Backstage stops at the component. FINOS CALM stops at the architecture node. SCIP stops at the symbol. DataHub has no domain or contract layer.

**Scope:** this ontology describes code artifacts so that their consistency can be checked; it does not model business concepts for agents to query, which is the job of business-data ontologies such as the one built by AWS's [Context Ontology Accelerator](https://github.com/aws/context-ontology-accelerator).

It is written in [LinkML](https://linkml.io) syntax. Two files are written by hand and one is generated:

- `ontology/seamline.yaml` is hand-written. It is the normative specification.
- `packages/ontology/src/contract.ts` is hand-written. It is the TypeScript mirror every package compiles against, and `ontology/lint.mjs` fails when it and the YAML disagree.
- `docs/reference/ontology.md` is generated from the YAML and the extractor manifests by `scripts/gen-ontology-ref.mjs` (`pnpm gen:ontology-ref`). It is never edited by hand.

No LinkML generator runs in this repository. No JSON Schema or TypeScript types are generated from the YAML. The SQL DDL of the store is generated at run time from the arrays in `contract.ts` (`packages/core/src/store/schema.ts`), not from the YAML; the lint is what keeps the two in step.

## Licence and independent adoption

**The ontology is CC-BY-4.0.** The tooling is Apache-2.0. They are different licences on purpose, and they carry **separate version numbers**, on purpose.

A vocabulary that can only be used by running our code is not a vocabulary; it is a data format. Seamline is more useful to everyone, including us, if the vocabulary can be adopted on its own: by a tool written in another language, by a team that wants the field-level join concept without our extractors, or by a specification that wants to align its own terms with ours. CC-BY asks for one thing in return, which is attribution.

Concretely, this means:

- `ontology/seamline.yaml` and the reference page generated from it are **CC-BY-4.0**.
- Everything under `packages/` is **Apache-2.0**.
- The ontology version and the `seamline` package version are **independent**. Ontology 1.x is not "whatever shipped with tool 1.x": the ontology is at 1.0.0 and the packages are at 0.1.0. A store records the ontology version it was first written with and refuses a run that states a different one (`assertOntologyVersion` in `packages/core/src/store/schema.ts`). That is an equality check, not a declared range of readable versions.

See `docs/adr/ADR-0010` for why the code is Apache-2.0 and not MIT. The short version: the real licence risk in this project is code-derivation from Apache-2.0 peers, and Apache-2.0 code cannot be relicensed as MIT.

## The compatibility policy

**Additive-only within a major version. A breaking change requires a major version bump, and is expected to be rare enough to be an event.**

The reason to be this strict is specific, and it is worth understanding before proposing a change. Breaking a published ontology invalidates **three things at once**:

1. **Persisted graphs.** Every store anyone has built, in their own repository, on their own disk. We do not control those and cannot migrate them.
2. **Third-party extractors.** Anything written against the vocabulary by anyone else, including code we have never seen.
3. **Stored queries.** Saved traversals, dashboards, CI configuration, and anything a user wrote that names a kind or an edge.

There is no pin that escapes this, because the graph lives inside the user's repository rather than in a service we operate. A version we can roll back on a server is a different kind of problem from a version that is already on ten thousand laptops.

### Additive, allowed in a minor version

- Adding a **new node kind** or a **new edge kind**.
- Adding a **new (source, target) pair** to an existing edge kind.
- Adding an **optional slot**.
- Adding a **permissible value** to an enumeration, _provided_ consumers are specified to tolerate unknown values in that enumeration. Where they are not, this is breaking.
- Promoting a kind from `extended` to `core`. Extended kinds are inert, so activating one adds behaviour without changing any existing behaviour. This is exactly why the `extended` profile exists.
- Tightening documentation, descriptions, and examples.

### Breaking, requires a major version

- Removing or renaming a node kind, an edge kind, or a slot.
- Removing a (source, target) pair from an edge kind: something that used to validate now does not.
- Making an optional slot required.
- Narrowing a slot's range.
- Changing the **natural key** for a kind. This is the most expensive change available, and it is easy to under-estimate: a natural key change rewrites every node id of that kind and every edge that references one. Nothing in any persisted graph survives it.
- Changing the meaning of an existing term while keeping its name. This is the most dangerous change, because no tool detects it. Prefer a new term and deprecate the old one.

### Deprecation

A term scheduled for removal is marked deprecated in the minor release _before_ the major that removes it, with the replacement named in its `description`. Removal without a deprecation release is itself a policy violation, independent of the version number attached to it.

### How this is enforced

The compatibility policy is not checked mechanically. No script or test in this repository compares one version of the ontology with the previous one, so nothing fails the build when a breaking change lands without a major bump. A reviewer applies the policy by hand, using the lists above. Only version 1.0.0 has been published, so no comparison has been needed so far.

What is checked mechanically is narrower, and both checks run in `pnpm verify` and in CI (`.github/workflows/ci.yml`):

- `pnpm gate:ontology` runs `ontology/lint.mjs`: the YAML and `contract.ts` describe the same vocabulary (next section).
- `pnpm gate:ontology-ref` runs `scripts/gen-ontology-ref.mjs --check`: the committed `docs/reference/ontology.md` is what the generator produces from the current YAML. `scripts/gen-ontology-ref.test.mjs` tests the generator itself.

Neither check can see the "changed the meaning, kept the name" case, which is why that case gets a named warning here.

## Agreement with the TypeScript contract

`packages/ontology/src/contract.ts` is the implementation seam every Seamline package compiles against. It and `seamline.yaml` describe the same vocabulary and **must agree exactly**.

`ontology/lint.mjs` is the control. Run it:

```
pnpm gate:ontology
```

That is `node --experimental-strip-types ontology/lint.mjs`. Zero dependencies. It parses `seamline.yaml` and imports `contract.ts` directly (Node type stripping), then asserts:

| Check        | Assertion                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------- |
| node kinds   | classes deriving from `SeamlineNode` equal `NODE_KINDS`, exactly, in both directions          |
| edge kinds   | classes deriving from `SeamlineEdge` equal `EDGE_KINDS`, exactly, in both directions          |
| signatures   | every edge's declared (source, target) pairs equal `EDGE_SIGNATURES`, exactly                 |
| enumerations | every enumeration's permissible values equal the corresponding contract list                  |
| sensitivity  | every kind's declared default equals `DEFAULT_SENSITIVITY`                                    |
| profile      | every class pins a `profile`, and everything currently authored is `core`                     |
| kind pinning | every class pins `kind` to its own class name                                                 |
| reachability | every node kind is the source or target of at least one edge, or carries a waiver stating why |
| determinism  | no `created_at` / `updated_at` / timestamp slot exists                                        |

Exit 0 clean, 1 divergence, 2 could not run.

**The lint reports divergence; it never repairs it.** `contract.ts` is frozen and other packages compile against it, so a mismatch is a finding for a human to resolve, not something a linter should silently reconcile in either direction.

## Two things a reader will notice

**`created_at` and `updated_at` are deliberately absent.** Byte-identical output across two consecutive runs is a release gate (`docs/adr/ADR-0009`), and a wall-clock timestamp in a node or edge body makes that impossible in principle: two extractions of an unchanged repository would then differ in every row. Time belongs to the `Run`, not to the fact. Lifecycle is expressed in run ids instead: `first_seen_run`, `last_seen_run`, `deleted_at`. The lint enforces the absence, so this cannot be reintroduced by accident.

**Four kinds have no edges.** `TestRun`, `Contradiction`, `Lens`, and `ThreatModel` are the source or target of nothing, and each carries a `seamline_unreachable_waiver` with a stated reason on the class itself. The reasons differ and are worth reading: `Contradiction` has no edges _by design_ (it references its two facts through fields, because making them edges would be the reification v3 removed), while the other three are reserved kinds whose edges arrive with deferred features. A waiver is a recorded decision, not a suppression: an unwaived unconnected kind fails the lint.

## Changing the ontology

1. Edit `seamline.yaml`. It is the hand-edited specification; `contract.ts` is the other hand-written file, and step 3 covers it.
2. Run `pnpm gate:ontology`.
3. If the change also needs `contract.ts`, **stop and coordinate.** The contract is shared and frozen; every package compiles against it.
4. Classify the change against the compatibility policy above and version accordingly.
5. Regenerate the one derived file. Never hand-edit it. `pnpm gen:ontology-ref` rewrites the readable reference at [`docs/reference/ontology.md`](../docs/reference/ontology.md) from `seamline.yaml` and the extractor manifests, and `pnpm gate:ontology-ref` fails when that file is stale.
