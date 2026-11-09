# ADR-0013: The Redactor never rewrites identity or locator fields

- **Status:** Accepted. Amends ADR-0011 for how identity is handled; ADR-0011's decision to wire the Redactor as the sole writer stands.
- **Date:** 2026-10-18
- **Design reference:** `docs/design/v3.md` §2.1 (path-free identity), §2.5
- **Forced by:** a dogfood finding ("redactor hashes some File ids and MIGRATED_BY paths"), reproduced and measured below.
- **Contract:** `packages/core/src/security/redactor.ts`, `patterns.ts`, `redacting-store.ts`; `packages/cli/src/commands/extract.ts`

## Context

Extracting this repository produced `«redacted:sha256:...»` where a repository path belonged. Three populations were affected:

1. **Nine `File` ids.** `extract-change` emits a `File` node for every path a commit touched, with the path as its canonical name. Nine tracked paths (five `docs/**/*.md`, four `.sql` migrations) came back as `demo:File:«redacted:sha256:0f0976ab».md` and so on. Reproduced by committing those nine paths to a scratch repository and running the real extractor.
2. **Ninety-five path-valued fields in the dogfood baseline as it stood when this was found** (the full self-extraction, `docs/dogfood/baseline/extract.sif`, since replaced by the narrower reviewed-surface baseline; its `examples.sif` and `why-orders-customer-email.json` are where the same migration path still appeared hashed): the `path` and `sourceRef` of 15 data nodes (30 fields), and 65 `srcFile` or `dstFile` fields across 41 edges (`MIGRATED_BY`, `CONTAINS`, `MAPS_TO_FIELD`, `EXPOSED_AS`, `BACKED_BY`), all for the same four `.sql` files.
3. **Three `props.type` values** in test fixtures that hold a planted credential on purpose. Those are correct and unchanged.

The rule that fired on every one of the first two populations was `high-entropy-string`, at 4.205 to 4.366 bits/char against a threshold of 4.2. The cause is arithmetic, not a bug in one regex: the token class `[A-Za-z0-9+/=_-]` contains `/`, so a repository path up to its extension is one token, and Shannon entropy over a long string rises with its length and its count of distinct characters. `entropy.ts` calibrated "repo-relative paths" at 3.87 to 3.95 on short paths. Measured over this repository's 235 path tokens of 32 or more characters, the median is 3.76 at 32..40 characters and 4.13 at 61 or more, with a tail to 4.37. The only structural guard that could have saved them, `cased-identifier`, splits on `_` and `-` but not `/`, so `examples/harbor-books/db/migrations/0014_orders_shipping` never reads as a run of single-cased words. Nine of those 235 tokens tripped, all between 42 and 79 characters; the count grows with every long file name.

The redactor treated every string alike. It had no notion that a node id or a `path` is structure, so it did to an id what it does to a password: replaced it. That is the part that breaks things. A rewritten id is no longer `{repo}:{kind}:{canonicalName}`, which is invariant 1 (identity is path-free and is the natural key); every edge that points at it, every join keyed on it and every consumer that globs on a path then silently misses it. ADR-0011 accepted this ("Node identity can change under redaction") and carried a residual for it: an edge written before its node, in the same run, resolves against the old id.

Two further rules rewrote structure for reasons that have nothing to do with entropy. `secret-assignment` reads `POST /v1/tokens:refresh` and `src/credentials.ts#getCredential:forUser` as `key: value`, and `openai-key` reads `docs/sk-learn-integration-guide.md` as a key. Both were reproduced against the unfixed redactor.

## Decision

**A node id, an edge's `src` and `dst`, and the repository-path fields are never rewritten.** A secret in free text is still replaced by a reference. A credential in one of these fields is refused.

### 1. Two field classes

- **Identity and locator fields:** the canonical name of a node id; an edge's `src` and `dst`; `path`, `sourceRef` on a node and on an edge; `srcFile`, `dstFile`; a node `name` that repeats its canonical name or its path (a `File` is named by its path); and the props in `LOCATOR_PROP_KEYS` (`entry`, `file`, `path`, `declaredHandler`, `jsonPointer`, `specifier`, `srcFile`, `dstFile` and their snake_case spellings), each of which a shipped extractor emits.
- **Free text:** everything else. Behaviour is unchanged: every pattern rule and the entropy heuristic run, and a match becomes a reference.

A prop key not in `LOCATOR_PROP_KEYS` is free text. A new extractor that emits a path under a new key fails in the safe direction: it is scanned in full, and the cost is a false positive in a prop, not a leak.

### 2. What is detected in an identity or locator field

Only rules marked `closedFormat` run: a self-delimiting token with a published prefix and charset (AWS access key id, GitHub, GitLab, Slack, Stripe, Google, npm, age, JWT, PEM). The entropy heuristic does not run, and neither do the contextual or loose rules (`secret-assignment`, `bearer-header`, `basic-auth-header`, `k8s-secret-data`, `aws-secret-access-key`, `openai-key`). Each of those needs syntax a path or an id does not have, or has a prefix loose enough to collide with kebab-case names. A rule that is not marked is free-text-only by default, so adding a rule never starts refusing records until someone decides it is precise enough. One unmarked rule, `connection-string-password` (`scheme://user:password@host`), also runs over locator props: a prop such as an import `specifier` can be a URL, the rule is as self-delimiting as the closed-format ones, and it cannot match a repository path. A closed-format match that is a name of three or more lower-case words made of letters only (`github_pat_is_valid_for_repository`) is an identifier and is let through. A digit anywhere in the match keeps the refusal, because some real formats are entirely lower case with digits in their random part (the legacy Slack `xoxp-<digits>-<digits>-<digits>-<hex>`).

