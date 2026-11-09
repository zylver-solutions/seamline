/**
 * Canonical-name builders — one per node kind.
 *
 * Normative reference: docs/design/v3.md §2.1. A node id is
 * `{repo}:{kind}:{canonicalName}` and the canonical name is a **path-free
 * natural key** for every kind except `File`. v2 embedded the file path in the
 * id, so a single `git mv` orphaned every edge and duplicated every symbol;
 * that is the failure this module exists to make unrepresentable.
 *
 * Every builder validates its *parts*, not the assembled string, so an illegal
 * name cannot be constructed in the first place. `File` is the one kind whose
 * natural name is the repo-relative path, and it is the only kind allowed to
 * carry a file extension next to a slash. A `git mv` therefore changes a `File`
 * id and no other, unless it changes an input that the id is built from;
 * ADR-0016 item 4 lists those inputs and none of those changes is aliased.
 * `alias.ts` and `rename.ts` carry the history of a `File` across a committed
 * rename that git reports with an `ALIAS_OF` from the retired id to the new one.
 */

import { NODE_KINDS, nodeId, type NodeId, type NodeKind } from '@seamline/ontology';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const IDENTIFIER = /^[^\u0000-\u001f\u007f./\\:#]+$/;
const SLUG = /^[A-Za-z0-9._@/+-]+$/;
const SOURCE_EXTENSION = /\.[A-Za-z0-9]{1,6}$/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const HEX_OBJECT_ID = /^[0-9a-f]{7,64}$/;

/** Kinds whose canonical name may legitimately contain `/`. */
const SLASH_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'File', 'Module', 'Symbol', 'CodeField', 'Parameter',
  'RouteHandler', 'Operation', 'SchemaProperty',
]);

function reject(label: string, value: string, why: string): never {
  throw new Error(`invalid ${label} ${JSON.stringify(value)}: ${why}`);
}

function assertNonEmptyClean(value: string, label: string): string {
  if (typeof value !== 'string') reject(label, String(value), 'must be a string');
  if (value.length === 0) reject(label, value, 'must not be empty');
  if (value.trim() !== value) reject(label, value, 'must not have leading or trailing whitespace');
  if (CONTROL_CHARS.test(value)) reject(label, value, 'must not contain control characters');
  if (value.includes('\\')) reject(label, value, 'must not contain a backslash (POSIX separators only, v3 §2.3)');
  return value;
}

/**
 * An atomic name part: a schema, table, column, symbol segment, field, etc.
 * Forbids `.`, `/` and `:` so that dotted and slashed assemblies stay
 * unambiguous and never need escaping.
 */
export function assertIdentifier(value: string, label: string): string {
  assertNonEmptyClean(value, label);
  if (!IDENTIFIER.test(value)) {
    reject(label, value, "must not contain '.', '/', ':' or a backslash");
  }
  return value;
}

/** A repo, datasource, version, or owner slug. Permits `. _ @ / + -`. */
export function assertSlug(value: string, label: string): string {
  assertNonEmptyClean(value, label);
  if (!SLUG.test(value)) reject(label, value, 'must match [A-Za-z0-9._@/+-]+');
  if (value.split('/').includes('..')) reject(label, value, "must not contain a '..' segment");
  return value;
}

/**
 * A repo-relative POSIX path. This is identity **only** for the `File` kind;
 * everywhere else a path is a property (v3 §2.1).
 */
export function assertRepoRelativePath(value: string, label = 'path'): string {
  assertNonEmptyClean(value, label);
  if (value.startsWith('/')) reject(label, value, 'must be repo-relative, not absolute');
  if (WINDOWS_DRIVE.test(value)) reject(label, value, 'must be repo-relative, not a Windows drive path');
  if (value.startsWith('./')) reject(label, value, "must not start with './'");
  if (value.endsWith('/')) reject(label, value, 'must not end with a separator');
  if (value.includes('//')) reject(label, value, 'must not contain an empty segment');
  if (value.split('/').includes('..')) reject(label, value, "must not contain a '..' segment");
  return value;
}

/**
 * A module specifier — a package name or subpath export, resolved through
 * re-exports and barrels to the declaration site (v3 §2.1).
 * A file path is rejected here: that is the whole point of the kind.
 */
