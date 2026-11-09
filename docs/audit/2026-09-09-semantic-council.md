# Semantic foundation implementation council

Date: 2026-09-09. Scope: generic, extensible, tested local semantic foundation in `@seamline/core/semantic`, with reusable domain packs and a real legacy extraction bridge. This review does not certify application migration, unrestricted scale, comprehensive new extractors or a hosted service.

## Review method

Three separate agent reviewers examined architecture/extensibility, integrity/security, and software intelligence/verification. Reviewers contributed bounded modules, then cross-reviewed other modules and executed adversarial probes. The implementation was revised until reproduced blocking cases were closed; passing the existing suite alone was not treated as acceptance.

## Findings and resolutions

| Finding                                                           | Resolution and evidence                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generic vocabulary could be mistaken for implemented intelligence | Separate implemented behavior from declared metadata and deferred extraction in the guide; real extractor-to-SQLite integration test                               |
| Mutable or ambiguous extension contracts                          | Immutable compiled schemas, exact direct dependencies, namespace/collision/cycle checks, recursive facets, runtime validation and extension tests                  |
| Type identity could be reused after deletion                      | Persistent world-level identity registry; deletion, fork and category-change regression                                                                            |
| Async authorization could pass as a truthy value                  | Only literal true authorizes; Promise and denial regression                                                                                                        |
| Backdated writes could overwrite later state                      | Protect future per-record change boundaries; bounded correction tests                                                                                              |
| Deleted objects could reappear through backdated edits            | Retain barriers after partial and complete deletion, persist them through reopen/fork, test relation deletion; storage v2 rejects incompatible experimental stores |
| Finite stock consumption could expire and restore stock           | Named stock/reservation operations reject finite intervals; exact arithmetic and conservation tests                                                                |
| Extension flexibility could bypass inventory integrity            | Final-state conservation invariants allow custom conserving splits while rejecting unauthorized mint/burn                                                          |
| Generic writes could forge imported code facts or status          | `code.import`-only transition invariant plus redaction inside the reducer; negative mutation and custom-link tests                                                 |
| Receipt arguments could retain secrets outside redaction          | Store actor-bound request digest and accepted-operation metadata, not raw arguments                                                                                |
| Fingerprints were described too broadly                           | Document registered-function coverage and required helper version bumps; no claim of transitive artifact hashing                                                   |

The self-extraction diff also exposed legacy extractor collisions between package-local test names and existing symbols. New test fixtures were given distinct names to avoid changing existing facts. This bounded compatibility fix does not claim to redesign the legacy extractor's identity resolution.

## Acceptance and verification

**Final council verdict: unanimous APPROVE for the genericity, extensibility and solidity of this documented trusted-local foundation.** Architecture and integrity reviewers approved after the deletion-barrier correction; the software-intelligence reviewer approved after the clean baseline review and successful self-extraction verification. The software-intelligence reviewer independently confirmed that the regenerated baseline adds 407 nodes and 917 edges, with zero removed or modified pre-existing nodes/edges; all additions retain EXTRACTED provenance. Contract/data statuses and the flagship lineage JSON remain unchanged. Final gate verification is recorded below.

- Repository suite: **1,053 tests passed**, zero failures/skips (1,007-test baseline plus 46 tests).
- TypeScript build, full ESLint, focused formatting and local documentation links passed. After the last fixture-only renames, the build and all affected engine/import/integration tests passed again.
- License gate passed for 97 packages; ontology gate retained 29 node kinds, 26 edge kinds and 54 endpoint pairs with no divergence.
- Executable custom-equipment example passed, showing separate owner/custodian, placement traversal, extension command behavior, earlier state and command history.
- Self-extraction gate passed against the independently reviewed regenerated baseline. Determinism gate passed: two output files, totaling 26,849,036 bytes, were byte-identical across two stable-source extraction runs. Earlier determinism attempts overlapped edits and are not acceptance evidence.

## Explicit limits

See the [library guide](../semantic-engine.md) for enforced resource budgets and embedding rules. In particular: independent integer timelines, full temporal snapshots, trusted synchronous extensions, no automatic registry migration or branch merging, no image verification, no hosted authentication or field-level perspective policy. Authoring snapshot tuples are authored references, not resolved foreign-world guarantees. Software definitions do not imply additional extractors. The next application adapters should reuse these contracts and introduce their own domain-specific acceptance tests.
