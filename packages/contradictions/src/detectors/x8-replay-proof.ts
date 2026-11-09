/** Bounded validation of the data producer's versioned historical evidence. */
import { parseNodeId, type GraphView, type SeamlineNode } from '@seamline/ontology';
import { factNodes } from '../graph.ts';

type Row = readonly [string, string, string | null, number, number];
type Missing = readonly [string, string, string | null, number, number, string, number, number];
interface Group { readonly path: string; readonly policy: string | null; readonly config: string | null; readonly complete: boolean; readonly names: readonly string[]; readonly reason: string; readonly input: string; }
interface MigrationProof {
  readonly node: SeamlineNode;
  readonly ordinal: number;
  readonly declarations: readonly Row[];
  readonly missing: readonly Missing[];
  readonly external: readonly Row[];
  readonly unknown: readonly Row[];
  readonly valid: readonly Row[];
  readonly skipped: readonly Row[];
}
export interface ReplayDisagreement { readonly reference: SeamlineNode; readonly creation: SeamlineNode; readonly row: Missing; }
export interface ReplayAnswer { readonly findings: readonly ReplayDisagreement[]; readonly withheld: readonly string[]; readonly external: number; }
const MAX_ROWS = 100_000;
const MAX_TEXT = 1_000_000;
const HASH = /^[0-9a-f]{64}$/;
class Invalid extends Error {}
function fail(): never { throw new Invalid('missing, malformed or stale migration replay evidence'); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value); }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_ROWS; }
interface Budget { chars: number; rows: number; }
function json(value: unknown, budget: Budget): unknown[] {
  if (typeof value !== 'string' || value.length > MAX_TEXT) return fail();
  budget.chars -= value.length;
  if (budget.chars < 0) return fail();
  let result: unknown;
  try { result = JSON.parse(value); } catch { return fail(); }
  if (!Array.isArray(result) || result.length > MAX_ROWS || JSON.stringify(result) !== value) return fail();
  budget.rows -= result.length;
  if (budget.rows < 0) return fail();
  return result;
}
function sorted(rows: readonly unknown[]): void {
  let previous: string | undefined;
  for (const row of rows) {
    const next = JSON.stringify(row);
    if (previous !== undefined && previous >= next) return fail();
    previous = next;
  }
}
function row(value: unknown, size: 5 | 8, steps: number): value is Row | Missing {
  if (!Array.isArray(value) || value.length !== size || !text(value[0]) || !text(value[1]) || !(value[2] === null || text(value[2])) || !count(value[3]) || value[3] >= steps || !count(value[4]) || value[4] === 0) return false;
  return size === 5 || (text(value[5]) && count(value[6]) && count(value[7]) && value[7] > 0);
}
function rows(node: SeamlineNode, key: string, countKey: string, size: 5 | 8, steps: number, budget: Budget): readonly (Row | Missing)[] {
  const result = json(node.props[key], budget);
  if (!count(node.props[countKey]) || result.length !== node.props[countKey]) return fail();
  if (!result.every((value) => row(value, size, steps))) return fail();
  sorted(result);
  return result as unknown as readonly (Row | Missing)[];
}
function identity(node: SeamlineNode, kind: 'DataSource' | 'Migration'): { repo: string; canonicalName: string } {
  const parsed = parseNodeId(node.id);
  if (kind === 'Migration' && (!/^[A-Za-z0-9._@+-]+(?:~[A-Za-z0-9._@+-]+)*$/.test(parsed.canonicalName) || parsed.canonicalName.split('~').some((part) => part === '.' || part === '..'))) return fail();
  if (node.kind !== kind || parsed.kind !== kind || !text(parsed.repo) || !text(parsed.canonicalName) || parsed.canonicalName !== node.name) return fail();
  return parsed;
}
function groups(source: SeamlineNode, budget: Budget): readonly Group[] {
  const values = json(source.props['replayGroups'], budget);
  if (!count(source.props['replayGroupCount']) || values.length !== source.props['replayGroupCount']) return fail();
  const out: Group[] = [];
  let previous: string | undefined;
  for (const value of values) {
    if (!Array.isArray(value) || value.length !== 7) return fail();
    const [path, policy, config, complete, names, reason, input] = value;
    if (!text(path) || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || (previous !== undefined && previous >= path)) return fail();
    if (!(policy === null || policy === 'supabase-filename-v1') || !(config === null || (typeof config === 'string' && HASH.test(config))) || typeof complete !== 'boolean' || !Array.isArray(names) || names.length > MAX_ROWS || !names.every(text) || typeof reason !== 'string' || reason.length > 4096 || typeof input !== 'string' || !HASH.test(input)) return fail();
    if (complete && (policy !== 'supabase-filename-v1' || config === null || !/(?:^|\/)supabase\/migrations$/.test(path))) return fail();
    for (let i = 1; i < names.length; i += 1) {
      const before: unknown = names[i - 1], after: unknown = names[i];
      if (!text(before) || !text(after) || before >= after) return fail();
    }
    previous = path; out.push({ path, policy, config, complete, names, reason, input });
  }
  return out;
}
function migration(node: SeamlineNode, source: SeamlineNode, group: Group, repo: string, budget: Budget): MigrationProof {
  const parsed = identity(node, 'Migration');
  const p = node.props;
  if (parsed.repo !== repo || p['dataSource'] !== source.props['dataSource'] || node.lastSeenRun !== source.lastSeenRun || p['replayEpoch'] !== source.lastSeenRun || p['replayVersion'] !== 1 || p['replaySnapshotHash'] !== source.props['replaySnapshotHash'] || p['replayInputHash'] !== group.input || p['replayGroup'] !== group.path || p['replayOrderPolicy'] !== group.policy || p['replayConfigHash'] !== group.config || p['replayInventoryComplete'] !== true) return fail();
  const steps = p['replayStepCount'];
  const ordinal = p['replayOrdinal'];
  if (!count(ordinal) || !count(steps) || p['replayUnknownStepCount'] !== 0 || p['replayUnknownSteps'] !== '[]') return fail();
  const declarations = rows(node, 'replayDeclarations', 'replayDeclarationCount', 5, steps, budget) as readonly Row[];
  const missing = rows(node, 'unresolvedRefs', 'unresolvedRefCount', 8, steps, budget) as readonly Missing[];
  const external = rows(node, 'externalRefs', 'externalRefCount', 5, steps, budget) as readonly Row[];
  const unknown = rows(node, 'unknownRefs', 'unknownRefCount', 5, steps, budget) as readonly Row[];
  const valid = rows(node, 'validRefs', 'validRefCount', 5, steps, budget) as readonly Row[];
  const skipped = rows(node, 'skippedRefs', 'skippedRefCount', 5, steps, budget) as readonly Row[];
  const all = [...missing, ...external, ...unknown, ...valid, ...skipped];
  if (!count(p['replayReferenceCount']) || p['replayReferenceCount'] !== all.length) return fail();
  const keys = all.map((entry) => JSON.stringify(entry.slice(0, 5)));
  if (new Set(keys).size !== keys.length) return fail();
  return { node, ordinal, declarations, missing, external, unknown, valid, skipped };
}
const target = (value: readonly unknown[]): string => JSON.stringify(value.slice(0, 3));

