# ADR-0006: The security spine (default-deny export, redaction, extractor sandbox, bounded query surface, untrusted-text delimiting)

- **Status:** Accepted
- **Date:** 2026-08-29
- **Design reference:** `docs/design/v3.md` §2.5, §2.6, §2.7
- **Council findings:** C5 (CONFIRMED CRITICAL; the security lens returned **BLOCK**, with devil's advocate DA-08/DA-09, grill-me, architect A9), C8 (CONFIRMED CRITICAL), H4, H11, H20.
- **Contract:** `packages/ontology/src/contract.ts` (`Sensitivity`, `DEFAULT_SENSITIVITY`, `untrusted`, `ExtractorManifest`, `TraverseQuery`)
- **Status of implementation (2026-11-10):** two parts of the Decision have no code behind them in release 0.1.0. (a) Decision 3: there is no `contrib/` directory and no loader for third-party extractors. `seamline extract` runs only the five bundled extractors listed in `packages/cli/src/sandbox/first-party.ts`, so "refused unless explicitly enabled" has nothing to act on; an extractor written outside this repository can be checked with `seamline conformance` ([`docs/conformance.md`](../conformance.md)) and cannot be run by `seamline extract`. Where this record says "the four bundled ones", there are now five. (b) Decision 2: no extractor reads Terraform, so the Terraform rule is a constraint on future work, not a behaviour. The sole-writer Redactor of Decision 2 was not wired in when this record was accepted; [ADR-0011](ADR-0011-redactor-wired-as-sole-writer.md) records the wiring and [ADR-0013](ADR-0013-redactor-never-rewrites-identity.md) amends it. The host sandbox of Decision 3 is `packages/core/src/security/sandbox.ts`. "Phase-0 deliverable" in Decision 6 is a term from the predecessor plan; `THREATMODEL.md` is in the repository root.

## Context

The security lens was the only lens to return a **BLOCK** verdict, and it did so on a measurement rather than an opinion. A keyword sweep of all 485 lines of v2 found **zero occurrences** of authentication, authorization, redaction, sanitization, sandboxing, rate limiting, TLS, RBAC, tenancy isolation, or prompt injection _as controls_. Every hit for `auth`, `rate_limit`, or `Boundary (trust/network/tenancy)` was a property the tool **indexes about other systems**. v2 modelled trust boundaries it did not enforce. The entire security assertion of the document was a four-word parenthetical, `(values never stored)`, with no component behind it and no redactor in the package list.

This matters disproportionately because of what the artifact _is_. v2's §3 concentrates into one queryable file: every entry point; every endpoint's auth mode **including the null ones**; every secret reference plus the function that reads it; every pinned dependency with its CVEs; pre-computed taint source-to-sink paths; every IAM role; certificate expiries; image digests; the under-tested high-risk surfaces; incident history; the on-call rotation; the ownership map; and the tenant list.

**v2's §7 instructed the user to commit that file to git.** That is the C8 finding: aggregation makes the union strictly more sensitive than any part, union-merge only ever accumulates, there was no `sensitivity` field on the node type, no export policy, no default-deny, and `init` did not gitignore the output directory. Publishing source-to-sink paths and open VEX statuses is itself a disclosure incident, and §12 asked that the full PII lineage lens be _exported as evidence_.

Four sub-findings were each independently confirmed:

- **S3.** "Values never stored" is unenforceable when the inputs are `.env` files, compose files, Helm values, and Kubernetes Secrets (base64 is an encoding, not encryption). v2's "index the plan, never state" is also factually wrong in the other direction: Terraform **plan** files contain sensitive values, and v2's own extractor list included state anyway, contradicting its §12.
- **S4.** Untrusted text (review comments, issue text, commit messages, dependency metadata, annotation comments) was served verbatim into a Builder agent's context. Agent-written persistent nodes turn a single injection into **persistent memory poisoning**.
- **S5.** Third-party and subprocess extractors are arbitrary code execution by design, with no sandbox, inheriting `AWS_*`, `KUBECONFIG`, and SOPS keys from the parent environment.
- **S2 / S6.** The MCP server specified no authn, authz, transport, TLS, rate limiting, audit, or tenancy, and exposed `cypher` as an unrestricted arbitrary query, executing _inside Postgres_ on the AGE adapter. Lens YAML carried raw Cypher and ADR constraints were an expression DSL, so a fork's pull request executes attacker-chosen code in a CI job that v2's own design required to hold production secret-store credentials.

## Decision

**Five controls, each with a component behind it and a conformance test in CI. None of them is a guideline.**

### 1. Export is default-deny

- `sensitivity ∈ {public, internal, confidential, restricted}` is a **required field on every node**, defaulted **per kind**. `DEFAULT_SENSITIVITY` in the contract is total over `NODE_KINDS`, so a new kind cannot be added without a sensitivity decision. Infrastructure, security findings, and people default to `restricted`.
- `seamline export --profile <name>` where a profile is an **allow-list**. No profile, no output. **There is no "export everything" flag.** Removing the capability is the control; a default that can be overridden by a flag is not default-deny.
- `seamline init` writes `seamline-out/` into `.gitignore`. Snapshots are never committed by default, reversing v2's explicit instruction.

### 2. A `Redactor` is the sole writer to the store

- The `Redactor` runs post-merge and is the **only** component with write access. Every string field passes through an entropy and pattern scan; a matched secret is replaced by a _reference_, never a value.
- Making it the sole writer, rather than one step among several, is what turns "values are never stored" from an assertion into a property. There is no code path that reaches the store without passing through it.
- **Terraform: HCL source and `terraform graph` output only. Never state, and never plan.**
- **Conformance gate:** a canary-secret corpus. A planted secret must never reach the store or any export.

### 3. Extractors are sandboxed

- Every extractor ships a capability manifest: `{ reads: [globs], net: false, env: [allow-list], memMb, timeoutS, provenanceCeiling }`. `net` is typed as the literal `false` in the contract, so an extractor cannot declare network access at all in v0.1.
- **The host enforces it**: scrubbed environment (no `AWS_*`, no `KUBECONFIG`, no SOPS keys), reads confined to the repo and the extractor's own code with no filesystem writes (a read allow-list plus a guard, not a read-only mount), no network, wall-clock and memory caps.
- Third-party extractors live in `contrib/`, are unsigned by default, and are **refused unless explicitly enabled**.
- XML external entities are disabled globally; `$ref` resolves only within the repo root with no network fetch; parse depth and input size are capped. This closes H11 (arbitrary file read and SSRF through BPMN XML, GraphML, OpenAPI `$ref`, and remote Helm bases).

### 4. The query surface is bounded and typed

- **`cypher` is removed from the store interface** (see ADR-0004). What replaces it is `TraverseQuery`: an explicit start set, an explicit list of edge kinds, a direction, a **required `maxDepth`** bounded by construction, an optional target-kind filter, and a result limit. The store rejects a depth above its configured cap.
- MCP in v0.1 is **stdio-only, parameterized tools only, no raw query tool**, with per-tool scopes and an audit log.
- **No externally-reachable query surface without a named consumer.**

### 5. Untrusted text is tagged and delimited

- `untrusted` is a field on the node. Every string sourced from third-party content (dependency metadata, issue and pull-request text, commit messages, code comments) carries it.
- Untrusted text is **delimited when rendered into agent context**. An attacker who lands a comment in a transitive dependency must not be able to instruct a Builder agent reading Seamline output.

### 6. Seamline is its own first user

`THREATMODEL.md` is a Phase-0 deliverable, and `ThreatModel` is a core node kind. A verification tool that does not model its own threats is making a claim it has not tested on itself.

## Consequences

### Positive

- The most dangerous property of the artifact (aggregation makes the whole more sensitive than any part) is met with the only control that matches it: an allow-list with no bypass.
- Sole-writer redaction is a structural guarantee rather than a discipline. It is testable by planting a canary and asserting it never appears, which is an assertion about authoritative output rather than about the presence of a scrubbing function.
- Typing `net: false` and requiring `maxDepth` puts two of these controls in the type system, where they are enforced at compile time in the common case and cannot be forgotten.
- Removing `cypher` closes the arbitrary-execution finding and the adapter-parity problem with one change (ADR-0004).
- Modelling `pii` does **not** create compliance liability; the council confirmed that field-level lineage genuinely satisfies GDPR Article 30. The liability was entirely in export handling, which is what these controls address.

### Negative

- **Default-deny export is friction on the primary happy path.** Every new adopter must author or choose a profile before they see any output, and some will read that as the tool not working. This is accepted; it is the single control that most reduces blast radius.
- The `Redactor` will produce **false positives**: high-entropy strings that are not secrets (hashes, base64 fixtures, generated identifiers) get replaced by references, and a user seeing their test fixture redacted will not enjoy it. Tuning entropy thresholds is ongoing work with no clean answer.
- Sole-writer redaction is a **serialization point** on the write path, with a throughput cost on large repos.
- The extractor sandbox makes the plugin contract meaningfully harder to write against, which raises the barrier for exactly the community contributions the project needs. Refusing unsigned `contrib/` extractors by default raises it further.
- Depth-bounded, edge-kind-enumerated traversal cannot express some genuinely useful queries. Users will hit the ceiling and be unable to route around it, by design.
- Tagging text `untrusted` does not sanitize it; it only enables correct handling downstream. A consumer that ignores the flag is still vulnerable, and Seamline cannot enforce behaviour in a consumer it does not own.
- Indexing contributor commit activity remains personal data (H20). v0.1 keeps `Commit` and `Owner` in the core profile and defaults `Owner` to `restricted`, which is a mitigation, not a legal basis. Retention and pseudonymization are unresolved and are named here so they are not forgotten.

## Alternatives considered

**Encrypt the export instead of restricting it.** Rejected: the export is meant to be read by tools and humans, so the key must travel with it, so the control is decorative. It also does nothing about what accumulates _inside_ the store.

**Export everything by default, with a `--redact` flag.** Rejected: this is v2 with a flag added. The failure mode of a security control that must be remembered is that it is not remembered, and the disclosure is unrecoverable once it is in a git history.

**Keep `cypher` but validate queries with a parser allow-list.** Rejected: query-language allow-lists are a well-known losing position, and on AGE the query still executes inside the database. A typed traversal API removes the class of attack rather than filtering instances of it.

**Sandbox extractors with a language-level mechanism (Node permissions, a VM realm) rather than a process boundary.** Rejected for the untrusted case: in-process isolation in a runtime this dynamic is not a security boundary. It remains adequate for _first-party_ extractors, which is why `contrib/` is treated differently from the four bundled ones.

**Strip untrusted text entirely rather than tagging it.** Rejected: commit messages and issue text are genuinely useful context for an agent. Tagging plus delimiting preserves the value while making the trust level explicit at the point of use.

**Defer the security spine to v0.2, after product-market fit.** Rejected explicitly. Every control here is unretrofittable: `sensitivity` is a required field on a persisted node, sole-writer redaction is an architectural position, and the sandbox is a plugin-contract shape. Retrofitting any of them breaks the ontology (see `ontology/README.md` on why that is the most expensive kind of change available).
