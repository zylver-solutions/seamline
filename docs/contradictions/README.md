# Contradiction codes

One page per code in the detector registry (`ALL_DETECTORS`, `packages/contradictions/src/detectors/index.ts:29-40`). A contradiction is two extracted facts that disagree. It is never the absence of a declaration ([ADR-0005](../adr/ADR-0005-contradictions-not-gaps.md), [design v3 section 5](../design/v3.md)).

Each page states what the detector compares, when it fires and when it must stay silent, how its severity and confidence are decided, the controls that keep it from reporting an inference failure as a bug, a minimal example taken from its fixture pair, how UNKNOWN arises, and its **current status**: whether it can fire on facts that the shipped extractors emit today, or only on hand-built graphs.

Every page follows the code. Where a document disagrees with the code, the page says what the code does.

## Catalog

| Code                             | Declared severity | Compares                                                                                           | Required scopes                              | Status today                 |
| -------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------- |
| [X1_NULLABILITY](X1.md)          | high              | `Column.nullable` against stated response-property nullability                         | `data`, `contracts`, `code.ts`, `infer-join` | Can fire; unmeasured         |
| [X2_TYPE](X2.md)                 | high              | the declared type of a column and contract property across a join                  | `data`, `contracts`, `code.ts`, `infer-join` | Can fire; unmeasured         |
| [X3_CONSTRAINT](X3.md)           | medium            | a column's constraint against the same dimension on its validator                                  | `data`, `code.ts`, `infer-join`              | Dormant                      |
| [X4_UNBACKED_PROPERTY](X4.md)    | medium            | a response property no column or field produces, on a contract whose other properties resolve      | `contracts`, `data`, `code.ts`, `infer-join` | Can fire, narrowly; unmeasured |
| [X5_UNWRITTEN_COLUMN](X5.md)     | medium            | a NOT NULL column with no default the writers supply against the columns every traced insert names | `data`, `code.ts`                            | Authored fixtures only; dormant pending corpus evaluation |
| [X6_PII_UNAUTHENTICATED](X6.md)  | critical          | an operation declared public against a PII column its handler reaches                              | `contracts`, `code.ts`, `data`, `infer-join` | Can fire; unmeasured         |
| [X7_VALIDATOR_DIVERGENCE](X7.md) | high | a proved unbounded validated request string reaches finite-length storage | `data`, `contracts`, `code.ts`, `infer-join` | Historical proof superseded; measured dormant; current acceptance unmet |
| [X8_ORPHANED_MIGRATION](X8.md)   | low               | a required reference against its group-local declared replay state and creation witness                                    | `data`                                       | Authored extraction; dormant pending external acceptance |
| [X9_CONTRACT_DRIFT](X9.md)       | high              | declared operations against served route handlers                                                  | `contracts`, `code.ts`, `infer-join`         | Can fire, one direction of two; unmeasured |
| [X10_UNTESTED_PII_WRITE](X10.md) | medium            | a PII-column write against test and coverage facts                                                 | `code.ts`, `data`, `infer-join`              | Dormant                      |

**Can fire** means a shipped extractor emits every property the detector reads, so the detector can produce a finding on a repository extracted today. It is a statement about inputs, not a measured result: on the recorded development measurement every detector produced zero findings, and no precision or recall is measured ([details](../evaluation/dev-hardened-draft.md)). **Dormant** identifies a documented production-evidence gap: required facts may be missing from shipped extractors, or authored extraction capability may still lack the required non-self-authored acceptance. Each detector page states its reason. Fixture capability alone establishes no external precision or recall. **Can fire, narrowly** and **one direction of two** name a partial case on the page.

X8 has authored extraction and SQLite lifecycle proof only. Its complete non-self-authored parent/fix acceptance is pending; it remains dormant for evaluation. Missing replay certificates are UNKNOWN even when data is PASS. See [X8](X8.md) and its [design](../design/x8-migration-replay.md).

X5 has authored real-extraction fixture proof only. Its current firing on an unmodified non-self corpus repository is unverified; its evaluation status is dormant pending that proof (design section 6.5), despite its implemented extraction capability.

The scopes column is `requiredScopes` from each detector spec. Scope names are defined in `scopes.ts:25-29`.

## Mechanics shared by every page

Citations are `path:line`, relative to `packages/contradictions/src/` unless the path starts with `packages/`.

**Facts only.** A finding's two endpoints are nodes whose provenance is `EXTRACTED` or `DECLARED` (`graph.ts:64-66`). Traversal drops `LLM_SUGGESTED` edges and tombstoned nodes and edges (`graph.ts:59-61`). Edges may be `INFERRED`; that is how the cross-domain join arrives, and its confidence is carried into the finding.

**Join confidence prices the finding.** The confidence of a path is the product of the confidences of its `INFERRED` hops; a fact edge contributes 1 (`graph.ts:76-82`). `defineDetector` lowers the declared severity to what that confidence supports and drops the finding below the floor (`detector.ts:87-92`, `detector.ts:213-215`):

