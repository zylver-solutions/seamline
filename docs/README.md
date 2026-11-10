# Documentation index

Every document under `docs/`, grouped by what it is for, with its status as of 2026-11-10 (the day version 0.1.0 was published). The status given here is a summary; each document's own status line governs.

Where two documents disagree, [design/v3.md](design/v3.md) is the authoritative design, and `packages/ontology/src/contract.ts` is the ground truth for node kinds, edge kinds and provenance values. Start with the [root README](../README.md) for what the tool does and what does not work yet.

## Using Seamline

| Document                                         | What it covers                                                                             | Status                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------ |
| [conformance.md](conformance.md)                 | Running `seamline conformance` on an extractor you wrote                                   | Current, describes 0.1.0 |
| [semantic-engine.md](semantic-engine.md)         | The optional semantic layer (`@seamline/core/semantic`): what it implements and its limits | Current, describes 0.1.0 |
| [canonical-authority.md](canonical-authority.md) | Canonical authority claims, SQLite store version 2 and SIF version 2 compatibility         | Current, describes 0.1.0 |
| [toolchain.md](toolchain.md)                     | Build conventions that bind every package                                                  | Current                  |

## Design

| Document                                                                               | What it covers                                                                           | Status                                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [design/v3.md](design/v3.md)                                                           | The applied design: invariants, storage, ontology, contradiction catalog, deferred items | Authoritative; dated notes mark where 0.1.0 differs                  |
| [design/aspirational-state.md](design/aspirational-state.md)                           | What "finished" means at 1.0, the admission test for new capabilities, non-goals         | Target, not a description of 0.1.0; subordinate to v3                |
| [design/alignment.md](design/alignment.md)                                             | The alignment report (`seamline align`)                                                  | Implemented in 0.1.0                                                 |
| [design/conformance-suite.md](design/conformance-suite.md)                             | Design record of the extractor conformance suite                                         | Implemented in 0.1.0                                                 |
| [design/export-profile.md](design/export-profile.md)                                   | One export profile format and parser                                                     | Implemented in 0.1.0                                                 |
| [design/precision-boundaries.md](design/precision-boundaries.md)                       | What X1 and X2 withhold, and join eligibility                                            | Implemented in 0.1.0                                                 |
| [design/zod-composition-coverage.md](design/zod-composition-coverage.md)               | Static Zod composition and degradation per schema                                        | Implemented in 0.1.0                                                 |
| [design/json-document-comments.md](design/json-document-comments.md)                   | Comments in `.json` contract documents                                                   | Implemented in 0.1.0                                                 |
| [design/real-world-inputs.md](design/real-world-inputs.md)                             | ORM data access, column-level writes, test facts and the evaluation corpus               | Design record; see its status line and v3 section 9 for what shipped |
| [design/x7-upper-length.md](design/x7-upper-length.md)                                 | X7: unbounded request strings reaching finite-length storage                             | Implemented in 0.1.0; real-source acceptance unmet                   |
| [design/library-effect-certificates.md](design/library-effect-certificates.md)         | Library effect certificates for the X7 producer                                          | Implemented in 0.1.0; real-source acceptance unmet                   |
| [design/get-query-copy-effects.md](design/get-query-copy-effects.md)                   | Amendment to the X7 design for a closed GET query-copy loop                              | Implemented in 0.1.0; real-source acceptance unmet                   |
| [design/x8-migration-replay.md](design/x8-migration-replay.md)                         | X8: references checked against migration replay order                                    | Implemented in 0.1.0; real-source acceptance unmet                   |
| [design/extract-data-contributing-files.md](design/extract-data-contributing-files.md) | Tables whose other contributing file is unread                                           | Proposal, not implemented                                            |
| [design/external-symbols.md](design/external-symbols.md)                               | Stub nodes for decorators declared outside the repository                                | Proposal, not implemented                                            |
| [design/semantic-foundation.md](design/semantic-foundation.md)                         | Specification of the optional semantic layer                                             | Implemented in 0.1.0                                                 |
| [design/atelier-authoring-integration.md](design/atelier-authoring-integration.md)     | The `authoring` pack, version 1.1.0                                                      | Implemented in 0.1.0                                                 |

The directory `design/atelier-composition/` holds a broader target design for the semantic layer, dated 2026-09-09. It is a design record and is not implemented beyond what [semantic-engine.md](semantic-engine.md) lists: [README](design/atelier-composition/README.md), [design](design/atelier-composition/design.md), [semantic engine](design/atelier-composition/semantic-engine.md), [codebase intelligence](design/atelier-composition/codebase-intelligence.md) and [review](design/atelier-composition/review.md) (with the script `review-probes.py`).

## Decisions

Architecture decision records, indexed with their context in [adr/README.md](adr/README.md). All are accepted; each record's own status line says where a later record amends it and what 0.1.0 implements.

