/**
 * `@seamline/extract-data` — public surface.
 *
 * Database schema facts (`DataSource`, `Schema`, `Table`, `Column`,
 * `Migration`) extracted from static files only: SQL DDL, Drizzle schema
 * modules, `schema.prisma`, and ordered migration directories. Design v3 §6.
 */

export {
  DATA_SCOPE,
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  MANIFEST,
  extractData,
  type ExtractDataOptions,
  type ExtractDataOutput,
} from './extractor.ts';

export { canonicalJson, canonicalSif } from './emit.ts';
export { buildDataModelIndex, DATA_MODEL_INDEX_VERSION, prismaDelegateName } from './data-model-index.ts';
export { normalizeSqlType, TYPE_CATEGORIES, type NormalizedType, type TypeCategory } from './normalize-type.ts';
export { classifyPii, PII_CATEGORIES, type PiiCategory, type PiiVerdict } from './pii.ts';
export { discover, discoverSources, migrationIdentity, type DiscoveredFile, type Discovery } from './discover.ts';