export function assertModuleSpecifier(value: string, label = 'module'): string {
  assertNonEmptyClean(value, label);
  if (value.startsWith('/') || WINDOWS_DRIVE.test(value)) reject(label, value, 'must not be an absolute path');
  if (value.startsWith('./') || value.startsWith('../')) reject(label, value, 'must not be a relative path specifier');
  if (value.endsWith('/')) reject(label, value, 'must not end with a separator');
  if (value.includes('//')) reject(label, value, 'must not contain an empty segment');
  if (value.split('/').includes('..')) reject(label, value, "must not contain a '..' segment");
  const last = value.split('/').at(-1) ?? '';
  if (SOURCE_EXTENSION.test(last)) {
    reject(label, value, 'must not carry a file extension — a module specifier is not a file path (v3 §2.1)');
  }
  return value;
}

/** An RFC 6901 JSON pointer: the empty string, or `/`-prefixed segments. */
export function assertJsonPointer(value: string, label = 'jsonPointer'): string {
  if (typeof value !== 'string') reject(label, String(value), 'must be a string');
  if (CONTROL_CHARS.test(value)) reject(label, value, 'must not contain control characters');
  if (value.includes('\\')) reject(label, value, 'must not contain a backslash');
  if (value.trim() !== value) reject(label, value, 'must not have leading or trailing whitespace');
  if (value.length > 0 && !value.startsWith('/')) reject(label, value, "must be empty or start with '/' (RFC 6901)");
  return value;
}

/**
 * Last-line check on an already-assembled canonical name. The builders below
 * make this redundant; it exists for the hand-built path (`makeNodeId`).
 */
export function assertCanonicalName(kind: NodeKind, name: string): string {
  const label = `${kind} canonicalName`;
  assertNonEmptyClean(name, label);
  if (name.startsWith('/') || WINDOWS_DRIVE.test(name)) reject(label, name, 'must not be an absolute path');
  if (name.split('/').includes('..')) reject(label, name, "must not contain a '..' segment");
  if (kind === 'File') return assertRepoRelativePath(name, label);
  if (kind === 'Alias') {
    // An Alias names a *retired* canonical name, so it inherits the rules of
    // the kind it retires — including a File's path, which is that kind's key.
    const split = name.indexOf('::');
    const retired = split < 0 ? undefined : name.slice(0, split);
    if (retired !== undefined && (NODE_KINDS as ReadonlyArray<string>).includes(retired)) {
      assertCanonicalName(retired as NodeKind, name.slice(split + 2));
      return name;
    }
    reject(label, name, 'must be `{RetiredKind}::{retiredCanonicalName}`');
  }
  if (!SLASH_KINDS.has(kind) && name.includes('/')) {
    reject(label, name, `must not contain '/': a ${kind} id is path-free (v3 §2.1)`);
  }
  // A bare slashed name ending in an extension is exactly the v2 bug: a file
  // path used as identity. A name carrying a structural separator ('::', '#',
  // or a space) is an assembled key, not a path, so the check does not apply.
  const looksBare = !name.includes('::') && !name.includes('#') && !name.includes(' ');
  if (looksBare && name.includes('/')) {
    const last = name.split('/').at(-1) ?? '';
    if (SOURCE_EXTENSION.test(last)) {
      reject(label, name, 'looks like a file path; only File may be identified by its path (v3 §2.1)');
    }
  }
  return name;
}

/** `nodeId` with the per-kind canonical-name rules enforced. */
export function makeNodeId(repo: string, kind: NodeKind, canonicalName: string): NodeId {
  assertSlug(repo, 'repo');
  return nodeId(repo, kind, assertCanonicalName(kind, canonicalName));
}

// ---------------------------------------------------------------------------
// Builders, grouped as in v3 §4.
// ---------------------------------------------------------------------------

export function repoName(repo: string): string {
  return assertSlug(repo, 'repo');
}

/** The one kind where the repo-relative path *is* the natural name (v3 §2.1). */
export function fileName(path: string): string {
  return assertRepoRelativePath(path);
}

export function moduleName(specifier: string): string {
  return assertModuleSpecifier(specifier);
}

// ---------------------------------------------------------------------------
// Code names. The scheme is the one `extract-code-ts` stores, and it is
// defined only here: `extract-code-ts` assembles its names with the three
// `*CanonicalName` functions below, and the validating builders after them
// check their parts and then delegate to the same functions.
//
//   @acme/api#UserService.findById       symbol: {module}#{declaration chain}
//   @acme/api#User.email                 code field: {owner}.{field}
//   @acme/api#UserService.findById(0)id  parameter: {owner}({index}){name}
// ---------------------------------------------------------------------------

/** Module name of a declaration that no `package.json` governs. */
export const ROOT_MODULE = '<root>';

