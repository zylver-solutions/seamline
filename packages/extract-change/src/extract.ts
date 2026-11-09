/**
 * The change-history facts extractor.
 *
 * Emits `Commit` and `Changeset` nodes plus `TOUCHES` and `RENAMED_FROM` edges
 * at provenance `EXTRACTED`, over a bounded commit range.
 *
 * Node/edge shape decisions worth knowing:
 *
 * - **`Commit` vs `Changeset` is the trust boundary.** `Commit` carries who,
 *   when and why: author and committer identity, dates, subject. All of that is
 *   third-party text, so every `Commit` node is `untrusted: true` (v3 §2.6).
 *   `Changeset` carries what changed: counts, derived entirely by this code from
 *   git's status letters, containing no attacker-influenced string at all. The
 *   two are separate kinds so a consumer can read churn without handling
 *   untrusted text.
 * - **Dates are data, not wall clock.** Author and committer dates are facts
 *   about the commit and belong on the node; they are emitted as fixed-width
 *   ISO-8601 UTC derived from git's epoch seconds, so they never vary with the
 *   reader's locale or timezone. No `now()` appears anywhere in a node or edge.
 * - **Symbols need a resolver.** `TOUCHES` to a `Symbol` requires a canonical
 *   qualified name, which only `extract-code-ts` can produce (v3 §6). Guessing
 *   one here would emit edges pointing at ids nothing else mints, so symbol
 *   edges appear only when the caller supplies `resolveSymbols`.
 */
import type {
  EdgeKind, ExtractorResult, NodeId, NodeKind, Provenance, SeamlineEdge, SeamlineNode,
} from '@seamline/ontology';
import { DEFAULT_SENSITIVITY, assertWithinCeiling, edgeKey, isValidEdge, nodeId } from '@seamline/ontology';
import { posix } from 'node:path';
import { CHANGE_MANIFEST, EXTRACTOR_NAME, EXTRACTOR_VERSION, changeManifest } from './manifest.ts';
import { renameLedgerFrom } from './renames.ts';
import { prepareHistory } from './session.ts';
import type { ChangeExtraction, ChangeExtractorOptions, CommitRecord, RangeDescriptor, RenameLedger } from './types.ts';
import { CHANGE_SCOPE } from './types.ts';

const PROVENANCE: Provenance = 'EXTRACTED';

type PropValue = string | number | boolean | null;
type PropMap = Record<string, PropValue>;

/** Rebuilds a prop bag with sorted keys, so serialisation is byte-stable. */
function frozenProps(input: PropMap): Readonly<PropMap> {
  const out: PropMap = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.freeze(out);
}

const EMPTY_PROPS = frozenProps({});

interface NodeDraft {
  readonly kind: NodeKind;
  readonly canonicalName: string;
  readonly name: string;
  readonly path?: string;
  readonly untrusted?: true;
  readonly sourceRef?: string;
  readonly props: Readonly<PropMap>;
}

interface EdgeDraft {
  readonly kind: EdgeKind;
  readonly srcKind: NodeKind;
  readonly dstKind: NodeKind;
  readonly src: NodeId;
  readonly dst: NodeId;
  readonly srcFile?: string;
  readonly dstFile?: string;
  readonly sourceRef?: string;
  readonly confidence: number;
  readonly props: Readonly<PropMap>;
}

function buildNode(repo: string, runId: string, d: NodeDraft): SeamlineNode {
  const node: {
    id: NodeId; kind: NodeKind; name: string; path?: string;
    sensitivity: SeamlineNode['sensitivity']; provenance: Provenance; confidence: number;
    sourceRef?: string; untrusted?: boolean; props: Readonly<PropMap>;
    firstSeenRun: string; lastSeenRun: string; deletedAt: string | null;
  } = {
    id: nodeId(repo, d.kind, d.canonicalName),
    kind: d.kind,
    name: d.name,
    sensitivity: DEFAULT_SENSITIVITY[d.kind],
    provenance: PROVENANCE,
    confidence: 1,
    props: d.props,
    firstSeenRun: runId,
    lastSeenRun: runId,
    deletedAt: null,
  };
  if (d.path !== undefined) node.path = d.path;
  if (d.sourceRef !== undefined) node.sourceRef = d.sourceRef;
  if (d.untrusted !== undefined) node.untrusted = d.untrusted;
  return node;
}

/**
 * Every edge goes through `isValidEdge` before it exists. An endpoint pair
 * outside `EDGE_SIGNATURES` is a bug in this file, not bad input, so it throws
 * rather than being silently dropped, and the throw is caught at the top of
 * `extractChange`, which turns it into a `FAIL`, never a partial `PASS`.
 */
