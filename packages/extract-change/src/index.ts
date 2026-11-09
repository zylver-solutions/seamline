export { extractChange } from './extract.ts';
export { readRenames, renameLedgerFrom } from './renames.ts';
export { CHANGE_MANIFEST, EXTRACTOR_NAME, EXTRACTOR_VERSION, changeManifest } from './manifest.ts';
export { epochToIsoUtc } from './history.ts';
// Exposed so a test in `@seamline/cli` can assert it matches `@seamline/core`'s list; not an extension point.
export { UNTRUSTED_GIT_CONFIG, untrustedGitInternals } from './git.ts';
export type {
  ChangeExtraction,
  ChangeExtractorOptions,
  ChangeStatus,
  CommitRecord,
  FileChange,
  RangeDescriptor,
  RenameLedger,
  RenameRecord,
  SymbolResolver,
} from './types.ts';
export { CHANGE_SCOPE, CHANGE_STATUSES, DEFAULT_DEPTH, DEFAULT_RENAME_THRESHOLD } from './types.ts';