| Join confidence at least | Highest severity allowed |
| ------------------------ | ------------------------ |
| 0.9                      | critical                 |
| 0.75                     | high                     |
| 0.5                      | medium                   |
| 0.35                     | low                      |
| below 0.35               | no finding               |

The floors are `SEVERITY_CONFIDENCE_FLOOR` (`detector.ts:64-69`). A detector cannot emit a severity, only a declared one that the wrapper may lower. Tests: `severity.test.ts:59-144`.

**Scope gate and UNKNOWN.** A required scope that is not `PASS` makes the runner report UNKNOWN without calling the detector (`runner.ts:95-112`). Direct calls enforce the same scope and uncertainty gates (`detector.ts:204-209`). UNKNOWN has three sources:

- **Scope status:** `FAIL`, `UNAVAILABLE`, or a scope no extractor reports.
- **Unread workspace code:** detectors declared `absenceOfCode` (X4, X5, X9, X10) cannot conclude absence while the `Repo` reports unread packages. Both X9 directions are withheld because the gate is per detector (`detector.ts:182-190`, `runner.ts:115-132`). Tests: `incomplete-code.test.ts`.
- **Detector-specific uncertainty:** `unknownWhen` can refuse a conclusion even when every scope is PASS (`detector.ts:139,174-180`). X5 checks writer, runtime-DDL and data-replay measurements; absent or invalid measurements are UNKNOWN. X9 checks `unreadStructuredDocuments` on fact Contracts and Operations; missing, invalid, or positive counts make it UNKNOWN (`detectors/x9-contract-drift.ts:43-51,61-65`). Direct detection refuses the same conclusion. Tests: `unknown-when.test.ts`, `detectors/controls.test.ts:217-254`, and `packages/integration/src/partial-contracts.test.ts:492-524`.

On a projected view, incomplete structured-document coverage instead makes the `contracts` scope UNAVAILABLE before a profile can hide its witness. The status is checked against the current underlying view on each scope read; no hidden count or path is released (`packages/core/src/security/export-policy.ts:616-626,655-661`).

A missing property makes a detector skip that pair (`props.ts:1-14`). X1 and X2 report `VALUE_ROLE_UNOBSERVED` as UNKNOWN when no supported pair retains all required stated facts. One skipped pair does not suppress a supported comparison elsewhere in the graph. Other dormant detectors can still report `clean`; that result does not establish their property. The final evaluation must disclose detectors that do not fire on a non-self-authored repository and why.

A narrowed authoritative claim is a separate coverage notice. `seamline check`, `seamline why`, and MCP `contradictions` qualify results and report how many files the extractor could not vouch for. The JSON reports include `narrowedClaims`; the notice itself changes neither outcome nor exit code. A detector may independently report UNKNOWN through the gates above. Facts from an unread file stay live until a later authoritative run covers them.

**Notes.** X5 names withheld tables through detector notes; X1, X2, X6 and X10 describe skipped facts (`detector.ts:146,200-203`, `runner.ts:148`). The CLI forwards these notes through `detectorNotes` and prints them under NOT EVALUATED. They do not change the exit code.

**Fixture pairs.** Every code has a firing graph and a clean graph that differs from it by one fact (`fixtures.ts:1-14`). The meta-test runs both for each code in `CONTRADICTION_CODES` (`meta.test.ts:38-104`): `fires: <firingClaim>` (`meta.test.ts:42`), `does not fire once <cleanedBy>` (`meta.test.ts:72`), and a check that the pair flips only the code under test (`meta.test.ts:86`). The fixtures build graphs in memory with `graph-memory.ts`, defaulting every node and edge to `EXTRACTED` at confidence 1 and every scope to `PASS` (`graph-memory.ts:76`, `graph-memory.ts:90-91`, `graph-memory.ts:112-113`). A passing fixture pair proves the detector's logic. It does not prove that a shipped extractor emits the properties the fixture hand-supplies, which is what the status line on each page is about.


## Where the status comes from

For each detector the status was derived by reading the property names the detector accepts (`props.ts`), then finding the emission site of each in the shipped extractors (`extract-code-ts`, `extract-data`, `extract-contracts`, `infer-join`). The pages cite both ends. The product README's list of what does not work ([README.md](../../README.md), "What works today, and what does not") and [design v3 section 9](../design/v3.md) record the missing-producer limits for X3 and X10, the historical X7 development proof and hardened UNKNOWN result, and the authored X8 replay extraction proof with unmet external acceptance; the differences between those documents and the code are noted on the pages they affect.

X1's supported response comparison is exercised through extraction, inference and SQLite by `packages/integration/src/precision-response.test.ts`. The former standalone-schema dogfood finding did not establish response direction and is retired. X2's fixture now compares a column with a contract property; it does not claim real extraction coverage for the withheld field branches. These authored controls do not establish precision or external-corpus firing. See [precision boundaries](../design/precision-boundaries.md).
