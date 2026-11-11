# Comments in JSON contract documents

Status: implemented in 0.1.0 (code: `parseDocument` in `packages/extract-contracts/src/document.ts`, tests in `document-comments.test.ts` beside it; status checked 2026-11-10). Written as a proposed implementation boundary, part of the work toward [the aspirational state](aspirational-state.md). Subordinate to v3. This changes the existing structured-document reader, without adding an extractor, dependency, node kind or public entry point.

## Named consumer and measured limitation

X9 refuses to infer operation absence when a structured document could not be read. In the completed development run of 2026-10-26 (date as originally written; the retained record of that measurement, [dev-hardened-draft.md](../evaluation/dev-hardened-draft.md), is dated 2026-10-23), the existing Dokploy pin `e0c8d80cdea15a4ac3fe495a6ad38e043b4b80b5` records two unread structured documents. A separate census of its 221 committed JSON files finds two strict-JSON parse failures: `apps/dokploy/tsconfig.json` and `packages/server/tsconfig.json`, both containing block comments. This is input-coverage evidence, not a shipped X9 defect or a claim that its committed mutant is detected.

The consumer is the existing `extract-contracts` structured-document inventory and X9's `unreadStructuredDocuments` guard. Filename exclusions cannot prove the absence of a contract: a document named `tsconfig.json` could still declare OpenAPI operations. Read the supported syntax and inspect its complete value instead.

## Syntax and safety boundary

For the already admitted `.json` extension, in any letter case, support JSON values with `//` line comments and `/* ... */` block comments wherever JSON whitespace is legal. Replace comments with whitespace while preserving line endings and token boundaries, then use `JSON.parse` for the value grammar. Quoted strings and their escape sequences retain their exact bytes. Reject unterminated comments, unterminated strings and every non-comment syntax error. Error diagnostics retain only the fixed `JSON_PARSE_ERROR` code.

This follows the comment syntax of the [JSONC draft specification](https://jsonc.org/). Trailing commas are optional there and remain unsupported here. No YAML fallback, single-quoted strings, unquoted keys, hash comments, JavaScript expressions or JSON5 syntax is admitted. The existing file-size, source-count, reference, symlink and root-containment limits still apply. No `.jsonc` discovery extension is added in this change.

Parsing success makes a document readable; it does not declare the document a contract. Existing OpenAPI/JSON Schema classification still decides whether it emits facts. Malformed discovered documents remain outside the authoritative claim and increment unread coverage. Malformed explicitly selected or strictly named contract documents retain their existing scope failure. No counter is manually set or waived.

## Required proof

Parser controls cover both comment forms, all existing line endings, markers inside strings, escaped quotes and backslashes, token separation, malformed comment tails, other rejected syntax, case-insensitive JSON dispatch and source-free diagnostics. Extraction controls require zero measured unread documents for ordinary commented configs, operation extraction from a commented document under a config filename, retained unread/failure outcomes for malformed inputs, and identical fact bytes for plain and commented copies of one declaration.

Acceptance required before this change was merged: run fresh source reviewers including the adversarial invariant review, focused checks on Node 22.13 and 24, ordinary full verification, leak scans, package dry-runs and the change's own green CI and DCO check. Any baseline change needs its own reviewed pull request. Current precision, recall, dormancy, independent-review and sealed-evaluation requirements remain unchanged. Neither successful parsing nor an authored fixture counts toward the sealed evaluation that is deferred to 0.2.0 (called M2 in `eval/README.md`).
