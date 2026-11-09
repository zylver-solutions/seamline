# @seamline/contradictions
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The ten contradiction detectors of design v3 §5 (X1–X10). A contradiction is two extracted, authoritative facts that disagree — never the absence of a declaration.

All ten have synthetic outcome tests. X3 and X10 still lack producer facts needed to fire on real extraction. X8 has authored declared-DDL replay extraction proof, but complete non-self-authored parent/fix acceptance remains unmet and X8 stays dormant for evaluation. X7 now reads a bounded source-proved validated-write relationship on request SchemaProperty facts, with a [historical parent/fix reproduction](../../docs/evaluation/x7-parent-fix.md) superseded by [hardened UNKNOWN results](../../docs/evaluation/x7-hardening-refusals.md). X7 is dormant on the measured development corpus, current parent/fix acceptance is unmet, and independent precision and broader coverage remain unqualified. X5 has authored extraction fixtures but no current unmodified corpus firing. X4 and X9 cover only part of their range. The root README records these limits.

Most users should not import this directly — `seamline check` in `@seamline/cli` runs these detectors and reports findings. Import it directly only if you are building a tool that needs to run or extend the detector set itself.

Three properties hold across every detector: both endpoints of a finding must be facts (provenance `EXTRACTED` or `DECLARED`; `INFERRED` and `LLM_SUGGESTED` never justify one); the join connecting them is priced by `infer-join`'s confidence, which caps the finding's severity and produces nothing below 0.35; and a failed scope yields `UNKNOWN`, never a finding, so infrastructure flakiness cannot manufacture a false failure. A detector can also be `UNKNOWN` for a reason its scope status does not show: an optional `unknownWhen(g)` on its spec reads facts the extractors recorded (for example that some writes could not be attributed to a table) and returns the reason; any string makes the outcome `UNKNOWN` exactly as a failed scope does.

X1 compares stated response nullability only. X1 and X2 withhold generic code-field comparisons because no shipped fact establishes a stored-row or insert role. Missing comparable facts report UNKNOWN. Authored controls do not establish external validation.

It exports:

- `blockedScopes`, `compareContradictions`, `defineDetector`, `gateSeverity`, `severityCeiling`, `CONFIDENCE_FLOOR`, `SEVERITY_CONFIDENCE_FLOOR`, `SEVERITY_RANK`, and the `DetectorSpec`, `FindingDraft`, `SeamlineDetector` types — the shared detector contract.
- `ALL_DETECTORS`, `DETECTORS_BY_CODE`, and the individual detectors (`x1Nullability`, `x2Type`, and the rest of X1–X10).

**Stability tier: two tiers apply here, and they move independently.**

- The **code** (this package's exports, including the detector implementations) is **library surface**: published, importable, documented as unstable below 1.0.
- The **contradiction catalog** (the meaning of codes X1–X10) is part of the **specification surface**: removing a code or changing what it means is breaking and requires a major bump; a new code firing on repositories where it previously stayed silent is not.