/** `{module}#{chain}`. Assembly only; `symbolName` validates the parts. */
export function symbolCanonicalName(module: string, chain: ReadonlyArray<string>): string {
  if (chain.length === 0) throw new Error('symbol declaration chain must not be empty');
  return `${module}#${chain.join('.')}`;
}

/** `{owner}.{field}`: the kind keeps a field distinct from a nested symbol of the same chain. */
export function codeFieldCanonicalName(ownerCanonicalName: string, fieldName: string): string {
  return `${ownerCanonicalName}.${fieldName}`;
}

/**
 * `{owner}({index}){name}`: the index is part of the name because a parameter
 * can be renamed without changing a call.
 */
export function parameterCanonicalName(ownerCanonicalName: string, index: number, name: string): string {
  return `${ownerCanonicalName}(${index})${name}`;
}

export interface SymbolNameParts {
  /**
   * Module specifier of the declaration site: the nearest `package.json` name.
   * Omitted means no `package.json` governs the declaration (`ROOT_MODULE`).
   */
  readonly module?: string;
  /** Declaration chain, outermost first: `['UserService', 'findById']`. */
  readonly qualifiedName: ReadonlyArray<string>;
}

/** symbol = resolved canonical qualified name (v3 §2.1). Never a file path. */
export function symbolName(parts: SymbolNameParts): string {
  if (parts.qualifiedName.length === 0) {
    throw new Error('invalid symbol qualifiedName []: must have at least one part');
  }
  const chain = parts.qualifiedName.map((p, i) => assertIdentifier(p, `qualifiedName[${i}]`));
  return symbolCanonicalName(assertModuleSpecifier(parts.module ?? ROOT_MODULE), chain);
}

export function codeFieldName(parts: { readonly symbol: string; readonly field: string }): string {
  return codeFieldCanonicalName(
    assertCanonicalName('Symbol', parts.symbol),
    assertIdentifier(parts.field, 'field'),
  );
}

export function parameterName(parts: {
  readonly symbol: string;
  readonly index: number;
  readonly parameter: string;
}): string {
  if (!Number.isSafeInteger(parts.index) || parts.index < 0) {
    reject('parameter index', String(parts.index), 'must be a non-negative integer');
  }
  return parameterCanonicalName(
    assertCanonicalName('Symbol', parts.symbol),
    parts.index,
    assertIdentifier(parts.parameter, 'parameter'),
  );
}

export function routeHandlerName(parts: { readonly method: string; readonly route: string }): string {
  const method = assertIdentifier(parts.method, 'method').toUpperCase();
  const route = assertNonEmptyClean(parts.route, 'route');
  if (!route.startsWith('/')) reject('route', route, "must start with '/'");
  return `${method} ${route}`;
}

export function dataSourceName(name: string): string {
  return assertSlug(name, 'dataSource');
}

export interface DataLocation {
  readonly dataSource?: string;
  readonly schema: string;
  readonly table?: string;
  readonly column?: string;
}

function dataParts(loc: DataLocation): string[] {
  const out: string[] = [];
  if (loc.dataSource !== undefined) out.push(assertIdentifier(loc.dataSource, 'dataSource'));
  out.push(assertIdentifier(loc.schema, 'schema'));
  if (loc.table !== undefined) out.push(assertIdentifier(loc.table, 'table'));
  if (loc.column !== undefined) out.push(assertIdentifier(loc.column, 'column'));
  return out;
}

export function schemaName(loc: Pick<DataLocation, 'dataSource' | 'schema'>): string {
  return dataParts(loc).join('.');
}

export function tableName(
  loc: Pick<DataLocation, 'dataSource' | 'schema'> & { readonly table: string },
): string {
  return dataParts(loc).join('.');
}

/**
 * column = `{schema}.{table}.{column}`, or `{dataSource}.{schema}.{table}.{column}`
 * when a datasource qualifier is supplied (v3 §2.1). No part may contain `.`,
 * so the arity is unambiguous.
 */
export function columnName(
  loc: Pick<DataLocation, 'dataSource' | 'schema'> & { readonly table: string; readonly column: string },
): string {
  return dataParts(loc).join('.');
}

/**
 * Separates a Migration version from its collision qualifier, as in
 * `0001_init~packages~api~migrations`. It is outside the version alphabet
 * (`MIGRATION_PART`), so the first one in a Migration name always ends the
 * version, and a qualified name can never equal an unqualified one. It is also
 * not `/`, so a qualified Migration name stays path-free (v3 section 2.1) and
 * `makeNodeId` accepts it.
 */
export const MIGRATION_QUALIFIER_SEPARATOR = '~';

/** One version or qualifier part of a Migration name: no `/`, no separator. */
const MIGRATION_PART = /^[A-Za-z0-9._@+-]+$/;

