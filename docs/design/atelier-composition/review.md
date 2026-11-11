# Authoring application, companion worlds, and Seamline: composition review

Status (2026-11-10): archived review record of 2026-09-09. It is not a specification and its findings have not been re-verified for Seamline 0.1.0. "The authoring application", "the companion application" and "the production application" (a third private application that vendors the authoring application) are unpublished; findings about them concern source trees that are not part of this repository and cannot be opened from here. Dated notes mark where Seamline itself has changed since.

Reviewed 2026-09-09 against local checkouts of the Seamline source of that date and of two other source trees that are not published here. File paths and identifiers named below that are not in this repository (for example under `runtime/` and `src/lib/`) belong to those trees and are cited as descriptions, not links.

**Target architecture:** Seamline owns the shared world model and state engine: objects, positions, locations, relationships, ownership, inventory, history, and evidence. The authoring application and the companion application define application profiles and behavior on top. Evolve Seamline into a profile-based engine while retaining its existing code-analysis behavior as a separate supported profile. The common world model must actually be stored, validated, queried, and changed through Seamline, rather than synchronized between independent application-owned models.

Note (2026-11-10): the "separate supported profile" part was not adopted. Under [ADR-0015](../../adr/ADR-0015-semantic-engine-optional-profile-layer.md), extraction is not a profile of the engine: the semantic layer is optional, `code@1.0.0` imports a finished extraction graph one way, and no CLI or MCP surface exposes the layer.

The accompanying [composable design](design.md) specifies the boundaries, composition rules, migration sequence, and an acceptance scenario. [Behavioral probes](review-probes.py) reproduce five findings without network calls or production writes.

The broader requested target is developed in [the semantic and temporal engine specification](semantic-engine.md) and [comprehensive codebase intelligence requirements](codebase-intelligence.md). They add first-class universes, worlds, timelines and domain definitions; the implementation limitations identified below describe the inspected code, not a ceiling on that target.

This is an architecture and premise review grounded in source, not a deployment audit or proof that all application paths work. It covers the authoring application's domain types, library, craft rules, generation, council, editing, shots and export; the companion application's scene/simulation/inventory/wardrobe/imaging paths; and Seamline's current contract and evidence semantics. No application code was changed. The review spans three repositories; this archived copy is versioned with the Seamline implementation.

## 1. Actual integration and responsibilities

| System                 | What exists in this checkout                                                                                                                                        | What it does not establish                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Authoring application  | Vendored studio; typed library; generic assets; local persisted reels; section/block editing; shot recipes; provider calls; timeline export                         | Shared canonical world, cross-reel state history, verified image continuity, complete integration into the production application |
| Production application | `StoryPlan → Act → Segment → Clip`; production assets; timeline schema and consumer fixture test                                                                    | A lossless narrative/world interchange contract                                                                                   |
| Companion application  | Persistent simulation and scene dictionaries; schedules; place hierarchy/layouts; item ownership and wear; kit/outfit logic; scripted scenes; layered image prompts | General object tracking, computer-vision tracking, shared world across companions, a complete event history                       |
| Seamline               | Code/database/API fact extraction and joins; provenance; typed edges; lifecycle; contradiction detection                                                            | A generic runtime world ontology, Python source extraction, arbitrary extension of all node/edge kinds                            |

Note (2026-11-10): the Seamline row describes the code on 2026-09-09. The ontology contract is still fixed, but `world@1.0.0`, `inventory@1.0.0` and `authoring@1.1.0` packs now exist outside it, in the optional `@seamline/core/semantic` layer ([Using the semantic foundation](../../semantic-engine.md)).

The authoring application is **not fully integrated** in the inspected source. The production application's workspace explicitly excludes the vendored package directory. Its embed plan distinguishes vendoring from later wiring. The concrete bridge is a frozen timeline export fixture and consumer test, rather than a runtime import. Searches of the API and two application source trees found no wiring to the authoring application. This says nothing about a separately deployed remote instance.

The reel store is Zustand persistence, even though the vendored shell also has database/auth machinery. The presence of that machinery does not establish durable shared reel storage.

## 2. The authoring application's premise: a useful composition model inside a narrow fiction profile

The strongest premise is sound: **stories can be assembled from reusable identities, settings, situations, objects, and presentation recipes**. Character image identity is separate from backstory. A location contains material useful for establishing shots and empty plates. A bundle is a composition rather than a monolithic prompt. Shot recipes are independent assets, and individual blocks can be regenerated without changing their IDs. These are worth retaining.

