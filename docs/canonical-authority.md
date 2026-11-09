# Canonical authority and format compatibility

[ADR-0018](adr/ADR-0018-canonical-name-authority.md) confines a deletion claim to known canonical names in one literal source path. The path restricts the claim; it never becomes an identity input. Existing path selectors keep their meaning. This foundation supplies no new detector findings or real-repository support by itself.

Use `encodeCanonicalSelector` to produce the reserved `/@canonical/v1/` encoding. It accepts literal `exact` and `prefix` rules, validates Unicode scalar strings and emits one compact representation. Readers refuse alternate encodings, unknown versions and invalid metadata. A run allows at most 65,536 encoded UTF-8 bytes and 2,048 rules across its canonical claims. Exhaustion cannot broaden into filename authority.

Decoded paths and rule literals receive the existing structural credential guard after budget checks. Hex encoding cannot bypass identity or locator refusal. Canonical errors expose neither the envelope nor a retained copy of it. Extraction validates authority before fact writes; a refused or failed result keeps its scope and kind coverage but drops selectors after declared-scope fallback. The recorded failure coverage omits rejected selector envelopes and grants no absence proof or sweep.

A canonical match requires the active repository, the claimed kind, agreement between the id and stored kind, the literal source path and a matching canonical name parsed from the id. Display names do not participate. An edge also requires its declared scope and both endpoint repositories; its selected anchor must have a stored node record, which may be tombstoned. A missing claimed source cannot fall through to a destination anchor. SQL values are bound parameters and canonical rules are literal comparisons.

The SQLite identity callback receives UTF-8 bytes and decodes them strictly, preserving BOM characters. [Node 22.13's TEXT callback conversion](https://github.com/nodejs/node/blob/v22.13.0/src/node_sqlite.cc#L146-L163) stops at NUL; its BLOB conversion carries an explicit length. Passing bytes keeps complete malformed identities visible to validation on the supported Node floor, so a truncated id cannot gain authority. The floor regression covers both node and edge identities.

`currentObservationOf` checks completed run authority as well as a node's liveness and run stamp. A retained fact outside the current claim stays live without becoming current, including after a deterministic same-id retry. Missing, failed, unavailable, unfinished or malformed authority supplies no current observation. Hosts must use this shared matcher when adopting canonical claims. The X7 producer and its worker transport must adopt these checks and framing before emitting canonical authority.

## SQLite version 2

Opening a version-1 graph migrates it in one transaction. Facts, run order, stamps and tombstones remain intact. Old scope claims receive deterministic ordinals in scope order. New claims use `authority_claims_v2`, keyed by run, extractor and claim ordinal, so one result can preserve several claims in the same scope. The version marker commits with the migration; validation or ontology disagreement rolls everything back.

The old `authoritative_scopes` table remains empty with an unconditional write-refusal constraint. Version-2 opens require that guard. Older bootstrap code cannot recreate a writable table before refusing the new version. An already-open older connection sees no certified scopes and its scoped finalization fails transactionally. The non-cascading foreign key also refuses an old same-id restart while new claims still reference the extractor result.

This guard prevents old scope certification. It does not lock out older raw fact upserts. Those writes, and unfinished or empty-authority old runs, cannot establish current canonical authority. Unsupported and unversioned databases are refused rather than silently adopted.

## SIF version 2

Every complete new SIF document starts with the literal ASCII line `seamline-sif/2.0.0` followed by LF, including empty documents. It is followed by the existing JSON-lines record union. `SifLine` has no new variant. The non-JSON line forces both older core readers and the older permissive CLI reader to reject before evaluation; an unknown JSON record type would not provide that barrier.

CLI snapshots use the shared core writer and include the actual persisted `RunRecord`. Extraction supplies its clock to the SQLite adapter, so completed run metadata stays deterministic when the extraction clock is frozen. Run identities retain the existing structural credential guard. A writable snapshot cannot substitute a different run id or result set. Framed documents allow at most one run record and unique status results; accompanying statuses must agree with the run's results. Repeated metadata supplies no extra authority and its canonical rules are decoded from the primary record.

Updated readers accept headerless version-1 documents only with legacy path claims. Canonical claims require version-2 framing. Standalone `parseSifLine` calls default to legacy; a framing-aware caller can supply the explicit version-2 context. Unknown, duplicate, late, CRLF or unterminated framing is refused. Record bodies may retain legacy CRLF handling.

The old CLI `t: "sif"` metadata record is accepted only in headerless legacy snapshots. Version-2 writers emit the existing `t: "run"` variant instead. Legacy snapshots without a full run record remain readable for diff; writing them as version 2 requires actual run metadata. Repository names, timestamps and ontology versions are never fabricated to fill the gap.

A full run record is the primary result set even when only some redundant status records accompany it. Legacy run/status disagreements also fail before upgrade. Snapshot writing requires a nonblank completion marker. Alignment grants no scope authority to SIF data without completed run metadata, or to a store whose newest run is unfinished; these facts remain distinguishable from a completed PASS.

Complete core reads validate framing and aggregate authority before exposing any records. Stream reads return only after complete validation. Writers validate the whole input before emitting even the framing line. `canonicalSifOrder` and `canonicalSifLine` are body helpers, not complete document writers; worker transports must use the framed document writers. `writeSifTo` returns the number of JSON records, excluding the framing line.

The CLI validates the complete typed document before returning a snapshot. Evaluation counters and the dogfood selector recognize the framing line while keeping fact counts unchanged. The example subset preserves selected node and edge bytes and copies the actual run metadata with `results: []`: the subset has no full-repository extractor authority or counts. This keeps unrelated source counts out of the example baseline. A dogfood framing, run-header or version change still needs its own reviewed baseline PR. None of these compatibility changes supplies sealed evaluation, independent labels, a precision waiver or an examined negative for an unsupported detector.

CLI SIF diagnostics redact untrusted record details using pattern and entropy rules. Their source filenames follow the existing locator policy: pattern rules still apply, while entropy alone does not turn an ordinary long path into an opaque reference. Alignment preserves the sanitized diagnostic without adding the raw filename back.
