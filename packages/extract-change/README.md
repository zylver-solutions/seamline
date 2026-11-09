# @seamline/extract-change
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

Git history facts at provenance `EXTRACTED`: commits, `TOUCHES` edges, and rename detection via `git log --find-renames` (a `git` subprocess; there is no git library dependency), feeding the redaction/PII lineage checks in design v3 §2.1.

Most users should not import this directly — `seamline extract` in `@seamline/cli` runs it as part of the normal pipeline. Import it directly only if you are building a tool that needs to run this extractor standalone.

It exports:

- `extractChange` — the extractor entry point.
- `readRenames`, `renameLedgerFrom` — rename detection and the rename ledger.
- `CHANGE_MANIFEST`, `EXTRACTOR_NAME`, `EXTRACTOR_VERSION`, `changeManifest` — the extractor manifest.
- `epochToIsoUtc` — deterministic timestamp formatting.
- `CHANGE_SCOPE`, `CHANGE_STATUSES`, `DEFAULT_DEPTH`, `DEFAULT_RENAME_THRESHOLD`, and the `ChangeExtraction`, `ChangeExtractorOptions`, `ChangeStatus`, `CommitRecord`, `FileChange`, `RangeDescriptor`, `RenameLedger`, `RenameRecord`, `SymbolResolver` types.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0.