However, the current engine is deeply shaped by one editorial world. The generation system prompt prescribes public rooms, prestige fiction, clothing, social danger, power gestures, and watching bystanders. Character types are a fixed enumeration of five roles specific to that setting. Pose and object recipes name specific people, seating hierarchies, jewelry, and jacket transfers. These are authored choices, not universal properties of characters, poses, or objects.

Preserve this as an authoring application profile. Move the cast, voice conventions, genre and content rules, visual style, social roles, witness behavior, and default plot into versioned content and policy packs. Keep applicable product policies active through that separation; making a profile explicit is not disabling it. A museum training sequence, product demonstration, quiet domestic story, or explanatory diagram should not inherit these editorial assumptions.

### Story framing problems

**A section is forced to do too many jobs.** The craft contract asks each section to provide a new sensory room, new pressure, a value change, power-readable blocking, and an image beat. This collapses setting changes, dramatic progression, paragraph grouping, and coverage. Two meaningful beats may occur in one room; a single beat may need several shots; a montage may cover several places without claiming immediate physical travel.

**The supposedly optional engines are not independent.** Kishōtenketsu is offered as a contrast-driven structure, while the shared instructions still require pressure and an arrow-shaped value change. The default coverage skeleton always includes pressure and climax. A chosen narrative grammar should control its own expectations; an eight-shot social-video template should not define every story's dramatic structure.

**The character model overgeneralizes one theory of characterization.** Want/need/lie/fear can be useful authoring facets, but a documentary subject, procedural trainer, or minor witness may need none of them. Relationships and roles should be contextual: a person can lead one interaction and follow another. A reusable blocking recipe should bind role slots to entity IDs rather than mention a character by name or as “him” in its definition.

**Story topology is currently confused with physical topology.** One location bundle chains four locations across three cities, and a location in the second city points to a lift in the third. These could be valid montage selections, but they are not defensible physical adjacencies. There is no explicit travel, ellipsis, flashback, or branch relationship explaining them. Separate `next narrative beat` from `reachable place` and from `next edited shot`.

**“Sequel” is presently a prompt knob.** The generation request contains a current bible, knobs, arc jobs, location names and note. It has no predecessor reel ID or predecessor snapshot. `Reel.continuity` is text. There is no structured handoff of who owns the key, who wears the jacket, where everyone ended, or which facts a character learned. A sequel needs a pinned starting state and branch relationship.

**Length, story structure, and screen time disagree.** Generation requests 1, 4, or 8 sections, while `ArcDef.jobs` and situation beats are fixed four-tuples. Blocks default to eight seconds per section. A requested 180–280-word section is not an eight-second narration plan. Separate reading length, narrative grouping, story time, and presentation duration. Audio duration should inform editing when narration is actually used.

## 3. Source-grounded findings that affect composition

Priority describes impact on the proposed reuse, not a production incident rating.

| Priority | Finding and evidence                                                                                                                                                                                         | Consequence                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Council accepts repeated `Words`, a 32-character `xxxxx…` image prompt, one arrow, and an arbitrary rule; all seats pass in the probe                                                                        | Text checks are reported as dramatic and identity verification. These claims should become accurately named lint results; continuity needs state comparisons      |
| High     | StudioPanel assigns location IDs by section index, ignoring generated `locationHint`; sections past the chain fall back to the first location. `poseHint` is stored as `poseId` without reference resolution | Prose, declared IDs, images, and poses can refer to different scenes. Accept validated references from the planner, or resolve to explicit ambiguity              |
| High     | Shot generation compiles a prompt from fragments and truncated bible text; callers often supply only continuity/rule text                                                                                    | There is no guaranteed complete identity/location/outfit binding for a new or regenerated shot                                                                    |
| High     | Companion scene objects are capped, deduplicated strings. learn_world merges new place objects into the existing list after changing location                                                                | The probe retains bed/sheets alongside counter/fridge after a bedroom-to-kitchen move. This is accumulation, not location-aware object state                      |
| High     | Companion place LOD uses 2 for detailed first-plane rooms; NPC LOD uses 0 for in-frame characters                                                                                                            | Sharing a numeric `lod` field silently reverses fidelity. Map by meaning, independently for each source domain                                                    |
| High     | compose_prompt defaults an unmapped place to `PLACE_BG['living']`                                                                                                                                            | Missing location coverage becomes an invented living-room depiction. Return an explicit unresolved/degraded result                                                |
| High     | tick_second decrements scripted scene duration only with `elapsed_min`; the server's background call omits it                                                                                                | The primitive is present and unit-tested, but that call cannot advance its countdown. The probe remains active after timestamps one hour apart                    |
| Medium   | Store can edit `stillUrl`/section prose directly, while hydrated blocks also store those values and export reads the blocks                                                                                  | Multiple representations can diverge. Choose one edit authority and derive the others                                                                             |
| Medium   | shotPromptFragment does not compile all stored fields, including subject X/Y, focal length, headroom, detailed layer and lighting values                                                                     | A persisted inspector setting is not evidence that the generator received or honored it                                                                           |
| Medium   | Block regeneration generates a still for a `video` block and places the still URL into `videoUrl`; provider failures can become prompt-only patches inside an overall `ok: true` response                    | Artifact kind and execution status need explicit contracts. Never let “edited prompt,” “generated still,” and “generated video” share an undifferentiated success |
| Medium   | Timeline export flattens media into `imageUrl` elements; transition/overlay blocks have no export branch; still and filled shot blocks can overlap                                                           | A structural fixture pass is not lossless export or correct editing. Define selection, track/layer order, unsupported-field diagnostics and time semantics        |

