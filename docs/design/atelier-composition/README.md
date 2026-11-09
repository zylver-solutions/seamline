# Seamline semantic engine design set

Target architecture, 2026-09-09. These documents define the broader expanded Seamline engine. A first tested foundation now exists in [Seamline](../../semantic-engine.md), with [implementation decisions](../../adr/ADR-0012-extensible-semantic-foundation.md) and a [council review record](../../audit/2026-09-09-semantic-council.md). Application migration and the full intelligence capability roadmap remain outstanding; this design set is broader than the implemented foundation.

Read in this order:

1. [Semantic and temporal engine](semantic-engine.md): universes, worlds, branches, timelines, extensible domain definitions, evidence, information detail and fungible/non-fungible items.
2. [Codebase intelligence requirements](codebase-intelligence.md): 28 capability families covering software intent, structure, behavior, data, verification, delivery and runtime, with evidence requirements and conformance scenarios.
3. [Shared-world implementation design](design.md): Seamline owns transactional state; bot and Atelier profiles define behavior and presentation; concrete engine changes and a shared object-handoff scenario.
4. [Repository review](review.md): existing strengths, architectural mismatches, confirmed behavior and verification limits.
5. [Read-only behavioral probes](review-probes.py): reproductions of five current behavior findings, runnable only with the two unpublished source trees (see the script header).

The central ownership rule is consistent across the set: **Seamline owns semantic definitions and modeled state; applications contribute domain/application profiles and consume projections.** External sources remain authoritative for the facts they supply, while Seamline records their evidence and derived intelligence. Transactions for engine-owned domains are accepted through Seamline alone.