- [ADR-0001](adr/ADR-0001-core-profile-ontology.md): the core profile ontology
- [ADR-0002](adr/ADR-0002-path-free-natural-key-identity.md): path-free natural-key identity (amended by ADR-0016)
- [ADR-0003](adr/ADR-0003-run-lifecycle-tombstones-status.md): run lifecycle, tombstones and extractor status (extended by ADR-0018)
- [ADR-0004](adr/ADR-0004-sqlite-relational-storage.md): SQLite and a relational schema, no graph database
- [ADR-0005](adr/ADR-0005-contradictions-not-gaps.md): contradictions, not gaps
- [ADR-0006](adr/ADR-0006-security-spine.md): the security spine
- [ADR-0007](adr/ADR-0007-provenance-precedence-fact-label-separation.md): provenance precedence and fact/label separation
- [ADR-0008](adr/ADR-0008-oss-github-actions-exception.md): GitHub Actions for open-source publishing
- [ADR-0009](adr/ADR-0009-determinism-release-gate.md): determinism as a release gate
- [ADR-0010](adr/ADR-0010-licensing-apache-cc-by-dco.md): Apache-2.0, CC-BY-4.0 and DCO
- [ADR-0011](adr/ADR-0011-redactor-wired-as-sole-writer.md): the redactor as sole writer to the store (amended by ADR-0013)
- [ADR-0012](adr/ADR-0012-extensible-semantic-foundation.md): the extensible semantic foundation
- [ADR-0013](adr/ADR-0013-redactor-never-rewrites-identity.md): the redactor never rewrites identity or locator fields
- [ADR-0014](adr/ADR-0014-alignment-drift-classes-and-finding-packet.md): alignment drift classes and the finding packet
- [ADR-0015](adr/ADR-0015-semantic-engine-optional-profile-layer.md): the semantic engine stays an optional layer
- [ADR-0016](adr/ADR-0016-file-identity-carries-its-path.md): `File` is the one kind whose id carries its path
- [ADR-0017](adr/ADR-0017-validated-write-contract-identity.md): identity of a locally bound write contract
- [ADR-0018](adr/ADR-0018-canonical-name-authority.md): authority confined to a known contract identity

## Reference

- [reference/ontology.md](reference/ontology.md): the ontology reference, generated from `ontology/seamline.yaml`. Do not edit by hand.
- `reference/export-profile.schema.json`: JSON Schema of the export profile format described in [design/export-profile.md](design/export-profile.md).

## Contradictions

[contradictions/README.md](contradictions/README.md) indexes one page per contradiction code and defines the status terms. Each page states what its detector compares, when it stays silent and whether it can fire on real extraction today: [X1](contradictions/X1.md), [X2](contradictions/X2.md), [X3](contradictions/X3.md), [X4](contradictions/X4.md), [X5](contradictions/X5.md), [X6](contradictions/X6.md), [X7](contradictions/X7.md), [X8](contradictions/X8.md), [X9](contradictions/X9.md), [X10](contradictions/X10.md).

## Conformance

The extractor conformance suite has a user guide, [conformance.md](conformance.md), and a design record, [design/conformance-suite.md](design/conformance-suite.md). The dogfood gate's committed baseline is in `dogfood/baseline/` and is written by `scripts/dogfood-gate.mjs`; do not edit it by hand.

## Evaluation

Records of development measurements and of what specific implementations admit and refuse. The measurements were made on pre-release states of the tool, not on the published 0.1.0 code, and none is a precision or recall result. The JSON files are the machine-readable companions of the pages that link them.

| Document                                                                         | What it records                                                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [evaluation/dev-hardened-draft.md](evaluation/dev-hardened-draft.md)             | The one measurement the root README cites: zero findings, every detector dormant (`dev-hardened-draft.json`)          |
| [evaluation/dev-candidate-draft.md](evaluation/dev-candidate-draft.md)           | An earlier candidate measurement, superseded by the hardened one (`dev-candidate-draft.json`)                         |
| [evaluation/x7-parent-fix.md](evaluation/x7-parent-fix.md)                       | The first X7 parent/fix reproduction, superseded as firing evidence (`x7-parent-fix.json`, `x7-guard-mutations.json`) |
| [evaluation/x7-hardening-refusals.md](evaluation/x7-hardening-refusals.md)       | Later X7 implementations returning UNKNOWN on the same target (`x7-hardening-refusals.json`)                          |
| [evaluation/closed-query-copy.md](evaluation/closed-query-copy.md)               | Limits and measured refusal of the closed query-copy implementation (`x7-query-copy-dev-refusal.json`)                |
| [evaluation/ansi-regex-effects.md](evaluation/ansi-regex-effects.md)             | The first library effect certificate                                                                                  |
| [evaluation/script-execution-origins.md](evaluation/script-execution-origins.md) | The package-script check in the X7 source proof                                                                       |

## Audit

Review records, kept as written. They are records of internal reviews, not independent third-party audits.

| Document                                                                             | What it records                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [audit/2026-08-29-council-review-v2.md](audit/2026-08-29-council-review-v2.md)       | The review that blocked the unpublished predecessor design and produced v3 |
| [audit/2026-08-29-license-verification.md](audit/2026-08-29-license-verification.md) | License and external-fact verification for that review (redacted)          |
| [audit/2026-08-29-gate-proof.md](audit/2026-08-29-gate-proof.md)                     | A timed run of the ten-minute path on a third-party repository             |
| [audit/2026-09-09-semantic-council.md](audit/2026-09-09-semantic-council.md)         | Review of the semantic foundation implementation                           |

## Release

- [RELEASING.md](RELEASING.md): how a release is cut and how to verify a published package.
- [PUBLIC-RELEASE-CHECKLIST.md](PUBLIC-RELEASE-CHECKLIST.md): the checklist used for the first public release, with its open items.
- [CHANGELOG.md](../CHANGELOG.md), at the repository root: what each release contains.
