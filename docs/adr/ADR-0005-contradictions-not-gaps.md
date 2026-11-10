# ADR-0005: Contradictions, not gaps

- **Status:** Accepted
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §1, §5, §9
- **Council findings:** C6 (CONFIRMED CRITICAL; devil's advocate DA-02/DA-03/DA-04, DevEx V-1/G-1, grill-me F5, QA F6) and C9 (CONFIRMED CRITICAL; devil's advocate DA-01/DA-06, DevEx V-1/W-1).
- **Contract:** `packages/ontology/src/contract.ts` (`Contradiction`, `ContradictionDetector`, `CONTRADICTION_CODES`)
- **Amended by:** [ADR-0014](ADR-0014-alignment-drift-classes-and-finding-packet.md) (narrows "Gaps are deferred entirely from v0.1"; the scope of the change is stated there)
- **Status of implementation (2026-11-10):** all ten detectors are implemented and registered (`packages/contradictions/src/detectors/index.ts`), and the fixture-pair meta-test is `packages/contradictions/src/meta.test.ts`. Implemented is not the same as able to fire on a real repository: [`docs/contradictions/README.md`](../contradictions/README.md) gives the current status of each detector, including the ones whose input facts no shipped extractor emits. The fifth detector is `X5_UNWRITTEN_COLUMN` in the contract (a `NOT NULL` column with no default that no traced insert names), where the list below says "unexposed required column". The 10-minute acceptance test is not automated: no script or workflow in this repository times `seamline init && seamline extract && seamline why`. The record of it is one manual timed run, `docs/audit/2026-08-29-gate-proof.md`. `seamline blast-radius` is its own command, not part of `seamline why`.

This is the core product decision. Everything else in this record is machinery in service of it.

## Context

v2's primary output was the **gap**: a rule of the shape _kind × status → required edges_ fires when a required edge is absent, and the absence is reported as a finding. Three separate lines of attack converged on the same conclusion, and the sharpest of them is worth quoting in full.

**DA-03, named by the council as the sharpest finding in the review.** v2's `VERIFIES` relation was satisfied by a substring match in a test name. Therefore:

```js
it('[F-042] works', () => expect(true).toBe(true));
```

clears an **error-severity CI gate**. The gate asserts that a link exists. It does not assert that anything was verified. This is a direct violation of the principle _assert authoritative state, not presence_, and it is the exact failure mode that discredited a generation of enterprise traceability tooling.

**DA-02, the arithmetic.** v2 defined per-column and per-schema-property rules. On a modest repo the council estimated **3,000 to 4,500 day-one gaps**, mostly at `error` severity. `Gap` becomes the largest single population in the graph. Zero-gap is unreachable, so the gate is permanently red, so the gate is permanently ignored.

**DA-04, the escape hatches.** Every v2 rule had an unaudited suppression path: `technical`, `transient`, `derived`, `external`, `public`, a self-set `risk_class`, and `enforce: []`. Readiness could be moved from 0.08 to 0.94 in an afternoon with **zero facts changed**, and the result was then to be exported as GDPR Article 30 evidence.

**C9, the deeper problem underneath all three.** Every high-value cross-domain edge in v2 (`REALIZED_BY`, `SATISFIES`, `VERIFIES`, `STORED_IN`, `EXPOSED_AS`) was `DECLARED`, meaning hand-written by a human as a code annotation. By per-lens audit, **only 5 of 24 lenses rendered anything at all without hand-authored edges**, and all five were already served by mature free tools. That produces an inescapable fork: make annotations optional and the tool is a worse Sourcegraph plus a worse Backstage plus a worse Cartography maintained by one person; make them mandatory and you get a wall of red on day one and an uninstall in week one. v2's answer, that "contributors matter in phases 4 to 7", is circular: contributors arrive because of value, and value arrived in phase 4.

## Decision

**The primary output is a contradiction between two extracted facts, not the absence of a declaration. Gaps are deferred entirely from v0.1.**

A **contradiction** cites two authoritative facts that disagree. It carries both facts verbatim (`leftFact`, `rightFact`), the join path along which they were compared (`viaPath`), a claim in plain language, and a confidence.

|                             | Gap (v2)                              | Contradiction (v3)                      |
| --------------------------- | ------------------------------------- | --------------------------------------- |
| Says                        | "you failed to declare something"     | "two things you already wrote disagree" |
| Input                       | absence of a declared edge            | two extracted, authoritative facts      |
| Count on a fresh repo       | 3,000 to 4,500 (council estimate)     | bounded by real disagreements           |
| Actionable                  | no: the fix is to write an annotation | yes: the fix is a code or schema change |
| Gameable                    | yes: six documented escape hatches    | no: you must change a fact              |
| Asserts state, not presence | **no**                                | yes                                     |

A gap is a complaint about documentation. A contradiction is a bug.

Ten detectors ship in v0.1 (v3 §5), each naming the authoritative facts it compares: nullability disagreement, type disagreement, width/constraint disagreement, unbacked response property, unexposed required column, PII reachable without auth, validator/database divergence, orphaned migration, contract drift, and untested PII write path.