export function readReplayEvidence(graph: GraphView): ReplayAnswer {
  const findings: ReplayDisagreement[] = [];
  const withheld: string[] = [];
  let external = 0;
  const sources = factNodes(graph, 'DataSource');
  const candidates = factNodes(graph, 'Migration');
  if (!sources.length || sources.length > MAX_ROWS || candidates.length > MAX_ROWS) return { findings: [], withheld: ['extract-data has no bounded current migration replay inventory'], external: 0 };
  // Index fresh evidence per invocation, without caching a mutable GraphView.
  // Root-by-candidate rescans can otherwise multiply both bounded inventories.
  const candidatesByRealm = new Map<string, SeamlineNode[]>();
  for (const node of candidates) {
    let repo: string;
    try { repo = parseNodeId(node.id).repo; }
    catch { return { findings: [], withheld: ['a migration has a malformed replay identity'], external: 0 }; }
    const source = node.props['dataSource'];
    if (typeof source !== 'string') continue;
    const realm = JSON.stringify([repo, source]);
    const members = candidatesByRealm.get(realm) ?? [];
    members.push(node); candidatesByRealm.set(realm, members);
  }
  const budget: Budget = { chars: 8 * MAX_TEXT, rows: MAX_ROWS };
  const realms = new Set<string>();
  const duplicateRealms = new Set<string>();
  for (const source of sources) {
    try {
      const parsed = identity(source, 'DataSource');
      const realm = JSON.stringify([parsed.repo, source.name]);
      if (realms.has(realm)) duplicateRealms.add(realm);
      realms.add(realm);
    } catch { /* Invalid roots are withheld below. */ }
  }
  for (const source of sources) {
    try {
      const parsed = identity(source, 'DataSource');
      const p = source.props;
      if (p['dataSource'] !== source.name || p['replayVersion'] !== 1 || !text(source.lastSeenRun) || p['replayEpoch'] !== source.lastSeenRun || typeof p['replaySnapshotHash'] !== 'string' || !HASH.test(p['replaySnapshotHash']) || p['replayInventoryComplete'] !== true || p['replayMembershipComplete'] !== true) return fail();
      const realm = JSON.stringify([parsed.repo, source.name]);
      if (duplicateRealms.has(realm)) return fail();
      const inventory = groups(source, budget);
      const byName = new Map<string, SeamlineNode>();
      for (const node of candidatesByRealm.get(realm) ?? []) {
        if (node.lastSeenRun === source.lastSeenRun && node.props['replaySnapshotHash'] === undefined) return fail();
        if (node.props['replaySnapshotHash'] !== p['replaySnapshotHash']) continue;
        if (byName.has(node.name)) return fail();
        byName.set(node.name, node);
      }
      const listed = new Set(inventory.flatMap((entry) => entry.names));
      if (listed.size !== inventory.reduce((n, entry) => n + entry.names.length, 0) || [...byName.keys()].some((name) => !listed.has(name))) return fail();
      for (const entry of inventory) {
        if (!entry.complete) { withheld.push(`migration group ${entry.path}: ${entry.reason || 'replay order or source inventory is unknown'}`); continue; }
        try {
          const proofs = entry.names.map((name) => {
            const node = byName.get(name); if (node === undefined) return fail();
            return migration(node, source, entry, parsed.repo, budget);
          }).sort((a, b) => a.ordinal - b.ordinal);
          if (proofs.some((proof, index) => proof.ordinal !== index)) return fail();
          const byMigration = new Map(proofs.map((proof) => [proof.node.name, proof]));
          const declared = new Map<string, { order: number; step: number }>();
          const witnessSites = new Map<string, Set<string>>();
          for (const [order, proof] of proofs.entries()) for (const declaration of proof.declarations) {
            const k = target(declaration);
            const first = declared.get(k);
            if (first === undefined || order < first.order || (order === first.order && declaration[3] < first.step)) declared.set(k, { order, step: declaration[3] });
            const sites = witnessSites.get(proof.node.name) ?? new Set<string>();
            sites.add(JSON.stringify([k, declaration[3], declaration[4]]));
            witnessSites.set(proof.node.name, sites);
          }
          const pending: ReplayDisagreement[] = [];
          for (const [order, proof] of proofs.entries()) {
            for (const item of proof.external) if (declared.has(target(item))) return fail();
            for (const item of proof.valid) {
              const first = declared.get(target(item));
              if (first === undefined || first.order > order || (first.order === order && first.step > item[3])) return fail();
            }
            for (const item of proof.missing) {
              const witness = byMigration.get(item[5]);
              if (witness === undefined || (witness.node.id === proof.node.id && item[6] === item[3]) || !witnessSites.get(item[5])?.has(JSON.stringify([target(item), item[6], item[7]]))) return fail();
              pending.push({ reference: proof.node, creation: witness.node, row: item });
            }
          }
          // Nothing from a malformed group escapes before all its witnesses
          // and inventories have been checked.
          findings.push(...pending);
          external += proofs.reduce((n, proof) => n + proof.external.length, 0);
          const unknown = proofs.reduce((n, proof) => n + proof.unknown.length, 0);
          if (unknown) withheld.push(`migration group ${entry.path}: ${unknown} reference site(s) have unknown point-state`);
        } catch { withheld.push(`migration group ${entry.path}: replay evidence is missing, malformed or stale`); }
      }
    } catch { withheld.push('a data source has no complete current migration replay certificate'); }
  }
  return { findings, withheld: [...new Set(withheld)].sort(), external };
}
