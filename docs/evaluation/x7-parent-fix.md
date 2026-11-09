# Historical X7 development parent/fix reproduction

**Superseded as current firing evidence:** later hardened candidates return UNKNOWN on this target. See [the refusal evidence](x7-hardening-refusals.md). The required real-source acceptance remains unmet; the result below describes the first producer implementation (draft of 2026-10-23) only.

This is development evidence for the bounded upper-length producer in the X7 producer work ([X7](../design/x7-upper-length.md)), not sealed qualification or release approval. The original precision, labelling and review requirements remain unchanged.

## Pinned inputs and execution

The unmodified Umami parent is `c0ea3aefbee7a3429ee2f824b06dc4a9dbe0b7e1`; the fix is `173f28c677b3d124c500431f842430dd4e2ddad0` from [PR4348](https://github.com/umami-software/umami/pull/4348). The parent is the fix's direct parent. Both entries are development inputs in `eval/corpus.json` and count as one upstream repository.

The tool source (the first producer implementation, draft of 2026-10-23; its commit and tree ids belong to the private development history and are not carried over, see `x7-parent-fix.json`) ran on the isolated verification host under Node 24.22.0 and UID 60010, with no capabilities and no-new-privileges. `prepareWorkTree` copied each pinned tree, then `runPipeline` invoked the normal CLI extract/check commands with the default evaluation extractor configuration. The outer CLI heap was 6144 MiB; the contracts child kept its ordinary 512 MiB / 120-second limits. The original checkouts were clean before and after. No upstream install, build, test or application module ran. Capability metadata declares network false; this result does not claim network-namespace enforcement.

| Checkout | Code | Contracts | Data | Join | X7 | Findings | Extraction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Parent | PASS | PASS | PASS | PASS | fired | 5 | 70,067 ms |
| Fix | PASS | PASS | PASS | PASS | clean | 0 | 69,245 ms |

The controller exited 0. [The machine-readable proof](x7-parent-fix.json) preserves the actual extractor claims, endpoint facts, binding witnesses, join edges, detector results and hashes of the CLI artifacts. Each of the five fixed properties explicitly states a bound and complete binding flags; the zero is an examined negative, not UNKNOWN or an omitted binding.

## Findings and source adjudication

All five parent findings have confidence 0.89, severity high and an `EXPOSED_AS` join. They claim that the validated write input permits strings longer than the declared storage limit along its source-proved binding. They do not claim an executed request or database error.

| Finding id | Field | Storage maximum | Parent validator | Fixed maximum |
| --- | --- | --- | --- | --- |
| `37b9a83a41eb4899` | Board.name | 200 | unbounded | 200 |
| `b2a89eedb3d87bc1` | Board.description | 500 | unbounded | 500 |
| `be0b1f13879cf60a` | Link.name | 100 | unbounded | 100 |
| `0a52884bd0d1d609` | Link.url | 500 | unbounded | 500 |
| `4d919e754c2c2455` | Pixel.name | 100 | unbounded | 100 |

At the parent, `prisma/schema.prisma:332`, `:333`, `:290`, `:291` and `:311` state these maxima. The validators are at `src/app/api/boards/[boardId]/route.ts:38`, `:39`, `src/app/api/links/[linkId]/route.ts:27`, `:28` and `src/app/api/pixels/[pixelId]/route.ts:27`. The parser awaits JSON at `src/lib/request.ts:19`, uses the non-GET body at `:26`, returns successful result data at `:40` and preserves the body/error bindings at `:52`. Error guards precede field forwarding. Persistence wrappers forward data unchanged at `src/queries/prisma/board.ts:63`, `link.ts:61` and `pixel.ts:55`. The SQL migrations independently agree with the model maxima.

A fresh source-review agent adjudicated all five as TP for this narrow source claim. The review was non-blind and used the author account. `eval/labels.json` records those development verdicts without inventing eligible identities or a complete author roster. This earns no formal independent-review credit and establishes no independently labelled sealed cluster count. Five findings from one upstream do not establish general precision, calibrated confidence or the required Wilson lower bound.

## Guard mutation checks

At the same source (the first producer implementation), normal typecheck, lint and 698 targeted tests passed. A separate isolated source copy ran the eight X7 outcome tests as a green control. Nine individual source mutations were each killed by an assertion failure: complete-length filtering, successful parsing, unchanged forwarding, model completeness, facts-only endpoints, liveness, required contracts scope, join confidence and current property authority. [The mutation record](x7-guard-mutations.json) contains the exact edits, command, exits and assertion evidence. This is guard-test sensitivity, not corpus mutant recall.

A runner setup failure is not a killed mutation. Every recorded kill below has a nonzero test exit and an explicit assertion failure after the green control; no import or syntax failure earns credit.

## Limits retained

The historical zero-finding evaluation and its 0/10 mutant recall remain historical evidence. The old regex-bearing website X7 mutant remains configured; an unsupported regex does not become a proved unbounded validator. The new `x7-board-name-unbounded` mutant removes one bound from the supported fix and must be scored separately by `pnpm eval`.

The contracts run still reports partial source coverage and withholds ambiguous natural keys. The bounded producer does not establish general ORM lineage, response validation, X3 inequality comparisons or arbitrary validator semantics. Other detectors retain their own measured dormancy reasons. Required source councils, full repository verification, CI, independent-account review, confidence calibration and a fresh sealed qualification remain separate acceptance requirements. Deployment and publication still require the operator's milestone instruction.