Three rules make this real rather than rhetorical:

1. **Detectors read facts only.** `isFact(p)` is `EXTRACTED || DECLARED`. Inference never feeds a gate (ADR-0007). The join that _finds_ the pair to compare may be `INFERRED`; the two facts being compared may not be.
2. **A detector declares its required scopes.** If any required scope's producing extractor did not PASS, the detector emits `UNKNOWN` rather than a finding (ADR-0003). No detector may report a negative finding from missing data.
3. **Every detector carries a fixture pair and a meta-test**: one fixture that makes it fire, one that does not, and a test asserting both. A detector that always fires and a detector that never fires are equally useless and equally invisible, and only a meta-test distinguishes them from a working one.

**The 10-minute acceptance test is a release gate, not an aspiration.** On a repo the author did not write, with zero declarations and zero annotations, `seamline init && seamline extract && seamline why` must produce a field-lineage map, a ranked contradiction list, and blast radius for the working diff, in under ten minutes. An empty lineage map or an unranked wall of noise means the inference is wrong and the release does not happen.

The needs matrix survives as a **design**, not as v0.1 behaviour (v3 §9). If it lands, any rule at `severity: error` must cite authoritative evidence (a `TestRun` result at the commit, plus coverage intersecting the realizing symbols), never a substring in a test name. Suppressions become expiring `Waiver` nodes with an owner and a reason, counted in the readiness denominator, and a `risk_class` downgrade emits its own finding.

## Consequences

### Positive

- **Day-one value with zero configuration.** This is the whole point. A contradiction list on a repo nobody annotated is useful immediately, which is the only way the annotations that would enable richer analysis ever get written.
- Every finding is actionable by construction, because the remedy is a change to code or schema, and the finding names both sides of the disagreement.
- Findings are ungameable in the way gaps were: you cannot suppress a contradiction by editing a rule's escape hatch, because there is no escape hatch to edit. You change one of the two facts, and changing a fact is the work.
- It satisfies that principle structurally rather than by policy. The assertion is about state, not about presence.
- The finding count is bounded by real disagreements, so the gate can plausibly reach zero, so the gate can plausibly stay on.

### Negative

- **A repo with no contradictions gets nothing.** A well-maintained, internally consistent codebase produces an empty list, and "your codebase is fine" is a hard thing to charge for or to build a habit around. Gaps at least always had something to say. This is the central commercial risk of the decision and it is accepted knowingly.
- **Coverage is narrow.** Ten detectors is not a platform. Whole categories of real problems (architectural drift, undocumented ownership, unverified requirements) are simply out of scope for v0.1.
- **False positives are now _expensive_.** A gap that was wrong was noise in a pile of noise. A contradiction that is wrong is a claim that the user's code is broken when it is not, made by a tool whose entire pitch is that it only reports real disagreements. One bad detector damages the whole product's credibility, which is why the fixture-pair meta-test is mandatory rather than encouraged.
- Contradiction detection depends on the inferred join being right. A wrong join compares two facts that were never about the same thing, and produces a confident, well-formatted, completely fictitious finding. Confidence calibration on `MAPS_TO_FIELD` and friends is therefore load-bearing for correctness, not just for ranking.
- Deferring gaps discards genuine work: the _shape_ of v2's needs rules (data, not code, with status-dependent tightening, mirroring Sphinx-Needs and Backstage scorecards) survived refutation and is worth keeping. It is deferred, not deleted.

## Alternatives considered

**Ship gaps as designed in v2.** Rejected: the CI gate is clearable by `expect(true).toBe(true)`, the day-one count is 3,000 to 4,500, and readiness is movable from 0.08 to 0.94 with zero facts changed. Any one of those is disqualifying; together they describe a tool that reports on its own documentation rather than on the system.

**Ship gaps, but make them warnings rather than errors.** Rejected: a permanently warning-coloured list of 4,000 items is ignored just as completely as a red one, and it still asserts presence rather than state. Lowering the severity of a meaningless signal does not make it meaningful.

**Ship gaps with better suppression ergonomics (expiring waivers, owners, reasons).** Rejected for v0.1, and this is the closest call in the record. Expiring waivers genuinely fix DA-04. They do not touch DA-03 (presence is still not truth) or DA-02 (the day-one count is unchanged). Better suppression on an unactionable finding is better ergonomics for ignoring it. The waiver design is retained for the deferred needs matrix, where it belongs.

**Ship both, gaps behind a flag.** Rejected: the flag is a decision every adopter must make before they understand the tool, and shipping both means maintaining both, which is the maintenance-surface failure (H14) that shaped the extractor cut. If gaps return, they return with authoritative evidence attached, through a design-spec pass, behind a named consumer.

**Make the contradiction catalogue user-extensible in v0.1.** Rejected: a user-authored detector is arbitrary code or an expression DSL executed in CI (finding S6), and the false-positive cost above applies with more force to detectors nobody reviewed. Deferred behind the extractor sandbox in ADR-0006.