function buildEdge(runId: string, d: EdgeDraft): SeamlineEdge {
  if (!isValidEdge(d.kind, d.srcKind, d.dstKind)) {
    throw new Error(`invalid edge for ontology: ${d.srcKind} -[${d.kind}]-> ${d.dstKind}`);
  }
  const edge: {
    kind: EdgeKind; src: NodeId; dst: NodeId; srcFile?: string; dstFile?: string;
    provenance: Provenance; confidence: number; sourceRef?: string;
    props: Readonly<PropMap>; firstSeenRun: string; lastSeenRun: string; deletedAt: string | null;
  } = {
    kind: d.kind,
    src: d.src,
    dst: d.dst,
    provenance: PROVENANCE,
    confidence: d.confidence,
    props: d.props,
    firstSeenRun: runId,
    lastSeenRun: runId,
    deletedAt: null,
  };
  if (d.srcFile !== undefined) edge.srcFile = d.srcFile;
  if (d.dstFile !== undefined) edge.dstFile = d.dstFile;
  if (d.sourceRef !== undefined) edge.sourceRef = d.sourceRef;
  return edge;
}

function changesetProps(commit: CommitRecord): Readonly<PropMap> {
  let added = 0, modified = 0, deleted = 0, renamed = 0, copied = 0, typeChanged = 0, other = 0;
  for (const change of commit.changes) {
    switch (change.status) {
      case 'A': added += 1; break;
      case 'M': modified += 1; break;
      case 'D': deleted += 1; break;
      case 'R': renamed += 1; break;
      case 'C': copied += 1; break;
      case 'T': typeChanged += 1; break;
      default: other += 1; break;
    }
  }
  return frozenProps({
    commit: commit.sha,
    fileCount: commit.changes.length,
    addedCount: added,
    modifiedCount: modified,
    deletedCount: deleted,
    renameCount: renamed,
    copyCount: copied,
    typeChangedCount: typeChanged,
    otherCount: other,
  });
}

function emptyResult(
  status: ExtractorResult['status'],
  range: RangeDescriptor,
  diagnostics: ReadonlyArray<string>,
  durationMs: number,
): ExtractorResult {
  return {
    extractor: EXTRACTOR_NAME,
    version: EXTRACTOR_VERSION,
    status,
    authoritative: changeManifest(range.spec).produces,
    nodeCount: 0,
    edgeCount: 0,
    durationMs,
    diagnostics,
  };
}

function emptyLedger(repo: string, range: RangeDescriptor, threshold: number, status: ExtractorResult['status'], diagnostics: ReadonlyArray<string>): RenameLedger {
  return { repo, status, range, threshold, complete: false, records: [], diagnostics };
}

/**
 * Walks a bounded commit range and returns the graph slice for it.
 *
 * Synchronous on purpose: `spawnSync` with an argument array is the smallest
 * correct way to run two `git log` calls, and an async wrapper would only add a
 * layer for a caller to get wrong. Cost is bounded by `depth`, not by history.
 */
