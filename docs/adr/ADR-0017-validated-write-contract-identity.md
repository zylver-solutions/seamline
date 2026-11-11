# ADR-0017: natural identity for a locally bound write contract

- Status: accepted. The bounded producer is implemented, with development parent/fix proof linked below. Independent qualification and release acceptance remain separate. Amends [ADR-0016](ADR-0016-file-identity-carries-its-path.md) only for this local Zod producer; existing emitted identities stay unchanged. Where the two differ on whether the producer is implemented, this record governs.
- Date: 2026-10-22
- Design: [X7 upper-length](../design/x7-upper-length.md).
- Forced by: the X7 validated-write producer work, specifically the function-local schema in the pinned case, [Umami pull request 4348](https://github.com/umami-software/umami/pull/4348) (pinned commits in `docs/design/x7-upper-length.md` and `eval/corpus.json`). `POST.schema` recurs across route files. Adding a path, position or hash to disambiguate it would violate the identity boundary; silently sharing one Contract would combine unrelated facts.

## Decision

For this newly admitted producer only, the Contract's canonical name is `validated-write:` followed by the lowercase hexadecimal encoding of the UTF-8 bytes of canonical JSON for a four-element tuple:

1. The declared owning package name.
2. The lexical chain of named declarations ending at the schema binding.
3. The resolved persistence wrapper's owning package and lexical named declaration chain.
4. The declared Prisma model name reached through the complete write binding.

Elements 2 and 3 are arrays of declared names, so punctuation cannot make two different chains equal. Serialize the tuple as JSON without whitespace, encode those UTF-8 bytes as lowercase hexadecimal, and append that encoding to the prefix. This is a reversible encoding of declared identity inputs, never a digest or generated identifier. It contains no slash, backslash, hash separator or control byte, so existing Contract and SchemaProperty canonical-name validators remain unchanged. The inverse must recover the exact canonical tuple. Require round-trip, scoped-package, Unicode and punctuation conformance tests, including distinct tuples with names resembling separators. Source paths, import paths, route directories, line numbers, ordinals and hashes supply no segment. A SchemaProperty retains the existing contract and JSON-pointer key. No ontology contract change is authorized.

The model and wrapper are permitted inputs only after the producer proves the bounded source relationship in the linked design. An inferred suggestion cannot supply them. Unknown package ownership, unresolved or multiple storage models, incomplete binding, or an ambiguous declaration withholds the contract. Two distinct declarations with the same key withhold every conflicting contract and property and exclude all affected files from that run's deletion authority. Repeated visits to one declaration are not a second declaration.

A move preserving these four inputs preserves these non-File ids. A declared-name, package or storage-binding change changes an id only when it changes a tuple input. A write-operation or forwarded-field change need not change the tuple. The implementation must record its exact minting function and add identity, collision and eligible-move conformance tests before claiming this amendment is implemented.

## Consequences

The key names a source-declared relationship and survives ordinary file moves. It requires no user annotations, aliases, path suffixes or generated identifiers. Existing top-level Zod contracts retain their current variable-name identity.

The cost is conservative coverage. Two otherwise indistinguishable local declarations are withheld, even when a human could tell them apart from their files. Changing an admitted binding can retire an old contract identity. Failed or partial analysis cannot delete that old identity outside the current authoritative scope. Other local schema shapes remain unsupported.

## Alternatives considered

A path, source position, discovery ordinal or content digest would give convenient uniqueness but would change the identity contract or make identities depend on traversal or unrelated edits. A route-derived domain would substitute a naming guess for a storage fact. Using only the local variable and function name collides in the cited case. Accepting the first collision or combining schemas would manufacture facts. All are rejected.

## Implementation boundary

The minting function is `writeContractName` in `packages/extract-contracts/src/write-identity.ts`; `decodeWriteContractName` rejects noncanonical encodings. `proveLocalWrite` in `write-binding.ts` supplies the declared tuple after source analysis, and `extractValidatedWrites` in `write-extract.ts` emits only admitted bindings. Names-only reservations participate in duplicate rejection without emitting a contract.

`write-identity.test.ts` covers scoped names, Unicode, punctuation and canonical round trips. `write-extract.test.ts` covers eligible file moves, duplicate keys and unsupported but identifiable reservations. `packages/cli/src/validated-write-lifecycle.test.ts` checks real-store retention and recovery with a repeated deterministic run id. The [development parent/fix proof](../evaluation/x7-parent-fix.md) records the emitted key, endpoint facts and binding witnesses. ADR-0016's original table remains a historical implementation record; its supplement states this producer's permitted inputs.