Additional schema drift: `types.ts`, `assets/record.ts`, and `schema/catalog.ts` define overlapping asset shapes; metadata registration in `assets/kinds.ts` does not register a payload validator. Unknown payload kinds fall back to arbitrary records in the catalog. `collectRefs` infers references from selected field names and does not capture every relationship, such as location `chainNext`. An open envelope is useful, but it needs a versioned kind definition that also owns validation and reference semantics.

The production application adds another simplification: Clip.shotType is actually `string`, despite the authoring application's documentation describing four recognized mappings. StoryManager infers that string from heading keywords. Treat the four-value mapping as an adapter convention, not a universally enforced schema invariant.

## 4. What the companion application contributes—and the limits of “tracking”

The companion application provides the strongest existing continuity mechanics: a place containment tree, room adjacency, schedule/commute state, separate foreground/background behavior, item ownership, quantities and wear, owned-garment kit assembly, outfit-change events, and deterministic simulation functions. Wardrobe composition derives identity/background/cast/outfit/prop/shot/avoid layers instead of asking a model to remember the whole scene.

There are multiple distinct things currently called objects:

| Current representation                 | Meaning                                  | Proposed treatment                                                     |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| `LAYOUTS.furniture`                    | Named setting fixtures                   | Untracked decor until interaction/continuity requires stable identity  |
| `scene.objects`                        | Conversational descriptions              | Observations or hints with source attribution, not canonical inventory |
| `world.items`                          | Owned/located items, quantities, history | Persistent instances or stock lots                                     |
| `scene.kit`                            | Currently worn item bindings             | Derived/validated equipment state referencing instances                |
| Authoring application `ProtocolObject` | Narrative/visual recipe                  | Object definition plus affordances, separate from an instance          |

Similarly, `scene.place`, `world.place`, participant `where`, `PLACES`, `PLACE_BG`, and presets are overlapping representations, not a single universal location registry. `scene.body` has useful pose/facing/gaze/hand slots, but these are largely text fields, not a general geometry or constraint solver.

**The inspected paths track declared and parsed state. They do not track objects in pixels or verify generated image content.** There are no bounding-box tracks, feature matching, multi-view reconstruction, or an image verification loop in these paths. Prompt coherence is valuable, but a consistent prompt cannot prove a consistent image.

The item history and outfit log are bounded recent histories, not complete event sourcing. Identity templates, mutable instances, one-off flavor, and user-specific relationships need distinct scopes. An existing shared-world roadmap (a private planning note, not published) already recognizes the difference between shared entities and private chat relationships; reuse that boundary rather than putting all memory into a common graph.

The companion application's reference documents (private, not published) are not a reliable implementation inventory by themselves: one calls scripted scenes an addition, while the simulation module implements them; another still calls wardrobe unported, though a wardrobe module exists. Reference travel times also differ from the current place table. Source plus behavioral tests must arbitrate adapter semantics.

## 5. Seamline: current specialized ontology and required engine evolution

