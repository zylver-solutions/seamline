# Seamline semantic engine design set

Status (2026-11-10): target architecture dated 2026-09-09. It is a design record, not a description of the 0.1.0 release and not a roadmap. A first tested foundation is implemented as the optional `@seamline/core/semantic` layer: [Using the semantic foundation](../../semantic-engine.md) states what exists, [ADR-0012](../../adr/ADR-0012-extensible-semantic-foundation.md) and [ADR-0015](../../adr/ADR-0015-semantic-engine-optional-profile-layer.md) record the decisions that bound it, and there is a [review record of 2026-09-09](../../audit/2026-09-09-semantic-council.md). This design set is broader than that foundation. ADR-0015 limits the layer to five shipped packs (`world`, `inventory`, `authoring`, `software`, `code`); anything beyond them needs the admission test in section 5.3 of [the aspirational state](../aspirational-state.md) and a new ADR. Application migration and the wider intelligence capability catalog are not implemented. Where a document in this set disagrees with [v3](../v3.md), ADR-0015 or the implemented guide, those govern; dated notes in each document mark the known differences.

Names used in this set:

- **The authoring application** is a cinematic story-composition application, and **the companion application** is a conversational character application. They are the two consumers this design was written for. Neither is published and this repository contains none of their code. The directory name `atelier-composition` is historical.
- **Domain pack** and **profile** both mean what the implementation calls a `Profile` (`packages/core/src/semantic/types.ts`). It is unrelated to an export profile.

Read in this order:

1. [Target: semantic and temporal engine](semantic-engine.md): universes, worlds, branches, timelines, extensible domain definitions, evidence, information detail and fungible/non-fungible items. This is the design; the implemented guide of the same file name is [docs/semantic-engine.md](../../semantic-engine.md).
2. [Codebase intelligence requirements](codebase-intelligence.md): 28 capability families covering software intent, structure, behavior, data, verification, delivery and runtime, with evidence requirements and conformance scenarios.
3. [Shared-world implementation design](design.md): Seamline owns transactional state; companion and authoring application profiles define behavior and presentation; concrete engine changes and a shared object-handoff scenario.
4. [Repository review](review.md): existing strengths, architectural mismatches, confirmed behavior and verification limits, as observed on 2026-09-09.
5. [Read-only behavioral probes](review-probes.py): reproductions of five behavior findings observed on 2026-09-09 and not re-verified since. The script is kept as a record of how the observations were made; it runs only with the two unpublished source trees (see the script header).

The central ownership rule is consistent across the set: **Seamline owns semantic definitions and modeled state; applications contribute domain/application profiles and consume projections.** External sources remain authoritative for the facts they supply, while Seamline records their evidence and derived intelligence. Transactions for engine-owned domains are accepted through Seamline alone.
