# X7 hardening refusal evidence

The required real-source acceptance is unmet. The five-to-zero result of the first producer implementation (2026-10-23) remains historical evidence from an earlier implementation; later source-world guards withheld the same case. It earns no current firing or merge credit.

The subsequent [whole DEV run of the hardened draft](dev-hardened-draft.md) includes both pins; both finish with X7 UNKNOWN and zero findings. It records the stricter parser refusal and the complete per-detector precision/recall table. The earlier stopped runner below remains historical and does not acquire a fixed-negative result.

[The machine-readable negative record](x7-hardening-refusals.json) preserves the upstream source pins, detector output and artifact hashes; the tool candidates' own commit ids belong to the private history and are not carried over. Full-pipeline candidate A (the draft of 2026-10-23, identified in the JSON record) ran the parent under Node 24.22.0 with default evaluation limits. All four scopes passed, but X7 was UNKNOWN with zero findings after 76,349 ms of extraction. The required parent-conflict assertion exited 1 before the fix ran. That omitted fix is neither clean nor an examined negative.

| Source helper candidate | Both pinned checkouts | Refusal source |
| --- | --- | --- |
| Candidate A | Client provenance UNKNOWN | `src/lib/utils.ts:11`, arbitrary computed method hook |
| Candidate B | Client provenance UNKNOWN | `scripts/check-env.js:6`, unknown computed property read |

These helpers inspect source only. They produce no graph facts or findings and do not replace CLI evaluation. No upstream install, build, test or application code ran. Later implementation changes require their own exact-head measurements.

X7 is dormant on this measured hardened parent. The accepted design still requires the actual parent conflict and examined fixed negative before merge. Supporting an additional source form requires a sound bounded proof; skipping a guard, treating UNKNOWN as clean or substituting historical positives cannot meet it.

The historical candidate-draft DEV report remains separate: five same-account TP labels, raw precision 1.0 on n=5, Wilson lower bound 0.565517531341, X7 mutant recall 1/2 and overall recall 1/11. It provides zero eligible independent-account review and no sealed qualification. Those numbers do not describe the later hardened producer. The original sealed thresholds and independent-review requirements remain unchanged.
