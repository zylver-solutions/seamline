/** ADR-0018 identity checks shared by JS matching and the SQLite boundary. */
import { NODE_KINDS, parseNodeId, type AuthoritativeScope, type NodeId, type NodeKind } from '@seamline/ontology';
import type { CompiledCanonicalSelector } from './canonical-selector.ts';

const INVALID_SCALAR = /[\u0000-\u001f\u007f\ud800-\udfff]/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface AuthorityNode {
  readonly id?: string | undefined;
  readonly kind: NodeKind;
  readonly path?: string | undefined;
}

export interface AuthorityContext {
  readonly repo: string;
  /** Includes tombstoned records: an existing retired anchor still confines deletion. */
  readonly node?: ((id: NodeId) => AuthorityNode | undefined) | undefined;
}

function identity(id: string | undefined, repo: string): ReturnType<typeof parseNodeId> | undefined {
  if (id === undefined || INVALID_SCALAR.test(id)) return undefined;
  try {
    const parsed = parseNodeId(id as NodeId);
    if (parsed.repo.length === 0 || parsed.repo !== repo || parsed.canonicalName.length === 0 ||
        !NODE_KINDS.includes(parsed.kind)) return undefined;
    return parsed;
  } catch { return undefined; }
}

/** Returns null at the SQLite function boundary, never an invented node kind. */
export function canonicalIdKind(id: string, repo: string): NodeKind | null {
  return identity(id, repo)?.kind ?? null;
}

/**
 * Node 22.13 truncates SQLite TEXT callback arguments at NUL. Use the BLOB
 * bridge, which carries an explicit byte length, then strictly decode here.
 * https://github.com/nodejs/node/blob/v22.13.0/src/node_sqlite.cc#L146-L163
 */
export function canonicalIdKindFromBytes(id: unknown, repo: unknown): NodeKind | null {
  if (!(id instanceof Uint8Array) || !(repo instanceof Uint8Array)) return null;
  try { return canonicalIdKind(UTF8.decode(id), UTF8.decode(repo)); }
  catch { return null; }
}

export function canonicalClaimCoversNode(
  scope: AuthoritativeScope,
  selector: CompiledCanonicalSelector,
  node: AuthorityNode,
  context: AuthorityContext | undefined,
): boolean {
  if (context === undefined || !scope.kinds.includes(node.kind) || node.path !== selector.path) return false;
  const parsed = identity(node.id, context.repo);
  return parsed !== undefined && parsed.kind === node.kind && selector.matchesName(parsed.canonicalName);
}

export function canonicalClaimCoversEdge(
  scope: AuthoritativeScope,
  selector: CompiledCanonicalSelector,
  edge: { readonly src?: string | undefined; readonly dst?: string | undefined },
  context: AuthorityContext | undefined,
): boolean {
  if (context?.node === undefined) return false;
  const src = identity(edge.src, context.repo);
  const dst = identity(edge.dst, context.repo);
  if (src === undefined || dst === undefined) return false;
  const anchor = scope.kinds.includes(src.kind) ? edge.src
    : scope.kinds.includes(dst.kind) ? edge.dst : undefined;
  if (anchor === undefined) return false;
  const node = context.node(anchor as NodeId);
  return node !== undefined && node.id === anchor && canonicalClaimCoversNode(scope, selector, node, context);
}

/** Bound literal comparisons. SQLite never interprets canonical names as GLOBs. */
function namePredicateSql(name: string): string {
  return `EXISTS (SELECT 1 FROM json_each(:canonical_rules) AS rule
    WHERE (json_extract(rule.value, '$[0]') = 'exact'
           AND ${name} = json_extract(rule.value, '$[1]') COLLATE BINARY)
       OR (json_extract(rule.value, '$[0]') = 'prefix'
           AND substr(${name}, 1, length(json_extract(rule.value, '$[1]')))
               = json_extract(rule.value, '$[1]') COLLATE BINARY))`;
}

/** Internal SQL fragments; callers supply only owned table aliases. */
export function canonicalNodePredicateSql(table: string): string {
  const name = `substr(${table}.id, length(:repo || ':' || ${table}.kind || ':') + 1)`;
  return `(${table}.repo = :repo AND ${table}.path = :canonical_path
    AND seamline_canonical_id_kind(CAST(${table}.id AS BLOB), CAST(:repo AS BLOB)) = ${table}.kind
    AND ${namePredicateSql(name)})`;
}

export function canonicalEdgePredicateSql(): string {
  return `(seamline_canonical_id_kind(CAST(edges.src_id AS BLOB), CAST(:repo AS BLOB)) IS NOT NULL
    AND seamline_canonical_id_kind(CAST(edges.dst_id AS BLOB), CAST(:repo AS BLOB)) IS NOT NULL
    AND EXISTS (SELECT 1 FROM nodes AS anchor
      WHERE anchor.id = CASE
        WHEN seamline_canonical_id_kind(CAST(edges.src_id AS BLOB), CAST(:repo AS BLOB)) IN (SELECT value FROM json_each(:canonical_kinds))
          THEN edges.src_id ELSE edges.dst_id END
        AND anchor.kind IN (SELECT value FROM json_each(:canonical_kinds))
        AND ${canonicalNodePredicateSql('anchor')}))`;
}
