/**
 * `@seamline/extract-contracts` — API-contract facts.
 *
 * OpenAPI 3.x (YAML and JSON), standalone JSON Schema, and Zod schemas in
 * TypeScript source, emitted as `Contract`, `Operation`, `SchemaProperty`,
 * and `RouteHandler` nodes at provenance `EXTRACTED`.
 */

export { extractContracts, claimSelector, type ContractsExtraction } from './extract.ts';
export {
  MANIFEST, CONTRACTS_SCOPE, EXTRACTOR_NAME, EXTRACTOR_VERSION,
} from './manifest.ts';
export {
  TYPE_CATEGORIES, AUTH_MODES, AUTH_SOURCES, CONTRACT_DIALECTS, DEFAULT_LIMITS,
  type TypeCategory, type AuthMode, type AuthSource, type ContractDialect,
  type DeclaredAuth, type ExtractLimits, type ExtractOptions,
  type ContractFact, type OperationFact, type PropertyFact,
} from './types.ts';
export {
  categorizeJsonType, unifyCategories, readTypeField,
} from './normalize-type.ts';
export { resolveAuth, readHandler, isOpenApiDocument, openApiPathToRouteParams } from './openapi.ts';
export { isJsonSchemaDocument } from './json-schema.ts';
export { mentionsZod } from './zod.ts';
export {
  contractCanonicalName, operationCanonicalName, schemaPropertyCanonicalName, routeHandlerCanonicalName,
  InvalidEdgeError,
} from './emit.ts';
export {
  isRemoteReference, toRepoRelativePosix,
  REFUSAL_REMOTE, REFUSAL_ESCAPE, REFUSAL_TOO_LARGE,
} from './safe-fs.ts';
