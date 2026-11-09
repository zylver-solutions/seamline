# Development measurement (candidate draft of 2026-10-23)

This is a historical candidate measurement, superseded by the [hardened zero-finding measurement of the later draft](dev-hardened-draft.md). It is not the final-main result or sealed qualification. [The machine-readable summary](dev-candidate-draft.json) records the draft's date and the digests of its product and build (the draft's own commit id belongs to the private history and is not carried over), selected pins, counts and measurement command. The original full report SHA-256 is `298b212624abf3ee77e639785cc4e768c7a593f3805896282e35902148da6c40`.

The verification host ran Node 24.22.0 and pnpm 10.34.5 against seven explicitly selected DEV pins from four upstreams, with all eleven DEV mutants. Every checkout was analysed. No sealed source was selected, fetched or analysed, and no upstream install, build, test or application module ran. The engine retains its ordinary limits. The command exited 1 because watched changes have burned the existing sealed partition; its stored freeze was not replaced or reinterpreted.

## Per-detector result

Precision below is descriptive source-adjudicated TP/(TP+FP), with labelled finding count in parentheses. Those labels are non-blind and from the author account, so they supply no formal independent-review credit. Their five automatic components are not five independently qualified clusters. All sealed detector estimates remain unmeasured.

| Detector | DEV precision (labelled n) | Wilson lower bound | Mutant recall | UNKNOWN pins | Observed firing and reason |
| --- | --- | --- | --- | --- | --- |
| X1_NULLABILITY | n/a (0) | n/a | 0/1 | 6/7 | dormant on DEV: One checkout observable with no reported mismatch; six UNKNOWN from response-role or scope limits. |
| X2_TYPE | n/a (0) | n/a | 0/1 | 3/7 | dormant on DEV: Four checkouts observable with no reported type conflict; three UNKNOWN from role/type or scope limits. |
| X3_CONSTRAINT | n/a (0) | n/a | 0/1 | 2/7 | dormant on DEV: Validator Symbol constraint facts are not emitted. The new X7 producer does not feed X3. |
| X4_UNBACKED_PROPERTY | n/a (0) | n/a | 0/1 | 2/7 | dormant on DEV: Supported response, container and confidence checks supplied no eligible unbacked pair. |
| X5_UNWRITTEN_COLUMN | n/a (0) | n/a | 0/1 | 7/7 | dormant on DEV: All seven UNKNOWN: runtime-DDL and other writer guards prevent the absence claim. |
| X6_PII_UNAUTHENTICATED | n/a (0) | n/a | 0/1 | 2/7 | dormant on DEV: No supported explicit unauthenticated operation-to-query exposure was reported; two UNKNOWN. |
| X7_VALIDATOR_DIVERGENCE | 1.000 (5) | 0.5655 | 1/2 | 5/7 | fired on DEV: Five unbounded parent fields, zero at the fix. Both pins are one upstream. |
| X8_ORPHANED_MIGRATION | n/a (0) | n/a | 0/1 | 0/7 | dormant on DEV: No supported orphan witness; migration target props are absent and tombstoned endpoints are hidden. |
| X9_CONTRACT_DRIFT | n/a (0) | n/a | 0/1 | 4/7 | dormant on DEV: Four UNKNOWN; available graphs supplied no reported supported route/contract conflict. |
| X10_UNTESTED_PII_WRITE | n/a (0) | n/a | 0/1 | 2/7 | dormant on DEV: No TestCase/TESTS or CoverageRecord/COVERS producer supplies verification facts. |

Overall: five TP, zero FP, zero unclear or unlabelled findings. Raw and automatically clustered descriptive precision are 1.000 at n=5, with 95% Wilson interval [0.5655, 1.0000]. Overall mutant recall is 1/11 (0.0909): one detected, five missed and five UNKNOWN. The new Board mutant was detected; the historical regex-bearing website mutant is UNKNOWN and remains in the denominator. No old mutant was removed or redefined.

## Qualification and calibration

The original bar is unchanged: at least 30 independently labelled clusters, precision at least 0.90 and Wilson lower bound at least 0.75, plus per-detector and independent-review conditions. This run has no sealed labelled clusters, five source-adjudicated DEV components and no eligible primary or double-review evidence. The lower bound is 0.5655. It does not meet the bar, despite the descriptive 5/5 point estimate.

Review metadata declares zero author accounts and has five missing eligible primary reviews, zero double-reviewed clusters and no agreement estimate. The required double-review sample is ten. Actual provider/account identities and the complete change-author roster remain required; display names and separate agents on the author account do not substitute for them.

Calibration has one upstream training group. The [0.85,1.00] band contains five labels at raw confidence 0.89, but its fit is not estimable because at least two upstreams are required. Holding out that upstream leaves zero training groups and zero estimable predictions. Both raw and calibrated holdout Brier estimates are unavailable; the mapping was not changed. The fitting-input digest is `0f5b9d049786839530cbd602fc3659667bb1cb83fa9cc4b8f1acc130e5f56c5f`.

The earlier zero-finding evaluation and its 0/10 mutant recall remain historical evidence in the root README. This report adds one supported source relationship, not general detector validation. Each of the nine detectors that did not fire on an unmodified non-self repository remains disclosed dormant on this measured scope, with its reason above.
