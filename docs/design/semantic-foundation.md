# Extensible semantic foundation

Status: implementation specification, 2026-09-09. This is an explicitly requested expansion of the engine, with a companion application and cinematic authoring application as named consumers. It supplements v3; the existing ontology contract, SIF and extraction store remain compatible.

The implementation lives in `@seamline/core/semantic`. Profiles compile into an immutable registry of runtime schemas, facets, typed relationships, commands and invariants. They have exact dependencies and fingerprints. Built-in world, inventory, authoring and software profiles are extensions of the same registry, not privileged kernel types.

A separate versioned SQLite semantic store owns universes, worlds, timelines, branches, revisions and command receipts. It does not reinterpret legacy extraction tombstones as historical world facts. Each command applies temporal record changes and final-state invariants atomically under optimistic concurrency. Explicit valid time and recorded revision support late corrections; branch creation pins a parent snapshot. All domains use registered commands; arbitrary unchecked writes are not public.

This release is a trusted local embedding API, not a hosted authorization service. The host constructs a tenant/actor-scoped handle with an authorization callback; actor strings supplied in a command are not credentials. Profile handlers are trusted synchronous installed code. Output has bounded queries and explicit export allowlists. Legacy imports preserve source evidence and coverage and must pass through redaction.

Council acceptance requires executable third-domain extension, validated nested values and references, namespace/dependency closure, immutable registry, persistence/reopen, branch isolation, temporal interval correctness, transaction rollback, idempotent retries and competing-writer rejection, stock conservation, ownership/custody separation, typed bounded queries, and an actual extracted-code bridge. Existing code-analysis tests must remain green. Vocabulary presence alone is not verification.

The broad target includes additional extractors, runtime intelligence, spatial computation and rich timeline mappings. This foundation implements reusable storage/model/transaction building blocks; it must report unsupported calendar conversion, automatic branch merging, remote hosting and unimplemented extractors explicitly rather than claim them complete.
