/**
 * Property-based proof of the identity invariants (v3 §7).
 *
 * The conformance gate in v3 §2.1 is: `git mv` a file, re-extract, assert that
 * no id changes except the moved `File`'s own (a `File` id is its path; when a
 * move does change other ids is stated in ADR-0016 item 4 and pinned by
 * `packages/integration/src/rename-id-boundary.test.ts`), that every edge
 * between other nodes is unchanged, and that the retired `File` id resolves
 * through the alias table to the new one.
 * Spot-checking one move proves nothing; this file asserts part of it over
 * randomized repositories and randomized moves, and only that part:
 *
 * - `Symbol` ids and `CALLS` edge keys are unchanged by a move. Each generated
 *   symbol keeps its module, so a move across packages is never generated;
 *   other kinds are covered by the extractors' own tests.
 * - A rename at or above the similarity threshold yields an alias that
 *   resolves the retired `File` id to the new one, and one below it yields none.
 * - `rewriteEdges` over the pre-move edges equals the edges of a re-extraction.
 *   `rewriteEdges` has no production caller; it stands in for re-extraction.
 * - A column id is its schema, table and column and nothing else. The move of
 *   a declaring file is exercised in `extract-data`'s own tests.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import fc from 'fast-check';
import { edgeKey, type NodeId, type SeamlineEdge, type SeamlineNode } from '@seamline/ontology';

import { AliasTable, MAX_ALIAS_CHAIN, rewriteEdges, type AliasRow } from './alias.ts';
import { columnName, fileName, makeNodeId, symbolName } from './canonical.ts';
import { DEFAULT_RENAME_SIMILARITY, ingestFileRenames, type GitRenameRecord } from './rename.ts';

const RUNS = 300;
const REPO = 'seamline';
/** The default threshold as git's whole-percent similarity. */
const THRESHOLD_PERCENT = Math.round(DEFAULT_RENAME_SIMILARITY * 100);
const arbAboveThreshold = fc.integer({ min: THRESHOLD_PERCENT, max: 100 });
const arbBelowThreshold = fc.integer({ min: 0, max: THRESHOLD_PERCENT - 1 });

const arbSegment = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/);
const arbPath = fc
  .tuple(fc.array(arbSegment, { minLength: 0, maxLength: 3 }), arbSegment)
  .map(([dirs, base]) => [...dirs, `${base}.ts`].join('/'));
const arbQualified = fc.array(fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,7}$/), { minLength: 1, maxLength: 3 });
const arbModule = fc.stringMatching(/^@[a-z]{1,6}\/[a-z]{1,6}$/);

interface Extraction {
  readonly nodes: ReadonlyArray<SeamlineNode>;
  readonly edges: ReadonlyArray<SeamlineEdge>;
}

/** A symbol as an extractor would emit it: path is carried, never keyed on. */
function symbolNode(qualified: ReadonlyArray<string>, module: string, path: string): SeamlineNode {
  const name = symbolName({ module, qualifiedName: qualified });
  return {
    id: makeNodeId(REPO, 'Symbol', name),
    kind: 'Symbol',
    name,
    path,
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: 'r01',
    lastSeenRun: 'r01',
    deletedAt: null,
  };
}

function fileNode(path: string): SeamlineNode {
  return {
    id: makeNodeId(REPO, 'File', fileName(path)),
    kind: 'File',
    name: path,
    path,
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: 'r01',
    lastSeenRun: 'r01',
    deletedAt: null,
  };
}

/** Re-extract a repo where every symbol lives at `pathOf(symbolIndex)`. */
function extract(
  symbols: ReadonlyArray<{ qualified: ReadonlyArray<string>; module: string }>,
  pathOf: (i: number) => string,
): Extraction {
  const nodes: SeamlineNode[] = [];
  const edges: SeamlineEdge[] = [];
  const seenFiles = new Set<string>();
  symbols.forEach((s, i) => {
    const path = pathOf(i);
    if (!seenFiles.has(path)) {
      seenFiles.add(path);
      nodes.push(fileNode(path));
    }
    const node = symbolNode(s.qualified, s.module, path);
    nodes.push(node);
    edges.push({
      kind: 'CONTAINS',
      src: makeNodeId(REPO, 'File', fileName(path)),
      dst: node.id,
      srcFile: path,
      dstFile: path,
      provenance: 'EXTRACTED',
      confidence: 1,
      props: {},
      firstSeenRun: 'r01',
      lastSeenRun: 'r01',
      deletedAt: null,
    });
  });
  // A symbol-to-symbol edge, whose identity must survive any file move.
  for (let i = 1; i < symbols.length; i += 1) {
    const from = symbols[i - 1];
    const to = symbols[i];
    if (from === undefined || to === undefined) continue;
    edges.push({
      kind: 'CALLS',
      src: makeNodeId(REPO, 'Symbol', symbolName({ module: from.module, qualifiedName: from.qualified })),
      dst: makeNodeId(REPO, 'Symbol', symbolName({ module: to.module, qualifiedName: to.qualified })),
      srcFile: pathOf(i - 1),
      dstFile: pathOf(i),
      provenance: 'EXTRACTED',
      confidence: 1,
      props: {},
      firstSeenRun: 'r01',
      lastSeenRun: 'r01',
      deletedAt: null,
    });
  }
  return { nodes, edges };
}

const arbSymbols = fc.array(fc.record({ qualified: arbQualified, module: arbModule }), {
  minLength: 1,
  maxLength: 6,
});