### 3. A closed-format credential in an identity or locator field is refused

`redactNode` and `redactEdge` throw `RedactionError` (carrying `field` and `rule`). The message names the rule and the field and quotes the surrounding text with the credential replaced by its reference; it never contains the credential. That `redactGraph` call returns nothing, and the replacements it made before the refusal are dropped from the redaction report, since none of them is stored.

In `extractCommand` the refusal becomes **that extractor's result being FAIL**, with the message as its diagnostic and the extractor's authoritative scopes retained. `extractCommand` writes an extractor's nodes before it redacts each edge group, so a refusal in an edge field can leave that extractor's nodes and earlier edge groups in the store; they are not trusted, because the result is FAIL. Retaining the scopes is a stronger guarantee than a store error gives (that path records no scopes), and it gives the guarantees of invariant 3 (UNAVAILABLE is never PASS): the scope is recorded FAIL for the run, queries over it answer UNKNOWN rather than falling back to an older run's PASS or reporting a node as absent, and a FAIL result never tombstones. `extractCommand` also now records an extractor's result only after its writes succeed, so a refusal (or a store error) leaves exactly one result per extractor; before, it left a PASS and a FAIL, which `extractor_results (run_id, extractor)` rejects as a primary-key violation at `finalizeRun`.

### 4. The rule is visible

The reference format `«redacted:sha256:xxxxxxxx»` does not carry the rule and does not change: the canary corpus pins it, `REDACTION_MARKER_RE` and idempotence depend on it, and changing it would rewrite every stored value. The rule is carried by an accompanying record instead. `seamline extract --json` now includes `redactions` (`total`, `byRule`, and one entry per replacement with `rule`, `ref`, `target`, `field`, `length`, `entropy`; never the replaced text), and the text output prints one line, `redacted N value(s) before storage: rule xK, ...`. A refusal is the extractor's FAIL diagnostic.

### 5. `idRemap` is removed

Ids no longer change, so `RedactionReport.idRemap` and the cross-call ordering residual in ADR-0011 are gone with the code they described.

## Consequences

### Positive

- The nine `File` ids and ninety-five dogfood fields are the repository paths they name. Path-based joins and migration globs find them. `git mv` changes an id only because the path changed.
- Every canary in the corpus is still redacted in every free-text field; the canary graph is planted across `name`, node props and edge props, and a new test asserts the same node keeps its id and path while the secret in its prop is replaced.
- A credential in an id or path is no longer silently turned into a different id. It is loud, it names the rule and field, and it fails closed through the existing status machinery.
- Rewriting structure for reasons unrelated to entropy (`tokens:refresh`, `sk-learn-...`) stops.
- The redaction record answers "which rule fired" without re-running an extractor.

### Negative

- **An unrecognised-format secret in an identity or path field is stored as given.** The entropy heuristic cannot tell a content-hashed bundle name from a credential in a path, and refusing a record on that guess would fail extractors on ordinary repositories. THREATMODEL R1 (the redactor is a heuristic) is widened by this one sentence. A path is repository structure: anyone who can read the repository already sees it.
- **A closed-format credential in a path fails the extractor, for as long as the path is in view.** `extract-change` reads history, so a file that was ever committed with a token in its name keeps `extract-change` at FAIL until that range no longer contains it. The remedy is the one for any leaked credential: rotate it and exclude or rewrite the path. The failure is the signal, and the other extractors are unaffected.
- A free-text prop that holds a long path (a type annotation, a comment) can still be hashed by the entropy rule. This ADR does not touch the free-text classifier; the `redactions` record is how those are found.
- `secret-assignment` also matches a TypeScript type annotation such as `secret: string`, in free text. Out of scope here; noted.

## Alternatives considered

**Raise the entropy threshold, or the minimum length.** Rejected. The nine paths score up to 4.37; the weakest 40-character base64 secret in the calibration scores 4.29. No threshold separates them, and any value high enough to clear the paths stops catching secrets in free text, which the canary corpus exists to prevent. It would also leave the next 70-character path with 4.4 bits/char to trip it.

**Remove `/` from the token class.** Rejected. Standard base64 contains `/`, and the AWS secret-key canary (`wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`) would split into pieces below the 32-character floor and be missed.

**Treat `/` as a separator in the `cased-identifier` guard.** Rejected as the fix, though harmless. It covers lower-case and upper-case paths and nothing else; a camelCase path (`src/models/orderResponse`) still trips, and it does nothing about an id rewritten by `secret-assignment`. The structural answer is that these fields are not scanned like text.

**Keep rewriting, but record the remap and warn.** Rejected. It keeps the id instability and the join loss and adds a second thing to read.

**Drop only the offending node and report PASS for the rest.** Rejected. A node missing from a PASS scope reads as "this fact does not exist", which is exactly what invariant 3 forbids. FAIL with the scope retained reads as UNKNOWN.

**Refuse the whole run instead of failing one extractor.** Rejected. One extractor's refusal does not make another's facts untrustworthy, and the existing per-extractor FAIL already says so.

**Carry the rule in the reference (`«redacted:high-entropy-string:sha256:...»`).** Rejected. It changes the stored value of every redaction (including the three that are correct), breaks the idempotence regex, and the same information is in the report, which also says where and how long.