[Seamline v3](../v3.md) is intentionally smaller than the rejected platform design. [The audit](../../audit/2026-08-29-council-review-v2.md) explains why: broad vocabulary, weak evidence and annotation-driven gates can produce a large graph without useful answers. The requested target deliberately expands the engine's role, with the authoring application and the companion application as named consumers. The [accompanying design](design.md) is the proposed specification for that expansion; the existing v3 contract has not been changed.

Reuse these principles:

- Explicit identity and typed relationships with domain/range restrictions.
- Provenance separate from confidence and from endorsement.
- Source snapshots and deterministic derived projections.
- Lifecycle rules that distinguish deletion, unavailable sources, and partial coverage.
- Findings with evidence and scope, not a reassuring label.
- Bounded queries and scoped export.

Do not copy every mechanic literally:

| Seamline mechanic                                               | Why it cannot simply become world state                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebuildable `{repo}:{kind}:{canonicalName}` identities          | Two visually identical jackets need distinct persistent instance IDs; changing a display name must not change identity                                                                                                                                                                               |
| Time primarily attached to extraction runs                      | World facts need story-valid time; editing additionally needs presentation time; observations need recorded time                                                                                                                                                                                     |
| Tombstoning missing nodes within authoritative extraction scope | An entity absent from a camera view has not ceased to exist. Only an authoritative lifecycle event or complete source scope can retire it                                                                                                                                                            |
| `EXTRACTED > DECLARED` precedence                               | Reading generated prose accurately does not make its claims world truth. An author-approved fictional fact can be canonical within its branch                                                                                                                                                        |
| Fixed `NodeKind`/`EdgeKind` and primitive-valued properties     | There is no drop-in `Shot`, `Wears`, `SceneSnapshot` or temporal claim profile in the current [contract](../../../packages/ontology/src/contract.ts). (Note (2026-11-10): the contract is unchanged, but `authoring@1.1.0` and `world@1.0.0` now provide shot, take and placement types outside it.) |

An important documentation nuance: Seamline's broad “inference never feeds a gate” wording is stronger than the implementation. [Contradiction traversal](../../../packages/contradictions/src/graph.ts) permits inferred joins between authoritative fact nodes and propagates confidence; [tests explicitly require it](../../../packages/contradictions/src/provenance.test.ts). LLM-suggested nodes/joins are excluded. (Note (2026-11-10): this is still how the code behaves. Read `AGENTS.md` invariant 5 and section 6A item 4 of [the aspirational state](../aspirational-state.md) accordingly: an `INFERRED` or `LLM_SUGGESTED` node never justifies a finding, an `INFERRED` join edge between two fact nodes can carry one, and an `LLM_SUGGESTED` edge is dropped; see the header comment of `packages/contradictions/src/graph.ts`.) The proposed world validator should separately record uncertainty in a claim and uncertainty in an entity match. For irreversible world updates, an uncertain identity match should remain a proposal.

The target requires a genuine world profile and shared mutation/query engine in Seamline. Adding world records to the current `props` bag or merely exporting snapshots to Seamline would not meet it. Seamline can also inspect the new TypeScript types, JSON contracts and persistence schema as software artifacts, but that code-analysis use is distinct from its new responsibility as the authoritative world engine. Python uses a typed client to that engine; Python source extraction is not required for runtime participation. (Note (2026-11-10): target only; no Python client exists.)

## 6. Verification performed

| Check                                                                                                                              | Result                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `python3 runtime/test_sim.py` in the companion application                                                                         | Passed (`test_sim OK`; expected rejection-path diagnostic printed)                                            |
| `python3 runtime/test_wardrobe.py` in the companion application                                                                    | Passed                                                                                                        |
| `node --experimental-strip-types --test packages/ontology/src/contract.test.ts` in Seamline                                        | Passed                                                                                                        |
| `python3 docs/design/atelier-composition/review-probes.py` with the two unpublished source trees available (see the script header) | All five observed-behavior probes passed                                                                      |
| Authoring application `src/lib/schema/catalog.test.ts`                                                                             | Could not execute: local `zod` dependency missing; this is unavailable validation, not a product test failure |

No dependencies were installed, no model/image calls were made, and no full browser/build/deployment verification was performed. The full Seamline suite and the production application consumer test were not run.

The immediate architectural priority is **Seamline-owned world state with stable instance references, atomic changes, and explicit fidelity/authority**, consumed by both a chat projection and an authoring-application shot binding. One end-to-end object handoff proves that both applications truly share the engine.
