/**
 * The API-contract facts extractor.
 *
 * Reads OpenAPI 3.x (YAML and JSON), standalone JSON Schema documents, and
 * Zod schemas in TypeScript source, and emits `Contract`, `Operation`,
 * `SchemaProperty`, and `RouteHandler` nodes at provenance `EXTRACTED`.
 */

import { relative, resolve, sep } from 'node:path';

import {
  assertWithinCeiling,
  type AuthoritativeScope,
  type ExtractorResult,
  type SeamlineEdge,
  type SeamlineNode,
} from '@seamline/ontology';
import { DOCUMENT_EXTENSIONS, DocumentLoader, parseDocument } from './document.ts';
import {
  contractNode,
  makeEdge,
  operationNode,
  routeHandlerNode,
  schemaPropertyNode,
  sortEdges,
  sortNodes,
} from './emit.ts';
import { extractJsonSchema, isJsonSchemaDocument, jsonSchemaContractName } from './json-schema.ts';
import { CONTRACTS_SCOPE, EXTRACTOR_NAME, EXTRACTOR_VERSION, MANIFEST } from './manifest.ts';
import { extractOpenApi, isOpenApiDocument, openApiContractName, openApiPathToRouteParams } from './openapi.ts';
import { readCapped, resolveInsideRoot, walkRepo } from './safe-fs.ts';
import {
  DEFAULT_LIMITS,
  type ContractFact,
  type ExtractLimits,
  type ExtractOptions,
  type OperationFact,
  type PropertyFact,
} from './types.ts';
import { extractZod, mentionsZod } from './zod.ts';
import { extractValidatedWrites } from './write-extract.ts';
import { canonicalContractAuthority, type ContractNameSource } from './contract-authority.ts';
import type { WriteInventory } from './write-source.ts';

