# Seamline — agent guidance

## What this is

A zero-declaration cross-domain join over a codebase. It extracts facts from code, database schema, and API contracts; infers the field-level joins between them (column ↔ ORM field ↔ schema property ↔ validator); and reports **contradictions** — where two extracted facts disagree — rather than gaps.

**This repository is public under Apache-2.0** (since 2026-11-09), and version 0.1.0 of its twelve `@seamline` packages is published on npm. It is the first public repository this organization has released. Everything written here should be readable by an external contributor with no internal context.

## Read before working

|                                              |                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `docs/design/v3.md`                          | **Authoritative.** The applied design.                                                                                    |
| `docs/audit/2026-08-29-council-review-v2.md` | Why v3 looks the way it does. 9-lens council, 11 confirmed CRITICALs.                                                     |
| `docs/toolchain.md`                          | Binding build conventions. The `.ts` import rule will break your code if you skip it.                                     |
| `packages/ontology/src/contract.ts`          | The shared type contract every package builds against.                                                                    |
| `docs/adr/`                                  | Decision records, each citing the finding that forced it.                                                                 |
| `docs/design/alignment.md`                   | The alignment report (`seamline align`): drift classes, claim kinds, probes and the finding packet. Governed by ADR-0014. |

## The one rule that matters most

**Semantic extension scope:** `docs/design/semantic-foundation.md` records the explicitly requested expansion for a generic domain engine and its named application consumers. It governs `packages/core/src/semantic/`; `docs/semantic-engine.md` states its implemented capabilities and limits. Preserve the legacy ontology/SIF/extraction invariants below and validate their bridge. The old v2 scope prohibition does not prohibit work in this reviewed extension, but vocabulary alone is still not evidence of implemented intelligence.

**Do not re-expand toward v2.**

The previous design was 16 domains, ~235 node kinds, 193 edge types, 24 views, and 15 extractors. A council blocked it: only 5 of its 24 views rendered anything without hand-written annotations, its rule engine would have produced 3,000–4,500 findings on a modest repo, and its flagship verification rule was satisfiable by putting a substring in a test name.

v3 §9 lists what is deferred. Every deferred item needs **a named consumer and its own design-spec pass** before work starts. That gate is the mechanism that keeps this project shippable; "it would be nice to also have" is not a named consumer.

## Invariants you must not break

These each fix a confirmed CRITICAL and are unretrofittable. All have conformance tests; if you find yourself weakening one, stop.

1. **Identity is path-free.** `{repo}:{kind}:{canonicalName}`, never a synthetic UUID, and never a file path except for `File`, whose canonical name is its repo-relative path (`docs/adr/ADR-0016-file-identity-carries-its-path.md`). A `git mv` must not change any id but a `File`'s, unless it changes an input that the id is built from; ADR-0016 item 4 lists those inputs, and an id built from an input it does not list is a defect. For a `File`, the committed rename that git reports is recorded as an `ALIAS_OF` from the retired id to the new one.
2. **The graph can forget.** `run_id` on everything, tombstones not hard deletes, `deleted_at` cleared on re-insert, tombstoning confined to the run's authoritative scope.
3. **UNAVAILABLE is never PASS.** A crashed extractor must never look like "the fact does not exist". This is what stops flakiness from manufacturing false findings and getting the gate switched off.
4. **Extraction is byte-reproducible.** No wall-clock time in a node or edge body, sorted output, repo-relative POSIX paths only.
5. **Findings come from facts.** `isFact()` gates every detector: the two nodes a finding compares must both be facts. The join between them may be an `INFERRED` edge, whose confidence is carried into the finding and caps its severity. An `LLM_SUGGESTED` node or edge never justifies a finding.
6. **Export is default-deny.** No profile, no output. `seamline-out/` is gitignored by `init`.
7. **No raw query surface.** Typed traversal only, bounded depth, capped results. There is no cypher tool and adding one needs an ADR.

## Working here

- Work from the repository's GitHub Issues (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- Tests assert authoritative outcomes. A test that asserts a function exists is not a test — this project's own design rejects presence-checking as a gate, and the suite is held to the same standard.
- Before saying done: `pnpm build` and `pnpm test` both green. Before opening a pull request: `pnpm verify` (typecheck, lint, tests and the local gates) and `node scripts/internal-leak-scan.mjs`, which CI runs and `pnpm verify` does not. [CONTRIBUTING.md](CONTRIBUTING.md) says what each gate asserts.
- New runtime dependencies are a supply-chain liability this project publicly commits to minimizing. Prefer the standard library; a new dependency needs its license named and must pass `node scripts/license-gate.mjs`.
- `docs/PUBLIC-RELEASE-CHECKLIST.md` is the record of what was checked before and after the first release, including the items still open. How a release is cut and verified is in `docs/RELEASING.md`.
