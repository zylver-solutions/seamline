# Atelier authoring integration

Status: implementation specification, 2026-09-09. Named consumer: the Atelier
composition studio and production timelines in the host application. This
addendum extends the [semantic foundation](semantic-foundation.md); it leaves the
legacy extraction ontology and its invariants unchanged.

Atelier needs to persist a story, ordered beats, scenes, shots, takes and edit
placements as one validated change. `authoring@1.1.0` adds `authoring.record`
with required `entities` and optional `relations`, `removeEntities` and
`removeRelations` lists. It upserts authoring records and explicitly removes
existing authoring records in a single engine transaction. It cannot mutate world
or inventory records. IDs belong to the application and must remain stable across
edits; omission is not deletion. Duplicate operations on an identity are rejected.
The ordinary engine revision, retry, temporal, schema and reference checks apply.

World subjects must already exist or be created through the world pack. Story
metadata is authored content. Snapshot bindings remain authored reference tuples,
and artifact locators remain unverified until an explicit review updates the take.
This increment does not add media inspection, cross-world resolution or hosted
authorization. Hosts must supply the actor, tenant and authorization policy.

Optional `authoring.hasBeat.order` records a nonnegative integer order, unique
within a story when supplied. New typed edges `hasScene`, `hasShot`, `hasTake` and
`hasPlacement` make the composition traversable. Edges that mirror a typed property
must agree with it. A beat belongs to at most one story and a scene to at most one
story; reusing takes in multiple edits remains supported. Placements require a
strictly positive duration and a safe integer end tick. Their timebase remains an
explicit positive rational; no floating-point frame-rate conversion is introduced.

Acceptance exercises a complete persisted composition, traversal, atomic edits
and deletion, historical reads, retry, stale-writer rejection and reopen. Negative
cases cover invalid subjects, inconsistent composition edges, duplicate beat
positions, zero/overflowing placement duration and writes outside the authoring
namespace. Existing authoring records remain valid except previously allowed
zero-duration/overflowing placements. The version bump changes the registry
fingerprint; existing universes require a future explicit migration.
