# ADR-0001: A ~30-kind core profile, with `profile` as a field on every kind

- **Status:** Accepted
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §4
- **Council finding:** C1 (CONFIRMED CRITICAL), raised independently by five lenses: architect (A7/A10), devil's advocate (DA-05), DevEx (W-1), grill-me (F6), QA (F1). Process finding §4 of the same review.
- **Contract:** `packages/ontology/src/contract.ts` (`NODE_KINDS`, `EDGE_KINDS`)

## Context

The predecessor design (an internal document, superseded and not published here) froze a vocabulary spanning 16 domains before any external user had touched the tool. The council measured it rather than estimating it, and the measurements did not match the document's own claims:

- §12 of v2 claimed 120 node kinds. §3 listed roughly **235**.
- §4 claimed "~150 edge types". It listed **193 unique**.
- The architect lens in v2's *own* prior review had demanded a "~35-kind core profile or adoption dies on day one". That mitigation existed only as prose: there was no `profile` field anywhere in §3, no gating of rules by profile, and §11 phase 0 still shipped all 16 domains in week one.

Two consequences follow, and the second is the one that forced this ADR. First, a mitigation calibrated against a denominator that is wrong by roughly 2x is not a mitigation. Second, and worse: a vocabulary is the most expensive thing in the system to change after release, because breaking it invalidates persisted graphs, third-party extractors, and stored queries at the same time (ADR-0009 and the ontology compatibility policy cover that). v2 front-loaded the most irreversible decision in the design to the moment of minimum information.

Six of v2's node-kind names were also defined twice with different semantics (`Interface`, `Control`, `Policy`, `Constraint`, `Release`, `Job`), and `GATED_BY` and `MEMBER_OF` were each defined twice (finding H16). That is what a vocabulary looks like when nothing mechanically enforces its size or its uniqueness.

## Decision

**The core profile is ~30 node kinds and ~26 edge kinds, and `profile` is a field on every kind, checked by lint, not a paragraph in a design document.**

1. Every class in `ontology/seamline.yaml` carries a required `profile` slot with permissible values `core`, `extended`, `vendor`.
2. **v0.1 extractors emit `core` only.** Extended and vendor kinds may exist in the ontology source as reserved vocabulary, and they are **inert**: no extractor produces them, no detector reads them, no query traverses them. They cost nothing at runtime and reserve the name.
3. The normative node and edge lists live in two places that must agree exactly: `ontology/seamline.yaml` (the specification, CC-BY-4.0) and `packages/ontology/src/contract.ts` (the implementation seam, Apache-2.0). `ontology/lint.mjs` cross-checks them and fails the build on any divergence. Neither is allowed to drift; agreement is mechanical, not editorial.
4. Growing the core profile requires a design-spec pass and a **named consumer** (v3 §9). "It would be nice to model X" is not a named consumer.

The core kinds, by group: Code (`Repo`, `File`, `Module`, `Symbol`, `CodeField`, `Parameter`, `RouteHandler`); Data (`DataSource`, `Schema`, `Table`, `Column`, `Migration`); Contract (`Contract`, `Operation`, `SchemaProperty`); Domain (`Entity`, `DomainProperty`); Verification (`TestCase`, `TestRun`, `CoverageRecord`); Change (`Commit`, `Changeset`); People (`Owner`); Meta (`Run`, `Extractor`, `Contradiction`, `Alias`, `Lens`, `ThreatModel`).

`Symbol` is deliberately one kind, not six. Class, interface, type alias, enum, function, and method are a `symbol_kind` property. Making them separate kinds multiplies every edge signature that touches a symbol by six and buys nothing a property does not.

## Consequences

### Positive

- The vocabulary is small enough that one person can hold it in their head, which is the actual constraint on a single-maintainer project.
- The `profile` field makes profile membership a queryable, testable fact. A conformance test can assert "no v0.1 extractor emitted a non-`core` kind" and that assertion is about observable output, not about intent.
- Reserving `extended` names now costs nothing and avoids the worse failure of a v0.2 kind colliding with a third-party vendor extension.
- A ~30-kind vocabulary is small enough to review for the duplicate-definition class of defect that produced H16. At 235 kinds nobody catches it.

### Negative

- **The core profile cannot express things adopters will want on day one.** No infrastructure, no deployment environment, no service mesh, no incident, no OKR. Some evaluations will end at "it doesn't model my architecture" and that is a real, accepted adoption cost.
- Reserved-but-inert kinds are a documentation hazard: a reader can find `Lens` in the ontology and reasonably assume lenses work. The ontology must mark inert kinds unambiguously, and `README.md` must say so in plain language.
- Deferring a kind is not free either. When `extended` kinds are eventually activated, their edge signatures have to be designed *then*, against a graph that already has persisted data, which is strictly harder than designing them now on a blank page. We accept this because designing them now against zero usage data is how v2 got 193 edge types nobody traversed (finding H5: ~57% of v2's edge types were referenced by no rule and no lens).
- Two sources (`seamline.yaml` and `contract.ts`) must be kept in agreement. The lint makes drift loud, but it is still two files to edit for one change.

## Alternatives considered

**Ship v2's full 16-domain vocabulary as designed.** Rejected: this is the option the council BLOCKED, and an earlier internal project's own review independently rejected a *smaller* version of the same design at fatal severity, before this council convened. Two independent reviews reaching the same verdict on different designs is corroboration, not an echo.

**Keep the large vocabulary but mark a core subset in prose.** Rejected: this is exactly what v2 did, and §4 of the council review names the failure mode precisely. Dissent recorded and then discarded produces a document that looks reviewed. Prose is not enforcement; a `profile` field checked by lint is.

**No fixed vocabulary at all: let extractors declare kinds dynamically.** Rejected for two reasons. Contradiction detection compares typed facts across domains (ADR-0005); without a fixed vocabulary there is nothing to compare across. And the whole value proposition is a *shared* vocabulary that third parties can target; a per-extractor vocabulary is a per-extractor tool.

**Start smaller still, e.g. ~12 kinds covering only code.** Rejected: an earlier internal project already shipped almost exactly this scope (7 node kinds, 8 edge kinds, code-only), and its own review blocked further expansion on the finding that it has *no named consumer*. Code-only is not the wedge. The wedge is the field-level join across code, data, and contract (v3 §1), and that needs `Column`, `SchemaProperty`, and `CodeField` in one vocabulary at minimum.