/**
 * Maps any string onto the Migration part alphabet, replacing each character
 * outside it with `_`. Lossy by design: two inputs can map to the same part,
 * which is why a caller that needs unique names (the data extractor) checks for
 * collisions after sanitizing.
 */
export function migrationNamePart(raw: string): string {
  const part = raw.replace(/[^A-Za-z0-9._@+-]/gu, '_');
  return part === '' || part === '.' || part === '..' ? '_' : part;
}

function assertMigrationPart(value: string, label: string): string {
  assertNonEmptyClean(value, label);
  if (!MIGRATION_PART.test(value) || value === '.' || value === '..') {
    reject(label, value, `must match [A-Za-z0-9._@+-]+ (no '/', no '${MIGRATION_QUALIFIER_SEPARATOR}')`);
  }
  return value;
}

/**
 * A Migration canonical name: the version, optionally followed by qualifier
 * parts that tell apart migrations sharing a version. Every part is validated,
 * and the result passes `makeNodeId('...', 'Migration', name)`.
 */
export function migrationName(version: string, qualifier: ReadonlyArray<string> = []): string {
  const parts = [assertMigrationPart(version, 'migration version')];
  for (const q of qualifier) parts.push(assertMigrationPart(q, 'migration qualifier'));
  return parts.join(MIGRATION_QUALIFIER_SEPARATOR);
}

export function contractName(id: string): string {
  const value = assertNonEmptyClean(id, 'contract');
  if (value.includes('/')) reject('contract', value, "must not contain '/': a Contract id is path-free (v3 §2.1)");
  if (value.includes('#')) reject('contract', value, "must not contain '#'");
  return value;
}

export function operationName(parts: { readonly contract: string; readonly operation: string }): string {
  const op = assertNonEmptyClean(parts.operation, 'operation');
  return `${contractName(parts.contract)}#${op}`;
}

/** schema property = `{contract}#{jsonPointer}` (v3 §2.1). */
export function schemaPropertyName(parts: { readonly contract: string; readonly jsonPointer: string }): string {
  return `${contractName(parts.contract)}#${assertJsonPointer(parts.jsonPointer)}`;
}

export function entityName(name: string): string {
  return assertIdentifier(name, 'entity');
}

export function domainPropertyName(parts: { readonly entity: string; readonly property: string }): string {
  return `${entityName(parts.entity)}.${assertIdentifier(parts.property, 'property')}`;
}

export function testCaseName(parts: { readonly suite?: ReadonlyArray<string>; readonly name: string }): string {
  const suite = (parts.suite ?? []).map((s, i) => assertNonEmptyClean(s, `suite[${i}]`));
  return [...suite, assertNonEmptyClean(parts.name, 'name')].join(' > ');
}

export function testRunName(id: string): string {
  return assertSlug(id, 'testRun');
}

export function coverageRecordName(parts: { readonly target: string; readonly tool: string }): string {
  return `${assertIdentifier(parts.tool, 'tool')}#${assertNonEmptyClean(parts.target, 'target')}`;
}

export function commitName(sha: string): string {
  const value = assertIdentifier(sha, 'commit');
  if (!HEX_OBJECT_ID.test(value)) reject('commit', value, 'must be a lowercase hex object id');
  return value;
}

export function changesetName(id: string): string {
  return assertSlug(id, 'changeset');
}

export function ownerName(handle: string): string {
  return assertSlug(handle, 'owner');
}

export function runName(runId: string): string {
  return assertSlug(runId, 'runId');
}

export function extractorName(parts: { readonly name: string; readonly version: string }): string {
  return `${assertIdentifier(parts.name, 'extractor')}@${assertSlug(parts.version, 'version')}`;
}

export function contradictionName(parts: {
  readonly code: string;
  readonly left: string;
  readonly right: string;
}): string {
  const code = assertIdentifier(parts.code, 'code');
  const left = assertNonEmptyClean(parts.left, 'left');
  const right = assertNonEmptyClean(parts.right, 'right');
  return `${code}#${left}|${right}`;
}

/**
 * An `Alias` node names a *retired* canonical name. The kind is part of the
 * name because two kinds may retire the same string.
 */
export function aliasName(parts: { readonly kind: NodeKind; readonly name: string }): string {
  return `${parts.kind}::${assertCanonicalName(parts.kind, parts.name)}`;
}

export function lensName(name: string): string {
  return assertIdentifier(name, 'lens');
}

export function threatModelName(name: string): string {
  return assertIdentifier(name, 'threatModel');
}
