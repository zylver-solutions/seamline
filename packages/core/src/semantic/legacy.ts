/** Bridge from the existing materialized code graph. History begins at import. */
import { createHash } from 'node:crypto';
import {
  EDGE_KINDS,
  EDGE_SIGNATURES,
  NODE_KINDS,
  PROVENANCE,
  SENSITIVITY,
  isFact,
} from '@seamline/ontology';
import type { RunRecord, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { createRedactor } from '@seamline/security';
import { canonicalJson } from '../merge/serialize.ts';
import type {
  Changes,
  Entity,
  Field,
  Profile,
  Properties,
  Relation,
  Snapshot,
  Value,
} from './types.ts';

const required = (kind: 'string' | 'json' | 'boolean'): Field => ({
  schema: { kind },
  required: true,
});
const metadata: Record<string, Field> = {
  provenance: { schema: { kind: 'string', enum: PROVENANCE }, required: true },
  confidence: { schema: { kind: 'number', min: 0, max: 1 }, required: true },
  sourceRef: { schema: { kind: 'string' } },
  props: required('json'),
  firstSeenRun: required('string'),
  lastSeenRun: required('string'),
  deletedAt: { schema: { kind: 'string' }, nullable: true, required: true },
};
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = <T>(value: T): T => structuredClone(value);

/** The supplied graph must be the complete materialized snapshot, including retained
 * rows after failed extraction. This is not an incremental extractor sink. */
export function prepareLegacyImport(
  nodes: readonly SeamlineNode[],
  edges: readonly SeamlineEdge[],
  run: RunRecord,
): Properties {
  const redactor = createRedactor();
  const safe = redactor.redactGraph(nodes, edges);
  const sanitize = (value: Value): Value => {
    if (typeof value === 'string') return redactor.redactString(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
    return value;
  };
  return copy({
    nodes: safe.nodes,
    edges: safe.edges,
    run: sanitize(run as unknown as Value),
  }) as unknown as Properties;
}

function importSnapshot(args: Properties, previous: Snapshot): Changes {
  const nodes = args['nodes'] as unknown as SeamlineNode[];
  const edges = args['edges'] as unknown as SeamlineEdge[];
  const run = args['run'] as unknown as RunRecord;
  if (
    !Array.isArray(nodes) ||
    !Array.isArray(edges) ||
    !run ||
    typeof run.runId !== 'string' ||
    typeof run.repo !== 'string' ||
    !Array.isArray(run.results)
  )
    throw new Error('invalid legacy snapshot envelope');
  const redactor = createRedactor();
  const validateProps = (props: unknown): void => {
    if (
      !props ||
      typeof props !== 'object' ||
      Array.isArray(props) ||
      Object.values(props).some(
        (v) => v !== null && !['string', 'number', 'boolean'].includes(typeof v),
      )
    )
      throw new Error('legacy properties must be primitive');
  };
  if (!run.repo || run.repo.includes(':') || redactor.redactString(run.repo) !== run.repo)
    throw new Error('invalid or secret-bearing repository identity');
  for (const n of nodes) {
    if (
      !NODE_KINDS.includes(n.kind) ||
      typeof n.id !== 'string' ||
      !n.id.startsWith(`${run.repo}:${n.kind}:`) ||
      n.deletedAt !== null
    )
      throw new Error('invalid or deleted legacy node');
    validateProps(n.props);
  }
  for (const e of edges) {
    if (
      !EDGE_KINDS.includes(e.kind) ||
      typeof e.src !== 'string' ||
      !e.src.startsWith(`${run.repo}:`) ||
      e.deletedAt !== null
    )
      throw new Error('invalid, foreign, or deleted legacy edge');
    validateProps(e.props);
  }
  const safe = redactor.redactGraph(nodes, edges);
  const entities: Entity[] = safe.nodes.map((n) => ({
    id: n.id,
    type: `code.${n.kind}`,
    properties: copy({
      name: n.name,
      sensitivity: n.sensitivity,
      provenance: n.provenance,
      confidence: n.confidence,
      props: n.props,
      firstSeenRun: redactor.redactString(n.firstSeenRun),
      lastSeenRun: redactor.redactString(n.lastSeenRun),
      deletedAt: n.deletedAt,
      ...(n.path === undefined ? {} : { path: n.path }),
      ...(n.sourceRef === undefined ? {} : { sourceRef: n.sourceRef }),
      ...(n.untrusted === undefined ? {} : { untrusted: n.untrusted }),
    }) as Properties,
  }));
  const relations: Relation[] = safe.edges.map((e) => ({
    id: `code.edge:${digest([e.kind, e.src, e.dst])}`,
    type: `code.${e.kind}`,
    from: e.src,
    to: e.dst,
    properties: copy({
      provenance: e.provenance,
      confidence: e.confidence,
      props: e.props,
      firstSeenRun: redactor.redactString(e.firstSeenRun),
      lastSeenRun: redactor.redactString(e.lastSeenRun),
      deletedAt: e.deletedAt,
      ...(e.sourceRef === undefined ? {} : { sourceRef: e.sourceRef }),
      ...(e.srcFile === undefined ? {} : { srcFile: e.srcFile }),
      ...(e.dstFile === undefined ? {} : { dstFile: e.dstFile }),
    }) as Properties,
  }));
  const statusRows = new Map<string, Entity>();
  for (const result of run.results) {
    if (
      !['PASS', 'FAIL', 'UNAVAILABLE'].includes(result.status) ||
      !Array.isArray(result.authoritative) ||
      !Array.isArray(result.diagnostics)
    )
      throw new Error('invalid legacy source status');
    for (const authoritative of result.authoritative) {
      if (
        typeof authoritative.scope !== 'string' ||
        !Array.isArray(authoritative.kinds) ||
        authoritative.kinds.some((k: string) => !(NODE_KINDS as readonly string[]).includes(k))
      )
        throw new Error('invalid legacy authoritative scope');
      const id = `code.scope:${digest([run.repo, authoritative.scope, result.extractor])}`;
      if (statusRows.has(id)) throw new Error('duplicate legacy authoritative scope');
      statusRows.set(id, {
        id,
        type: 'code.SourceScope',
        properties: {
          repo: run.repo,
          scope: redactor.redactString(authoritative.scope),
          extractor: redactor.redactString(result.extractor),
          version: redactor.redactString(result.version),
          ontologyVersion: redactor.redactString(run.ontologyVersion),
          ...(authoritative.selector === undefined
            ? {}
            : { selector: redactor.redactString(authoritative.selector) }),
          status: result.status,
          kinds: [...authoritative.kinds],
          runId: redactor.redactString(run.runId),
          commit: run.commit === null ? null : redactor.redactString(run.commit),
          diagnostics: result.diagnostics.map((d: string) => redactor.redactString(d)),
        },
      });
    }
  }
  entities.push(...statusRows.values());
  const ids = new Set(entities.map((e) => e.id));
  if (ids.size !== entities.length || new Set(relations.map((e) => e.id)).size !== relations.length)
    throw new Error('duplicate legacy identity; merge scoped legacy edges before import');
  const currentIds = new Set(entities.map((e) => e.id));
  const currentRelations = new Set(relations.map((e) => e.id));
  return {
    putEntities: entities,
    putRelations: relations,
    removeEntities: previous.entities
      .filter(
        (e) =>
          e.type.startsWith('code.') &&
          (e.id.startsWith(`${run.repo}:`) ||
            (e.type === 'code.SourceScope' && e.properties['repo'] === run.repo)) &&
          !currentIds.has(e.id),
      )
      .map((e) => e.id),
    removeRelations: previous.relations
      .filter(
        (e) =>
          e.type.startsWith('code.') &&
          e.from.startsWith(`${run.repo}:`) &&
          !currentRelations.has(e.id),
      )
      .map((e) => e.id),
  };
}

export const legacyCodeProfile: Profile = {
  id: 'code',
  version: '1.0.0',
  requires: {},
  types: [
    ...NODE_KINDS.map((kind) => ({
      id: `code.${kind}`,
      fields: {
        ...metadata,
        name: required('string'),
        sensitivity: { schema: { kind: 'string' as const, enum: SENSITIVITY }, required: true },
        path: { schema: { kind: 'string' as const } },
        untrusted: { schema: { kind: 'boolean' as const } },
      },
    })),
    {
      id: 'code.SourceScope',
      fields: {
        repo: required('string'),
        scope: required('string'),
        extractor: required('string'),
        version: required('string'),
        ontologyVersion: required('string'),
        selector: { schema: { kind: 'string' } },
        runId: required('string'),
        status: {
          schema: { kind: 'string', enum: ['PASS', 'FAIL', 'UNAVAILABLE'] },
          required: true,
        },
        kinds: required('json'),
        diagnostics: required('json'),
        commit: { schema: { kind: 'string' }, required: true, nullable: true },
      },
    },
  ],
  relations: EDGE_KINDS.map((kind) => ({
    id: `code.${kind}`,
    from: [...new Set(EDGE_SIGNATURES[kind].map(([from]) => `code.${from}`))],
    to: [...new Set(EDGE_SIGNATURES[kind].map(([, to]) => `code.${to}`))],
    fields: {
      ...metadata,
      srcFile: { schema: { kind: 'string' } },
      dstFile: { schema: { kind: 'string' } },
    },
  })),
  commands: [
    {
      id: 'code.import',
      version: '1',
      input: {
        nodes: required('json'),
        edges: required('json'),
        run: required('json'),
      },
      apply: (context, args) => importSnapshot(args, context.snapshot),
    },
  ],
  invariants: [
    {
      id: 'code.import-only-writer',
      version: '1',
      check(snapshot, previous, command) {
        if (previous === undefined || command === 'code.import') return;
        const codeState = (state: Snapshot): string =>
          canonicalJson({
            entities: state.entities
              .filter((e) => e.type.startsWith('code.'))
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
            relations: state.relations
              .filter((e) => e.type.startsWith('code.'))
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
          });
        if (codeState(snapshot) !== codeState(previous))
          throw new Error('code records may change only through code.import');
      },
    },
    {
      id: 'code.exact-endpoint-signatures',
      version: '1',
      check(snapshot) {
        const entities = new Map(snapshot.entities.map((e) => [e.id, e]));
        for (const edge of snapshot.relations.filter((e) => e.type.startsWith('code.'))) {
          const kind = edge.type.slice(5) as keyof typeof EDGE_SIGNATURES;
          if (
            !EDGE_SIGNATURES[kind]?.some(
              ([from, to]) =>
                entities.get(edge.from)?.type === `code.${from}` &&
                entities.get(edge.to)?.type === `code.${to}`,
            )
          )
            throw new Error(`invalid legacy endpoint pair: ${edge.type}`);
        }
      },
    },
  ],
};

/** Empty results can establish absence only when every required scope passed. */
export function legacyScopeStatus(
  snapshot: Snapshot,
  scope: string,
  repo?: string,
): 'PASS' | 'FAIL' | 'UNAVAILABLE' {
  const rows = snapshot.entities.filter(
    (e) =>
      e.type === 'code.SourceScope' &&
      e.properties['scope'] === scope &&
      (repo === undefined || e.properties['repo'] === repo),
  );
  if (rows.length === 0 || rows.some((e) => e.properties['status'] === 'UNAVAILABLE'))
    return 'UNAVAILABLE';
  return rows.some((e) => e.properties['status'] === 'FAIL') ? 'FAIL' : 'PASS';
}

/** Classification remains inherited evidence, never inferred from graph presence. */
export function legacyIsFact(entity: Entity | Relation): boolean {
  const provenance: Value | undefined = entity.properties['provenance'];
  return (provenance === 'EXTRACTED' || provenance === 'DECLARED') && isFact(provenance);
}