function idsOfKind(extraction: Extraction, kind: string): ReadonlyArray<NodeId> {
  return extraction.nodes
    .filter((n) => n.kind === kind)
    .map((n) => n.id)
    .sort();
}

function edgeKeysOfKind(extraction: Extraction, kind: string): ReadonlyArray<string> {
  return extraction.edges
    .filter((e) => e.kind === kind)
    .map((e) => edgeKey('code', e))
    .sort();
}

describe('identity is stable', () => {
  test('re-extracting unchanged input yields identical ids', () => {
    fc.assert(
      fc.property(arbSymbols, arbPath, (symbols, path) => {
        const first = extract(symbols, () => path);
        const second = extract(symbols, () => path);
        assert.deepEqual(idsOfKind(second, 'Symbol'), idsOfKind(first, 'Symbol'));
        assert.deepEqual(edgeKeysOfKind(second, 'CALLS'), edgeKeysOfKind(first, 'CALLS'));
      }),
      { numRuns: RUNS },
    );
  });

  test('moving every file changes no symbol id and no symbol-to-symbol edge', () => {
    fc.assert(
      fc.property(arbSymbols, arbPath, arbPath, (symbols, before, after) => {
        fc.pre(before !== after);
        const first = extract(symbols, () => before);
        const moved = extract(symbols, () => after);
        assert.deepEqual(idsOfKind(moved, 'Symbol'), idsOfKind(first, 'Symbol'));
        assert.deepEqual(edgeKeysOfKind(moved, 'CALLS'), edgeKeysOfKind(first, 'CALLS'));
        // The path property did change; it is carried, not keyed on.
        const movedSymbol = moved.nodes.find((n) => n.kind === 'Symbol');
        assert.equal(movedSymbol?.path, after);
      }),
      { numRuns: RUNS },
    );
  });

  test('a column id is exactly its schema, table and column, so no declaring file is in it', () => {
    fc.assert(
      fc.property(arbSegment, arbSegment, arbSegment, (schema, table, column) => {
        // `columnName` takes no path, so a declaring file could only reach the id
        // through these three parts. That a moved file leaves a column's id alone
        // is asserted against a real extraction by `extract-data`'s "node ids
        // survive a rename of the file that declares them".
        assert.equal(
          makeNodeId(REPO, 'Column', columnName({ schema, table, column })),
          `${REPO}:Column:${schema}.${table}.${column}`,
        );
      }),
      { numRuns: RUNS },
    );
  });
});

describe('a rename survives end to end', () => {
  test('the retired File id resolves to the new one and stale edges rewrite onto it', () => {
    fc.assert(
      fc.property(arbSymbols, arbPath, arbPath, arbAboveThreshold, (symbols, before, after, sim) => {
        fc.pre(before !== after);
        const first = extract(symbols, () => before);
        const record: GitRenameRecord = { from: before, to: after, similarity: sim / 100 };
        const { aliases } = ingestFileRenames([record], { repo: REPO, runId: 'r02' });
        assert.equal(aliases.length, 1);

        const table = AliasTable.from(aliases);
        const oldFileId = makeNodeId(REPO, 'File', fileName(before));
        const newFileId = makeNodeId(REPO, 'File', fileName(after));
        assert.equal(table.resolveId(oldFileId), newFileId);

        const rewritten = rewriteEdges(table, first.edges);
        const reextracted = extract(symbols, () => after);
        assert.deepEqual(
          rewritten.map((e) => edgeKey('code', e)).sort(),
          reextracted.edges.map((e) => edgeKey('code', e)).sort(),
        );
      }),
      { numRuns: RUNS },
    );
  });

  test('a rename below the threshold produces no alias, so no history is merged', () => {
    fc.assert(
      fc.property(arbPath, arbPath, arbBelowThreshold, (before, after, sim) => {
        fc.pre(before !== after);
        const { aliases, rejected } = ingestFileRenames(
          [{ from: before, to: after, similarity: sim / 100 }],
          { repo: REPO, runId: 'r02' },
        );
        assert.equal(aliases.length, 0);
        assert.equal(rejected[0]?.reason, 'below-threshold');
      }),
      { numRuns: RUNS },
    );
  });
});

describe('alias resolution always terminates', () => {
  test('any randomized alias graph, cycles included, resolves within the bound', () => {
    const arbIndex = fc.integer({ min: 0, max: 7 });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbIndex, arbIndex, fc.integer({ min: 1, max: 100 })), { maxLength: 24 }),
        (pairs) => {
          const table = new AliasTable();
          for (const [from, to, conf] of pairs) {
            if (from === to) continue;
            const row: AliasRow = {
              from: makeNodeId(REPO, 'File', `f${String(from)}.ts`),
              to: makeNodeId(REPO, 'File', `f${String(to)}.ts`),
              runId: 'r01',
              confidence: conf / 100,
              reason: 'git-rename',
            };
            table.add(row);
          }
          for (let i = 0; i <= 7; i += 1) {
            const r = table.resolve(makeNodeId(REPO, 'File', `f${String(i)}.ts`));
            assert.ok(r.hops <= MAX_ALIAS_CHAIN, `hops ${String(r.hops)} exceeded the bound`);
            assert.ok(['terminal', 'cycle', 'depth'].includes(r.terminatedBy));
            // Resolution is a function of the table, not of the entry point order.
            assert.equal(table.resolve(r.id === r.chain[0] ? r.id : r.chain[0]!).id, r.id);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
