# Architecture decision records

Every decision here is traceable to a finding in `docs/audit/2026-08-29-council-review-v2.md`, a 9-lens adversarial review that returned **BLOCKED for implementation** on the predecessor design with 11 confirmed critical findings. The applied design is `docs/design/v3.md`.

That provenance is the point. An ADR that says "we chose X because it is better" is a rationalization. An ADR that says "we chose X because five lenses independently found that Y fails in this specific way, and here is the measurement" is a record. Each document below cites the finding that forced it, states the consequences that are *bad* as well as the ones that are good, and says why each rejected alternative was rejected.

| ADR | Decision | Forced by |
|---|---|---|
| [0001](ADR-0001-core-profile-ontology.md) | A ~30-kind core profile, with `profile` as a field on every kind | C1 |
| [0002](ADR-0002-path-free-natural-key-identity.md) | Path-free natural-key identity, with aliases for renames | C3 |
| [0003](ADR-0003-run-lifecycle-tombstones-status.md) | Run lifecycle: `run_id`, tombstones, authoritative scope, PASS/FAIL/UNAVAILABLE | C2, C7 |
| [0004](ADR-0004-sqlite-relational-storage.md) | SQLite and a relational schema; no graph database | C4 |
| [0005](ADR-0005-contradictions-not-gaps.md) | Contradictions, not gaps | C6, C9 |
| [0006](ADR-0006-security-spine.md) | The security spine: default-deny export, redaction, sandbox, bounded queries, untrusted-text delimiting | C5, C8 |
| [0007](ADR-0007-provenance-precedence-fact-label-separation.md) | Provenance precedence, and a structural fact/label separation enforced at the GRANT level | C6 |
| [0008](ADR-0008-oss-github-actions-exception.md) | A scoped GitHub Actions exception for open-source repositories | L10 |
| [0009](ADR-0009-determinism-release-gate.md) | Determinism is a release gate, not an aspiration | C11, H3 |
| [0010](ADR-0010-licensing-apache-cc-by-dco.md) | Apache-2.0 for code, CC-BY-4.0 for the specification, DCO for contributions | L1, L4, H15 |
| [0011](ADR-0011-redactor-wired-as-sole-writer.md) | The Redactor is wired in as the sole writer to the store | PUBLIC-RELEASE-CHECKLIST audit |
| [0013](ADR-0013-redactor-never-rewrites-identity.md) | The Redactor never rewrites identity or locator fields (amends 0011) | a dogfood finding (redactor hashing File ids) |
| [0014](ADR-0014-alignment-drift-classes-and-finding-packet.md) | Alignment: five drift classes, documents as provenanced inputs, and a versioned redacted finding packet (amends 0005) | documentation drift in the pre-fix tree of 2026-10-07 |
| [0015](ADR-0015-semantic-engine-optional-profile-layer.md) | The semantic engine stays an optional profile layer over shared primitives; the contradiction pipeline never depends on it | `docs/design/aspirational-state.md`; `AGENTS.md` (Semantic extension scope); v3 section 9 |
| [0016](ADR-0016-file-identity-carries-its-path.md) | `File` is the one kind whose id carries its path, and where a move or rename changes another id (amends 0002) | review of the rule change that first claimed it; `packages/core/src/identity/canonical.ts` |

[ADR-0017](ADR-0017-validated-write-contract-identity.md) permits a path-free natural key for the local Zod write-binding producer. The bounded producer and its historical parent/fix proof are recorded there. Hardened extraction remains UNKNOWN and dormant on the measured development corpus; current implementation acceptance and independent qualification remain pending.

Path note: the Redactor that [ADR-0011](ADR-0011-redactor-wired-as-sole-writer.md), [ADR-0013](ADR-0013-redactor-never-rewrites-identity.md) and [ADR-0015](ADR-0015-semantic-engine-optional-profile-layer.md) cite as `packages/core/src/security/redactor.ts` (and its sibling modules `patterns.ts`, `entropy.ts`, `untrusted.ts`) now lives in `packages/security/src/` as `@seamline/security`. `packages/core/src/security/redacting-store.ts` stays in core. Those records keep their original text; their decisions are unchanged.

The additive semantic engine has its own implementation council and [ADR-0012](ADR-0012-extensible-semantic-foundation.md); it preserves the original analysis contracts. [ADR-0015](ADR-0015-semantic-engine-optional-profile-layer.md) records the boundary that keeps it an optional layer, with tests for its structural claims and a list of what they do not cover.

A reading note on ADR-0002 and ADR-0009: the rename gate they state and ADR-0002's statement that `path` is never part of identity are amended for `File` by [ADR-0016](ADR-0016-file-identity-carries-its-path.md), which also states the inputs whose change under a move or rename changes another kind's id. The gate as shipped is stated in `docs/design/v3.md` §2.1.

## Reading order

If you are new to the project, ADR-0005 is the one that explains what Seamline is *for*. ADR-0001 through 0004 are the machinery that makes it work; 0006, 0007, 0009, 0011, and 0013 are the constraints that keep it honest; 0008 and 0010 are how it ships.

## Format

Status, Date, Context, Decision, Consequences (positive **and** negative), Alternatives considered (each with a reason for rejection). A consequences section listing only benefits means the decision was not actually examined.

## Amending an ADR

These records are immutable once accepted. A decision that changes gets a **new** ADR that supersedes the old one, and the old one is marked `Superseded by ADR-NNNN` with its content left intact. The history of a decision is part of the decision.

A decision that is narrowed or corrected without being replaced gets a new ADR that says `Amends ADR-NNNN` in its Status line, and the old record gets only a note appended to its Status line, `Amended by ADR-NNNN` followed by a clause saying what changed, with the rest of its text left intact ([ADR-0011](ADR-0011-redactor-wired-as-sole-writer.md) and [ADR-0002](ADR-0002-path-free-natural-key-identity.md) are marked this way).

A narrower change, one that leaves the decision standing and moves only the edge of its scope, may instead be recorded as an amendment: the new ADR states the scope of the change, and the old record gains a one-line `Amended by ADR-NNNN` note and is otherwise untouched. ADR-0013 amends ADR-0011 this way, and ADR-0014 amends ADR-0005.
