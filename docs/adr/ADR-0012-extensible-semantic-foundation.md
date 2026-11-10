# ADR-0012: Add an extensible semantic foundation beside the extraction graph

- **Status:** Accepted for trusted local embedding
- **Date:** 2026-09-09
- **Design:** [Semantic foundation](../design/semantic-foundation.md)
- **Review:** [Council findings and verification](../audit/2026-09-09-semantic-council.md)
- **Reader's note (2026-11-10):** "Atelier" is a cinematic story-composition application and "the companion bots" are a conversational character application. They are the two named consumers this foundation was designed for. Neither is published and this repository contains none of their code (see [the design set](../design/atelier-composition/README.md)). What is implemented is stated in [`docs/semantic-engine.md`](../semantic-engine.md), and [ADR-0015](ADR-0015-semantic-engine-optional-profile-layer.md) bounds the layer.

## Context

Atelier and the companion bots need reusable identity, location, ownership, inventory and continuity state. Code intelligence needs reusable evidence, source availability, artifact lineage and historical views. Hard-coding those applications into the extraction ontology would couple unrelated domains and repeat the unsupported capability claims rejected by the earlier council.

## Decision

Add `@seamline/core/semantic` with an immutable compiled profile registry and a separate versioned SQLite store. Profiles own schemas, reusable facets, typed relationships, commands and invariants. World, inventory, authoring and software packs use exactly this extension mechanism. The legacy code pack bridges real extracted graphs without changing the legacy ontology or SIF contract.

World-scoped identities, independent timelines and pinned branches scope domain state. Transactions validate schemas and invariants at affected temporal boundaries, enforce expected revisions and retain retry receipts. Persist change barriers even after complete deletion: council probes proved interval records alone could let backdated updates resurrect deleted entities. Storage version 2 rejects earlier experimental stores with unrecoverable deletion history.

Import provenance is a protected transition boundary: only `code.import` changes imported code records, and it invokes redaction itself. Extensions may attach domain relationships to imported code. The host supplies authorization; installed synchronous handlers are trusted code. Exact profile versions must change when helper implementations change because function-source fingerprints do not hash transitive dependencies.

## Consequences

Consumers can extend the model without modifying the kernel. Equipment, inventory and software domains have executable examples and tests, including real TypeScript extraction imported into persistent semantic state. Existing analysis remains independently usable.

Full temporal snapshots simplify atomicity and reconstruction but impose explicit scale limits. Retained barriers consume the same finite budget as records. Registry changes require an explicit future migration; no automatic branch merge, coordinate transform solver, hosted authentication or arbitrary plugin sandbox is provided. Authoring definitions do not verify media fidelity. New software vocabulary does not create new extractors.

## Alternatives considered

- Expand the frozen extraction ontology with every application type: rejected because it couples application releases to the analysis contract and confuses declared vocabulary with extracted facts.
- Keep separate object/inventory engines in each application: rejected because shared continuity and integrity behavior would drift.
- Replace extraction storage immediately: rejected because historical world state and extraction tombstone/source coverage semantics differ; a tested bridge preserves both.
- Store only current state or surviving intervals: rejected by council deletion-resurrection probes and the need for historical reconstruction.
- Ship remote hosting, unrestricted scale or event replay in this increment: deferred because each needs its own measured design and acceptance tests.