export interface ContractsExtraction {
  readonly result: ExtractorResult;
  readonly nodes: readonly SeamlineNode[];
  readonly edges: readonly SeamlineEdge[];
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'] as const;

function hasExtension(rel: string, extensions: readonly string[]): boolean {
  const lower = rel.toLowerCase();
  return extensions.some((e) => lower.endsWith(e));
}

/**
 * Names strong enough that a parse failure is a real failure rather than a
 * file that simply was not a contract. Used only in discovery mode; when the
 * caller names files explicitly, every one of them is expected to parse.
 */
function looksLikeContractByName(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
  return (
    /^(openapi|swagger)\b/.test(base) ||
    /\.(openapi|swagger)\.(ya?ml|json)$/.test(base) ||
    /\.schema\.json$/.test(base)
  );
}

interface Accumulator {
  contracts: ContractFact[];
  readonly operations: OperationFact[];
  properties: PropertyFact[];
  readonly diagnostics: string[];
  /**
   * Files the run read but cannot vouch for: they may declare contracts it
   * could not lower to a complete property set, or could not read at all. They
   * are left out of the authoritative claim (`claimSelector`), so a contract an
   * earlier run read from one of them is neither emitted nor buried.
   */
  readonly unvouched: Set<string>;
  /** Zod declarations whose shape could not be read; they still hold their name. */
  readonly withheld: Array<{ readonly name: string; readonly file: string }>;
  /**
   * Files that gave the run something certain to report: a document it read to
   * the end, or a TypeScript file with at least one readable contract. A file
   * whose only contracts were withheld for a name collision is not one.
   */
  readonly sourceFiles: Set<string>;
  failures: number;
  unavailableTypeScript: boolean;
}

export function extractContracts(options: ExtractOptions): ContractsExtraction {
  const startedAt = Date.now();
  // A ceiling violation is a runtime error, not a code-review question (v3 2.4).
  assertWithinCeiling(MANIFEST, 'EXTRACTED');

  const limits: ExtractLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const loader = new DocumentLoader(options.repoRoot, limits);
  const acc: Accumulator = {
    contracts: [],
    operations: [],
    properties: [],
    diagnostics: [],
    unvouched: new Set(),
    withheld: [],
    sourceFiles: new Set(),
    failures: 0,
    unavailableTypeScript: false,
  };

  const explicit = options.files !== undefined;
  const supplied = explicit
    ? [...(options.files as readonly string[])].sort()
    : walkRepo(options.repoRoot, limits.maxFiles + 1);
  const discoveryCapped = !explicit && supplied.length > limits.maxFiles;
  if (supplied.length > limits.maxFiles) {
    acc.failures += 1;
    acc.diagnostics.push('CONTRACTS_FILE_CAP: the source-file budget was exceeded; the incomplete run cannot authorize deletion');
  }
  // Resolution and claim construction must use the same spelling. Otherwise
  // an unread ./src/file.ts can leave src/** falsely authoritative.
  const candidates = [
    ...new Set(
      supplied.slice(0, limits.maxFiles).map((rel) => {
        const resolution = resolveInsideRoot(options.repoRoot, options.repoRoot, rel);
        // Keep the logical owner and extension: a .ts symlink may point at a
        // .source file, which still needs the TypeScript reader and protection.
        return resolution.ok
          ? relative(resolve(options.repoRoot), resolve(options.repoRoot, rel)).split(sep).join('/')
          : rel;
      }),
    ),
  ].sort();

  for (const rel of candidates) {
    const resolution = resolveInsideRoot(options.repoRoot, options.repoRoot, rel);
    if (!resolution.ok) {
      acc.diagnostics.push(`${resolution.refusal}: ${rel}`);
      if (explicit) acc.failures += 1;
      acc.unvouched.add(rel);
      continue;
    }
    const strict = explicit || looksLikeContractByName(rel);
    if (hasExtension(rel, DOCUMENT_EXTENSIONS)) {
      processStructuredDocument(loader, resolution.absolute, rel, limits, acc, strict);
    } else if (hasExtension(rel, TS_EXTENSIONS) && !rel.toLowerCase().endsWith('.d.ts')) {
      processTypeScript(loader, resolution.absolute, rel, limits, acc, strict);
    }
  }

  acc.diagnostics.push(...loader.diagnostics);

  const writes = extractValidatedWrites(options, limits, candidates);
  acc.contracts.push(...writes.contracts);
  acc.properties.push(...writes.properties);
  acc.diagnostics.push(...writes.diagnostics);
  acc.withheld.push(...writes.withheld);
  for (const file of writes.unvouched) acc.unvouched.add(file);
  for (const file of writes.handlerFiles) acc.unvouched.add(file);
  for (const file of writes.sourceFiles) acc.sourceFiles.add(file);
  acc.unavailableTypeScript ||= writes.typeScriptUnavailable;

  const declaredNames = [...acc.contracts, ...acc.withheld].map(({ name, file }) => ({ name, file }));
  withholdNameCollisions(acc);
  const names = structuredContractNames(options.repoRoot, limits, writes.sourceInventory, candidates);
  for (const file of names.unread) acc.unvouched.add(file);
  // A names-only census never reads a skipped source's complete property set.
  // Even an unrelated clean directory cannot authorize its deletion.
  const selectedSources = new Set(candidates);
  for (const source of names.declared) if (!selectedSources.has(source.file)) acc.unvouched.add(source.file);
  let canonicalClaims: readonly AuthoritativeScope[] = [];
  let authorityRefused = false;
  try {
    const coverage = canonicalContractAuthority(writes.authorityCandidates, [...declaredNames, ...names.declared], names.complete,
      [...writes.authorityCandidates, ...writes.withheld]);
    canonicalClaims = coverage.claims;
    if (coverage.withheld.size > 0) {
      for (const contract of [...declaredNames, ...names.declared]) if (coverage.withheld.has(contract.name)) {
        acc.unvouched.add(contract.file);
        acc.withheld.push({ name: contract.name, file: contract.file });
      }
      acc.contracts = acc.contracts.filter(contract => !coverage.withheld.has(contract.name));
      acc.properties = acc.properties.filter(property => !coverage.withheld.has(property.contract));
      acc.diagnostics.push(names.complete ? 'CONTRACT_CANONICAL_FAMILY_COLLISION: overlapping or duplicate contract families are withheld' :
        'CONTRACT_NAME_INVENTORY_UNAVAILABLE: incomplete structured names cannot certify write identities');
      const contributing = new Set([...acc.contracts, ...acc.operations].map(fact => fact.file));
      for (const file of acc.sourceFiles) if (!contributing.has(file)) acc.sourceFiles.delete(file);
    }
  } catch {
    authorityRefused = true;
    acc.failures += 1;
    acc.diagnostics.push('CONTRACT_AUTHORITY_UNAVAILABLE: canonical coverage failed validation or exceeded its budget');
  }
  if (acc.unvouched.size > 0)
    acc.diagnostics.push(
      `CONTRACTS_PARTIAL_COVERAGE: ${acc.unvouched.size} file(s) are outside the authoritative claim; ` +
        'filename-wide deletion authority is withheld for those files',
    );

  const built = buildGraph(options, acc);
  // A failed structured-document read can hide operations, unlike unsupported Zod.
  // Carry only the measured count so absence-based consumers can refuse a conclusion.
  const unreadStructuredDocuments = [...acc.unvouched].filter((rel) =>
    hasExtension(rel, DOCUMENT_EXTENSIONS),
  ).length;
  const nodes = built.nodes.map((node) =>
    node.kind === 'Contract' || node.kind === 'Operation'
      ? {
          ...node,
          props: Object.fromEntries(
            Object.entries({ ...node.props, unreadStructuredDocuments }).sort(([a], [b]) =>
              cmp(a, b),
            ),
          ),
        }
      : node,
  );

  const status =
    acc.failures > 0
      ? 'FAIL'
      : acc.sourceFiles.size === 0
        ? 'UNAVAILABLE'
        : acc.unavailableTypeScript
          ? 'FAIL'
          : 'PASS';
  const deterministic = process.env['SEAMLINE_DETERMINISTIC'] === '1';

  return {
    result: {
      extractor: EXTRACTOR_NAME,
      version: EXTRACTOR_VERSION,
      status,
      authoritative: authorityRefused
        ? [{ scope: CONTRACTS_SCOPE, kinds: MANIFEST.produces[0]?.kinds ?? [] }]
        : [claimOf(candidates, acc.unvouched, explicit || discoveryCapped || writes.explicitAuthorityOnly), ...canonicalClaims],
      nodeCount: built.nodes.length,
      edgeCount: built.edges.length,
      durationMs: deterministic ? 0 : Date.now() - startedAt,
      diagnostics: [...new Set(acc.diagnostics)].sort(),
    },
    nodes,
    edges: built.edges,
  };
}

/** Root document names can be arbitrary strings, including a write key or a
 * nested property-family name. Scan unselected documents as well; a failed
 * read cannot prove their names disjoint. Referenced fields do not mint roots.
 */
function structuredContractNames(repoRoot: string, limits: ExtractLimits, inventory: WriteInventory, selected: readonly string[]): {
  readonly declared: readonly ContractNameSource[]; readonly complete: boolean; readonly unread: readonly string[];
} {
  // Discovery skips generated directories. Names may still have been selected
  // explicitly there, so collision proof uses the broader bounded inventory.
  const paths = [...new Set([...inventory.files, ...selected])].sort();
  let complete = inventory.complete && paths.length <= limits.maxFiles;
  const declared: ContractNameSource[] = [];
  const unread: string[] = [];
  for (const rel of paths.slice(0, limits.maxFiles)) {
    if (!hasExtension(rel, DOCUMENT_EXTENSIONS)) continue;
    const resolution = resolveInsideRoot(repoRoot, repoRoot, rel);
    const read = resolution.ok ? readCapped(resolution.absolute, limits.maxFileBytes) : undefined;
    if (read === undefined || !read.ok) { complete = false; unread.push(rel); continue; }
    const parsed = parseDocument(rel, read.text);
    if (!parsed.ok) { complete = false; unread.push(rel); continue; }
    const doc = { absolute: resolution.ok ? resolution.absolute : rel, relPosix: rel, value: parsed.value };
    if (isOpenApiDocument(parsed.value)) declared.push({ name: openApiContractName(doc), file: rel });
    else if (isJsonSchemaDocument(rel, parsed.value)) declared.push({ name: jsonSchemaContractName(doc), file: rel });
  }
  return { declared, complete, unread };
}

function processStructuredDocument(
  loader: DocumentLoader,
  absolute: string,
  rel: string,
  limits: ExtractLimits,
  acc: Accumulator,
  strict: boolean,
): void {
  const read = readCapped(absolute, limits.maxFileBytes);
  if (!read.ok) {
    if (strict) {
      acc.diagnostics.push(`${read.refusal}: ${rel} (${read.detail})`);
      acc.failures += 1;
    }
    // Unread is not absent: whatever this file declares stays out of the claim.
    acc.unvouched.add(rel);
    return;
  }
  const parsed = parseDocument(rel, read.text);
  if (!parsed.ok) {
    if (strict) {
      acc.diagnostics.push(`PARSE_ERROR: ${rel}: ${parsed.error}`);
      acc.failures += 1;
    }
    // A truncated document can lose every token that would identify it as a contract.
    // Failed parsing cannot prove absence, even for a config file with comments.
    acc.unvouched.add(rel);
    return;
  }
  const doc = { absolute, relPosix: rel, value: parsed.value };
  loader.primeCache(doc);

  if (isOpenApiDocument(parsed.value)) {
    merge(acc, extractOpenApi(loader, doc, limits));
    acc.sourceFiles.add(rel);
  } else if (isJsonSchemaDocument(rel, parsed.value)) {
    merge(acc, extractJsonSchema(loader, doc, limits));
    acc.sourceFiles.add(rel);
  } else if (strict) {
    acc.diagnostics.push(`NOT_A_CONTRACT: ${rel}`);
    acc.failures += 1;
  }
}

function processTypeScript(
  loader: DocumentLoader,
  absolute: string,
  rel: string,
  limits: ExtractLimits,
  acc: Accumulator,
  strict: boolean,
): void {
  const read = readCapped(absolute, limits.maxFileBytes);
  if (!read.ok) {
    if (strict) {
      acc.diagnostics.push(`${read.refusal}: ${rel} (${read.detail})`);
      acc.failures += 1;
    }
    acc.unvouched.add(rel);
    return;
  }
  if (!mentionsZod(read.text)) return;
  const facts = extractZod(loader, rel, read.text, limits);
  // Diagnostics (e.g. TYPESCRIPT_UNAVAILABLE) are surfaced even when this
  // document contributed no contracts -- extractContracts's own
  // `[...new Set(diagnostics)]` collapses the same message across every file
  // that hits it into one line, so this does not get noisy on a large repo.
  acc.diagnostics.push(...facts.diagnostics);
  if (facts.diagnostics.some((message) => message.startsWith('TYPESCRIPT_UNAVAILABLE:')))
    acc.unavailableTypeScript = true;
  if (facts.failed) acc.failures += 1;
  // A shape-level gap withholds that one contract and unvouches the file; it
  // does not fail the scope. Everything else the file declares is still emitted.
  if (facts.unvouched === true) acc.unvouched.add(rel);
  for (const name of facts.withheld ?? []) acc.withheld.push({ name, file: rel });
  if (facts.contracts.length === 0) return;
  acc.contracts.push(...facts.contracts);
  acc.operations.push(...facts.operations);
  acc.properties.push(...facts.properties);
  acc.sourceFiles.add(rel);
}

function merge(
  acc: Accumulator,
  facts: {
    contracts: readonly ContractFact[];
    operations: readonly OperationFact[];
    properties: readonly PropertyFact[];
    diagnostics: readonly string[];
  },
): void {
  acc.contracts.push(...facts.contracts);
  acc.operations.push(...facts.operations);
  acc.properties.push(...facts.properties);
  acc.diagnostics.push(...facts.diagnostics);
}

function buildGraph(
  options: ExtractOptions,
  acc: Accumulator,
): { nodes: SeamlineNode[]; edges: SeamlineEdge[] } {
  const args = { repo: options.repo, runId: options.runId };
  const byId = new Map<string, SeamlineNode>();
  const edges: SeamlineEdge[] = [];
  const edgeKeys = new Set<string>();

  // First-wins over a deterministic ordering, so a name collision between two
  // documents resolves the same way on every run instead of by traversal luck.
  const put = (node: SeamlineNode): SeamlineNode => {
    const existing = byId.get(node.id);
    if (existing !== undefined) return existing;
    byId.set(node.id, node);
    return node;
  };
  const link = (
    kind: 'CONTAINS' | 'IMPLEMENTED_BY',
    src: SeamlineNode,
    dst: SeamlineNode,
  ): void => {
    const edge = makeEdge(args, kind, src, dst);
    const key = `${edge.kind} ${edge.src} ${edge.dst}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  // Names are unique by now (`withholdNameCollisions`), so a contract is found
  // by its name alone and no two declarations can share a node.
  const contractsByName = new Map<string, SeamlineNode>();
  for (const fact of [...acc.contracts].sort(byContractOrder)) {
    contractsByName.set(fact.name, put(contractNode(args, fact)));
  }

  for (const fact of [...acc.operations].sort(byOperationOrder)) {
    const op = put(operationNode(args, fact));
    const contract = contractsByName.get(fact.contract);
    if (contract !== undefined) link('CONTAINS', contract, op);
    // Always emit a RouteHandler, keyed by method + path (the operation's own
    // unambiguous identity within `paths`), converged onto the same colon-param
    // syntax extract-code-ts uses -- not gated on a vendor extension being
    // present, so the join has a real node to land on even when the document
    // never declared `x-seamline-handler` et al.
    const handler = put(
      routeHandlerNode(
        args,
        fact.method,
        openApiPathToRouteParams(fact.path),
        fact.handler,
        fact.file,
      ),
    );
    link('IMPLEMENTED_BY', op, handler);
  }

  for (const fact of [...acc.properties].sort(byPropertyOrder)) {
    const property = put(schemaPropertyNode(args, fact));
    const contract = contractsByName.get(fact.contract);
    if (contract !== undefined) link('CONTAINS', contract, property);
  }

  return { nodes: sortNodes([...byId.values()]), edges: sortEdges(edges) };
}

/**
 * A contract's identity is `{repo}:Contract:{name}` and carries no path, so two
 * declarations of one name are one node. Their properties and operations would
 * be linked to whichever came first, mixing two schemas' facts into one
 * contract. Nothing here may invent a path-based identity to tell them apart,
 * so every declaration of a colliding name is withheld, along with its
 * properties, and its file leaves the claim. A Zod declaration whose shape
 * could not be read still holds its name: it may be the very contract the other
 * declaration would be mistaken for.
 *
 * Operations are keyed by method and path, not by contract, so a withheld
 * OpenAPI contract keeps its operations (and their route handlers); they are
 * simply no longer contained by a contract.
 */
function withholdNameCollisions(acc: Accumulator): void {
  const files = new Map<string, Set<string>>();
  const declare = (name: string, file: string): void => {
    const known = files.get(name);
    if (known === undefined) files.set(name, new Set([file]));
    else known.add(file);
  };
  for (const c of acc.contracts) declare(c.name, c.file);
  for (const w of acc.withheld) declare(w.name, w.file);

  const colliding = new Set<string>();
  for (const [name, declaredIn] of [...files].sort(([a], [b]) => cmp(a, b))) {
    if (declaredIn.size < 2) continue;
    colliding.add(name);
    const where = [...declaredIn].sort(cmp);
    for (const file of where) acc.unvouched.add(file);
    acc.diagnostics.push(
      `CONTRACT_NAME_COLLISION: ${name} is declared in ${where.join(', ')}; every declaration is withheld`,
    );
  }
  if (colliding.size === 0) return;
  const dropped = acc.contracts.filter((c) => colliding.has(c.name));
  acc.contracts = acc.contracts.filter((c) => !colliding.has(c.name));
  acc.properties = acc.properties.filter((p) => !colliding.has(p.contract));
  // A file whose every contract was withheld, and that declares no operation,
  // gave the run nothing certain; a scope with no such file has no source.
  const contributing = new Set([...acc.contracts, ...acc.operations].map((fact) => fact.file));
  for (const { file } of dropped) if (!contributing.has(file)) acc.sourceFiles.delete(file);
}

/**
 * Characters the selector syntax cannot write (`,` `{` `}` `*` `?`, a
 * backslash, a control character), plus whitespace at either end, which it
 * rejects, and a leading `!`, which the selector reads as an exclusion. A path
 * or directory carrying one is not claimed: the safe direction.
 */
const UNNAMEABLE = /[,{}*?\\\u0000-\u001f\u007f]|^\s|\s$|^!/u;

/**
 * Whether a repo-relative path can be written into a selector. Besides
 * `UNNAMEABLE`, the syntax refuses an empty, `.` or `..` segment, which a
 * caller-supplied file list can carry (`./src/a.ts`, `src//a.ts`) and which the
 * store would reject for the whole run.
 */
function isNameable(path: string): boolean {
  return (
    !UNNAMEABLE.test(path) &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/** An empty set even when callers explicitly supply discovery-excluded files. */
const CLAIMS_NOTHING_SELECTOR = '**/*,!**/*';

/** Files this extractor can derive a contract from. */
function isContractSource(rel: string): boolean {
  return (
    hasExtension(rel, DOCUMENT_EXTENSIONS) ||
    (hasExtension(rel, TS_EXTENSIONS) && !rel.toLowerCase().endsWith('.d.ts'))
  );
}

/**
 * The `contracts` claim. Whole, unless some file is not vouched for; then it
 * is narrowed to the files that are, so the store buries a contract only when
 * the file it came from was read to the end.
 */
function claimOf(
  candidates: readonly string[],
  unvouched: ReadonlySet<string>,
  explicitOnly = false,
): AuthoritativeScope {
  const kinds = MANIFEST.produces[0]?.kinds ?? [];
  const selector = explicitOnly
    ? explicitClaimSelector(candidates, unvouched)
    : claimSelector(candidates, unvouched);
  return selector === undefined
    ? { scope: CONTRACTS_SCOPE, kinds }
    : { scope: CONTRACTS_SCOPE, kinds, selector };
}

function explicitClaimSelector(candidates: readonly string[], unvouched: ReadonlySet<string>): string {
  const paths = candidates.filter(path => isContractSource(path) && !unvouched.has(path) && isNameable(path)).sort(cmp);
  if (paths.length === 0) return CLAIMS_NOTHING_SELECTOR;
  return paths.length === 1 ? paths[0] as string : `{${paths.join(',')}}`;
}

/**
 * A selector naming every contract source the run vouches for, or `undefined`
 * when it vouches for all of them.
 *
 * A directory holding no unvouched file anywhere beneath it is named whole
 * (`dir/**`), so a file deleted from it is still forgotten; a directory that
 * does is named file by file. The widest nameable pattern is used, so the list
 * is short in the usual case of a few unreadable schemas in a large tree.
 * Sorted by code unit, so the result is byte-reproducible.
 */
export function claimSelector(
  candidates: readonly string[],
  unvouched: ReadonlySet<string>,
): string | undefined {
  if (unvouched.size === 0) return undefined;

  const dirty = new Set<string>(['']);
  for (const rel of unvouched) {
    const segments = rel.split('/');
    for (let i = 1; i < segments.length; i += 1) dirty.add(segments.slice(0, i).join('/'));
  }

  const patterns = new Set<string>();
  for (const rel of candidates) {
    if (!isContractSource(rel) || unvouched.has(rel) || !isNameable(rel)) continue;
    const segments = rel.split('/');
    let widest: string | undefined;
    for (let i = 1; i < segments.length; i += 1) {
      const dir = segments.slice(0, i).join('/');
      if (!dirty.has(dir)) {
        widest = dir;
        break;
      }
    }
    if (widest === undefined) patterns.add(rel);
    else if (isNameable(widest)) patterns.add(`${widest}/**`);
  }

  const sorted = [...patterns].sort(cmp);
  if (sorted.length === 0) return CLAIMS_NOTHING_SELECTOR;
  if (sorted.length === 1) return sorted[0];
  return `{${sorted.join(',')}}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byContractOrder(a: ContractFact, b: ContractFact): number {
  return cmp(a.name, b.name) || cmp(a.file, b.file);
}

function byOperationOrder(a: OperationFact, b: OperationFact): number {
  return cmp(a.path, b.path) || cmp(a.method, b.method) || cmp(a.file, b.file);
}

function byPropertyOrder(a: PropertyFact, b: PropertyFact): number {
  return cmp(a.contract, b.contract) || cmp(a.jsonPointer, b.jsonPointer) || cmp(a.file, b.file);
}
