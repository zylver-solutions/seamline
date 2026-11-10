# extract-data: a table whose other contributing file is unread

Status: design proposal, not implemented (status checked 2026-11-10). It concerns the open item on deleting tables whose contributing files are withheld; that item remains open in 0.1.0 and is disclosed as a known limit in the root `README.md` ("A table can be tombstoned while an unread file still declares it"). This document admits no implementation or residual-risk acceptance.

## Consumer and reported problem

The existing consumer is `extract-data`'s deletion-authority claim, consumed by the SQLite and in-memory tombstone sweep and the CLI graph. This consumer justifies a design pass for its demonstrated defect. A second consumer is not a prerequisite; a shared store or protocol change still needs bounded contract and migration review under [v3](v3.md).

For partial discovery, `dataClaimFor` excludes unread paths and same-stem aliases from the data selector. The store sweeps using one owning `nodes.path`, the file of the node's last defining statement. The reported reproduction is:

1. Run 1 reads `db/a.sql` (`CREATE TABLE shared`, `CREATE TABLE keep`) and `db/b.sql` (`ALTER TABLE shared ADD COLUMN extra text`). `public.shared` is owned by `db/a.sql`.
2. Run 2 removes `shared` from `db/a.sql`; `db/b.sql` is unreadable because of a symlink, size limit or mode 0.
3. The read `db/a.sql` remains inside the claim, so `public.shared` is tombstoned although unread `db/b.sql` may still contribute to it.

[Row A of the applied design](real-world-inputs.md) records the node residual as reproduced. These steps are retained as reported evidence, not a new execution. The proposed `MIGRATED_BY` and `FK_TO` edge variants remain unconfirmed.

The extractor has no prior-run input. The current store does not already hold complete contributor evidence merely because it persists nodes. Neither one owning path nor related column paths establish all contributors.

## Options and bounded decision

| Option                                                                        | Required design                                                                              | Limits and cost evidence                                                                                                             |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A. Persist bounded contributor evidence and consult it during sweeps          | Specify producer protocol, internal storage, migration and SQLite/in-memory evaluation       | Does not inherently require changing node identity or public payload. A contributor join has not been benchmarked.                   |
| B. Give the extractor declared prior-state input                              | Specify input identity, sandbox protocol and bounded prior evidence                          | Hidden history reads would violate reproducibility. Declaring prior state can preserve determinism.                                  |
| C. Document the current residual                                              | Record the existing limitation                                                               | Does not resolve false burial or constitute accepted risk. A fully readable recovery run has no guaranteed deadline.                 |
| D. Withhold deletion authority conservatively during unsafe partial discovery | Bound when `dataClaimFor` cannot safely attribute contributions; emit an explicit diagnostic | Delays genuine deletions too. Restricting only unread `.sql` paths misses unread directories and mixed SQL/Prisma/Drizzle ownership. |

The existing 300-path, 12.6-second selector measurement on a 3.6k-node store does not measure A. There is no established universal cost ordering between C's unjustified burial and D's delayed deletions.

Proposed first stage: design conservative claim withholding for this consumer. Where available metadata cannot prove a narrower safe boundary, use the existing claim-nothing selector for the data scope, with a diagnostic. Preserve resource `FAIL` and `UNAVAILABLE` behavior. This is a proposed design direction, not an implemented fix or authorization to change code.

If this same consumer requires precise deletion during partial runs, design A or another exact bounded method without waiting for a second consumer. The exact target is to retain a possibly contributing `shared` while deleting an unrelated, provably removed table. Conservative withholding intentionally postpones both deletions. Keep these acceptance targets separate and that item open.

## Contributor lifetime required by an exact design

Define contributors for each supported node or edge kind and producer action. Specify active or per-completed-run evidence, not an unbounded union of every path that ever touched a name. Bind normalized source paths and byte digests to run and scope authority. Declare file, contributor and storage caps and fail-closed behavior.

Specify replacement and retirement after authoritative reread, preservation during unread discovery, deleted files, rename and path reuse, same-run restart, and deleted-then-recreated canonical names. Preserve path-free non-File identity, tombstones and resurrection, byte-deterministic ordering, and SQLite/in-memory parity. Prior state must be a declared input if consumed by extraction; inferred provenance cannot become fact authority.

## Coverage and currentness boundary

`dataClaimFor` already returns `CLAIM_NOTHING` for unrepresentable or over-budget claims. This withholds authority without necessarily changing the producer status to `UNAVAILABLE`. A completed `PASS` scope is not proof of complete coverage.

Under `currentObservationOf`, scope-only availability can be true for a completed `PASS` claim. Node-specific currentness additionally requires a live node, `lastSeenRun` equal to the current run and a claim covering that node. The `CLAIM_NOTHING` claim (the data selector followed by `!**`, in `packages/extract-data/src/extractor.ts`) covers no node. Retained live facts are not thereby freshly observed. Verify the named consumers' absence-sensitive behavior; do not assume every detector automatically becomes `UNKNOWN` or infer absence from withheld authority.

## Future acceptance plan

Use real discovery, both store implementations and the production CLI. Record actual statuses, claims, full node/edge inventories and currentness before semantic assertions. A parent false-burial assertion must fail semantically; setup, import or resource failure is not that RED. No execution is claimed here.

- With readable `a.sql` and unread contributing `b.sql`, a conservative child must retain `shared` and `extra`, deliberately retain an unrelated removed `gone`, and expose withheld authority. An exact-contributor child must separately justify retaining `shared` while sweeping `gone` in the same partial run.
- Cover unread directories, symlink and oversize files, mixed owner formats, contributor retirement, rename/path reuse, restart and repeated-run byte equality. Edge variants require their own reproduction before any fix claim.
- Restore complete readable inventory with the remaining `b.sql` contribution: retained definitions must become current and genuinely absent facts may be tombstoned. Then remove all contributions under complete authority and verify burial. Reappearance must clear `deletedAt` while preserving `firstSeen` history.

These are future acceptance requirements, not implementation, performance, whole-graph or runtime proof. That item remains open pending an admitted implementation and its specific evidence or an explicit documented disposition.

## Source boundaries

The current boundaries are `dataClaimFor` and status selection in `packages/extract-data/src/extractor.ts`, defining-statement ownership in `packages/extract-data/src/model.ts`, and node coverage/currentness in `packages/core/src/store/scope-selector.ts` and `packages/core/src/store/current-observation.ts`. Existing `unread-selector.test.ts` controls demonstrate selector behavior; they do not supply complete contributor history.
