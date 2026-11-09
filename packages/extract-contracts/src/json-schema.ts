/**
 * Standalone JSON Schema document extraction.
 *
 * Detection is deliberately conservative. A repo is full of JSON that is a
 * schema *instance* rather than a schema (`package.json`, `tsconfig.json`,
 * anything with a `$schema` pointing at schemastore), and mistaking one for a
 * contract puts invented `SchemaProperty` nodes in front of the join.
 */

import { isRecord } from './json-pointer.ts';
import { walkSchemaTree, type WalkContext } from './schema-walk.ts';
import { fileStem } from './openapi.ts';
import type { LoadedDocument, DocumentLoader } from './document.ts';
import type { ContractFact, DocumentFacts, ExtractLimits, PropertyFact } from './types.ts';

/** Filenames that are configuration, never a schema, regardless of shape. */
const NEVER_A_SCHEMA: ReadonlySet<string> = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json',
  'composer.json', 'turbo.json', 'nx.json', 'renovate.json', 'lerna.json',
  'manifest.json', 'angular.json', 'deno.json', 'biome.json',
]);

export function isJsonSchemaDocument(relPosix: string, value: unknown): boolean {
  const base = relPosix.slice(relPosix.lastIndexOf('/') + 1);
  if (NEVER_A_SCHEMA.has(base)) return false;
  if (/^tsconfig\..*\.json$/.test(base)) return false;
  if (!isRecord(value)) return false;
  if (isRecord(value) && typeof value['openapi'] === 'string') return false;

  const dollarSchema = value['$schema'];
  if (typeof dollarSchema === 'string' && dollarSchema.includes('json-schema.org')) return true;

  const hasProperties = isRecord(value['properties']);
  const hasDefs = isRecord(value['$defs']) || isRecord(value['definitions']);
  if (typeof value['$id'] === 'string' && (hasProperties || hasDefs)) return true;
  return value['type'] === 'object' && hasProperties;
}

/**
 * Contract name precedence: `$id` (a URI identifier, already path-free and
 * stable across a move), then `title`, then the filename stem. The stem is the
 * one source here that moves with the file (ADR-0016 item 4).
 */
export function jsonSchemaContractName(doc: LoadedDocument): string {
  const root = isRecord(doc.value) ? doc.value : {};
  const id = root['$id'];
  if (typeof id === 'string' && id.trim() !== '') return id.trim().replace(/#$/, '');
  const title = root['title'];
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  return fileStem(doc.relPosix);
}

export function extractJsonSchema(
  loader: DocumentLoader,
  doc: LoadedDocument,
  limits: ExtractLimits,
): DocumentFacts {
  const root = isRecord(doc.value) ? doc.value : {};
  const contract = jsonSchemaContractName(doc);
  const properties: PropertyFact[] = [];
  const ctx: WalkContext = { loader, limits, contract, out: properties, emitted: new Set() };

  walkSchemaTree(ctx, doc, root, '', 0, new Set());

  const title = root['title'];
  const contractFact: ContractFact = {
    name: contract,
    dialect: 'json-schema',
    version: typeof root['$schema'] === 'string' ? root['$schema'] : null,
    title: typeof title === 'string' ? title : null,
    file: doc.relPosix,
  };
  return { contracts: [contractFact], operations: [], properties, diagnostics: [], failed: false };
}