export function extractChange(options: ChangeExtractorOptions): ChangeExtraction {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  // The host enforces the ceiling, but asserting it here means a future edit
  // that raises `PROVENANCE` fails on the first call rather than in review.
  assertWithinCeiling(CHANGE_MANIFEST, PROVENANCE);

  const outcome = prepareHistory(options);
  const repo = typeof options.repo === 'string' ? options.repo : '';
  if (!outcome.ok) {
    return {
      result: emptyResult(outcome.status, outcome.range, outcome.diagnostics, elapsed()),
      nodes: [],
      edges: [],
      renames: emptyLedger(repo, outcome.range, outcome.threshold, outcome.status, outcome.diagnostics),
    };
  }

  const { cfg, commits, range, diagnostics } = outcome.prepared;
  const ledger = renameLedgerFrom(outcome.prepared);

  try {
    const nodes = new Map<NodeId, SeamlineNode>();
    const edges = new Map<string, SeamlineEdge>();
    const addNode = (draft: NodeDraft): NodeId => {
      const node = buildNode(cfg.repo, cfg.runId, draft);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      return node.id;
    };
    const addEdge = (draft: EdgeDraft): void => {
      const edge = buildEdge(cfg.runId, draft);
      const key = edgeKey(CHANGE_SCOPE, edge);
      const existing = edges.get(key);
      // Deterministic conflict rule: the stronger claim wins; ties keep the
      // first seen in the (already sorted) walk.
      if (existing === undefined || edge.confidence > existing.confidence) edges.set(key, edge);
    };

    const fileNode = (path: string): NodeId =>
      addNode({ kind: 'File', canonicalName: path, name: posix.basename(path), path, props: EMPTY_PROPS });

    let mergesWithoutDiff = 0;

    for (const commit of commits) {
      const commitId = addNode({
        kind: 'Commit',
        canonicalName: commit.sha,
        name: commit.sha,
        untrusted: true,
        sourceRef: commit.sha,
        props: frozenProps({
          sha: commit.sha,
          authorDate: commit.authorDate,
          committerDate: commit.committerDate,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          committerName: commit.committerName,
          committerEmail: commit.committerEmail,
          subject: commit.subject,
          parents: commit.parents.join(' '),
          parentCount: commit.parents.length,
          isMerge: commit.parents.length > 1,
        }),
      });

      const changesetId = addNode({
        kind: 'Changeset',
        canonicalName: commit.sha,
        name: commit.sha,
        sourceRef: commit.sha,
        props: changesetProps(commit),
      });

      if (commit.parents.length > 1 && commit.changes.length === 0) mergesWithoutDiff += 1;

      for (const change of commit.changes) {
        const path = change.path;
        const dst = fileNode(path);
        const touchProps: PropMap = { status: change.status, commit: commit.sha };
        if (change.fromPath !== null) touchProps['previousPath'] = change.fromPath;
        if (change.similarity !== null) touchProps['similarity'] = change.similarity;

        addEdge({
          kind: 'TOUCHES', srcKind: 'Commit', dstKind: 'File',
          src: commitId, dst, dstFile: path, sourceRef: commit.sha,
          confidence: 1, props: frozenProps(touchProps),
        });

        if (cfg.resolveSymbols !== null) {
          const seen = new Set<string>();
          for (const symbol of cfg.resolveSymbols({ commit: commit.sha, path, status: change.status })) {
            if (symbol.length === 0 || seen.has(symbol)) continue;
            seen.add(symbol);
            const symbolId = nodeId(cfg.repo, 'Symbol', symbol);
            const symbolProps = frozenProps({ status: change.status, commit: commit.sha });
            addEdge({
              kind: 'TOUCHES', srcKind: 'Commit', dstKind: 'Symbol',
              src: commitId, dst: symbolId, dstFile: path, sourceRef: commit.sha,
              confidence: 1, props: symbolProps,
            });
            addEdge({
              kind: 'TOUCHES', srcKind: 'Changeset', dstKind: 'Symbol',
              src: changesetId, dst: symbolId, dstFile: path, sourceRef: commit.sha,
              confidence: 1, props: symbolProps,
            });
          }
        }
      }
    }

    // RENAMED_FROM comes from the ledger, so the edges and the interface handed
    // to the identity layer can never disagree. Copies are excluded on purpose:
    // both sides of a copy still exist, and aliasing them would merge two live
    // files into one identity.
    for (const record of ledger.records) {
      if (record.kind !== 'rename') continue;
      fileNode(record.from);
      fileNode(record.to);
      addEdge({
        kind: 'RENAMED_FROM', srcKind: 'File', dstKind: 'File',
        src: record.toId, dst: record.fromId,
        srcFile: record.to, dstFile: record.from,
        sourceRef: record.commit,
        // The similarity ratio is the confidence: git matched this pair at
        // exactly that strength, and this extractor adds nothing to the claim.
        confidence: record.similarity,
        props: frozenProps({
          similarity: record.similarity,
          commit: record.commit,
          authorDate: record.authorDate,
          fromPath: record.from,
          toPath: record.to,
        }),
      });
    }

    const sortedNodes = [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const sortedEdges = [...edges.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.src !== b.src) return a.src < b.src ? -1 : 1;
      return a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0;
    });

    const finalDiagnostics = [
      ...diagnostics,
      `renames ${ledger.records.filter((r) => r.kind === 'rename').length}`,
      `copies ${ledger.records.filter((r) => r.kind === 'copy').length}`,
      `mergeCommitsWithoutDiff ${mergesWithoutDiff}`,
      'File nodes are emitted as edge endpoints only; this extractor is not authoritative for kind File',
    ];

    return {
      result: {
        extractor: EXTRACTOR_NAME,
        version: EXTRACTOR_VERSION,
        status: 'PASS',
        authoritative: changeManifest(range.spec).produces,
        nodeCount: sortedNodes.length,
        edgeCount: sortedEdges.length,
        durationMs: elapsed(),
        diagnostics: finalDiagnostics,
      },
      nodes: sortedNodes,
      edges: sortedEdges,
      renames: ledger,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      result: emptyResult('FAIL', range, [...diagnostics, `emission failed: ${reason}`], elapsed()),
      nodes: [],
      edges: [],
      renames: emptyLedger(cfg.repo, range, cfg.req.renameThreshold, 'FAIL', [...diagnostics, `emission failed: ${reason}`]),
    };
  }
}
