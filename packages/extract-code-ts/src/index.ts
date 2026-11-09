/**
 * `@seamline/extract-code-ts` — TypeScript/JavaScript facts at provenance
 * `EXTRACTED`.
 *
 * Reads a TypeScript project through `ts-morph`'s type checker and emits
 * `Repo`, `File`, `Module`, `Symbol`, `CodeField`, `Parameter`, and
 * `RouteHandler` nodes with the containment, import/export, call, heritage,
 * type-use, decorator, route, and query edges between them.
 *
 * Two properties are load-bearing and both are tested here:
 * identity is path-free for every kind except `File`, so a `git mv` within a
 * package changes no symbol, field or parameter id (a moved `File` gets a new
 * id, and `seamline extract` aliases the retired id to it when git reports the
 * committed rename; a move to a different package changes the package part of
 * the ids and is not aliased); and output is byte-identical across runs, so
 * golden files and `seamline diff` mean something.
 */

export { extractCodeTs, defaultTableId } from './extract.ts';
export type { ExtractCodeTsOptions, ExtractCodeTsOutput, MemoryBudget } from './extract.ts';
export {
  CODE_TS_AUTHORITATIVE, CODE_TS_SCOPE, EXTRACTOR_NAME, EXTRACTOR_VERSION, PRODUCED_KINDS, manifest,
} from './manifest.ts';
export { canonicalJson, canonicalize, toCanonicalSif, toSifLines } from './serialize.ts';
export {
  assertPathFree, codeFieldCanonicalName, fileId, moduleId, parameterCanonicalName,
  repoId, routeCanonicalName, symbolCanonicalName, ROOT_MODULE,
} from './canonical.ts';
export { normalizeTypeText, splitTopLevelUnion, stripImportQualifiers } from './typetext.ts';
export type { NormalizedType, NormalizedTypeInfo } from './typetext.ts';
export { looksLikeSql, sqlTableOccurrences, sqlTableRefs } from './sql.ts';
export type { SqlOperation, SqlTableOccurrence, SqlTableRef } from './sql.ts';
export { parseDataModelIndex, SUPPORTED_INDEX_VERSION, tableBinder } from './data-model.ts';
export type {
  DataModelIndex, IndexedDataSource, IndexedTable, ParsedDataModelIndex, TableBinding,
} from './data-model.ts';
export { joinRoute, normalizeRoutePath } from './routes.ts';
export { VALIDATION_LIBRARIES } from './validation.ts';
export { isRepoRelativePosix, toRepoRelative } from './paths.ts';
