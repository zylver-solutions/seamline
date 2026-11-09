import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ExtractorResult, ExtractorStatus, GraphView, RunRecord } from '@seamline/ontology';

import { describeNarrowedClaim, narrowedClaims } from './claim-coverage.ts';

const PARTIAL = (n: number): string =>
  `CONTRACTS_PARTIAL_COVERAGE: ${n} file(s) are outside the authoritative claim; contracts they declare are neither emitted nor tombstoned by this run`;

function result(
  extractor: string,
  scope: string,
  opts: { status?: ExtractorStatus; selector?: string; diagnostics?: string[] } = {},
): ExtractorResult {
  return {
    extractor,
    version: '0.0.1',
    status: opts.status ?? 'PASS',
    authoritative: [
      { scope, kinds: [], ...(opts.selector === undefined ? {} : { selector: opts.selector }) },
    ],
    nodeCount: 0,
    edgeCount: 0,
    durationMs: 0,
    diagnostics: opts.diagnostics ?? [],
  };
}

function run(...results: ExtractorResult[]): RunRecord {
  return {
    runId: 'run-1',
    repo: 'demo',
    commit: null,
    startedAt: '1970-01-01T00:00:00.000Z',
    finishedAt: '1970-01-01T00:00:01.000Z',
    ontologyVersion: '1.0.0',
    results,
  };
}

const view = (status: Record<string, ExtractorStatus> = {}): GraphView =>
  ({ scopeStatus: (scope: string) => status[scope] ?? 'PASS' }) as unknown as GraphView;

describe('narrowedClaims', () => {
  test('a PASS claim with a selector and a partial-coverage diagnostic is reported with the extractor count', () => {
    const found = narrowedClaims(
      view(),
      run(
        result('extract-contracts', 'contracts', {
          selector: 'src/**',
          diagnostics: [PARTIAL(11)],
        }),
      ),
    );
    assert.deepEqual(found, [
      { scope: 'contracts', extractor: 'extract-contracts', filesNotRead: 11 },
    ]);
    assert.match(
      describeNarrowedClaim(found[0] as (typeof found)[number]),
      /11 file\(s\) not read/,
    );
  });

  test('a claim read in full reports nothing, whatever the diagnostics say about other things', () => {
    assert.deepEqual(narrowedClaims(view(), run(result('extract-contracts', 'contracts'))), []);
    assert.deepEqual(
      narrowedClaims(
        view(),
        run(result('extract-contracts', 'contracts', { diagnostics: ['ZOD_UNSUPPORTED_SHAPE'] })),
      ),
      [],
    );
  });

  test('a diagnostic without a narrowed selector, and a selector without a diagnostic, report nothing', () => {
    assert.deepEqual(
      narrowedClaims(
        view(),
        run(result('extract-contracts', 'contracts', { diagnostics: [PARTIAL(3)] })),
      ),
      [],
    );
    assert.deepEqual(
      narrowedClaims(view(), run(result('extract-code-ts', 'code.ts', { selector: 'src/**' }))),
      [],
    );
  });

  test('a scope that did not PASS is left to the UNKNOWN path', () => {
    const r = run(
      result('extract-contracts', 'contracts', {
        selector: 'src/**',
        diagnostics: [PARTIAL(2)],
        status: 'FAIL',
      }),
    );
    assert.deepEqual(narrowedClaims(view({ contracts: 'FAIL' }), r), []);
    // The store's view wins over the run record.
    assert.deepEqual(
      narrowedClaims(
        view({ contracts: 'UNAVAILABLE' }),
        run(
          result('extract-contracts', 'contracts', {
            selector: 'src/**',
            diagnostics: [PARTIAL(2)],
          }),
        ),
      ),
      [],
    );
  });

  test('no run record reports nothing, and the result is sorted by scope', () => {
    assert.deepEqual(narrowedClaims(view(), undefined), []);
    const found = narrowedClaims(
      view(),
      run(
        result('b-extractor', 'zeta', { selector: 'x/**', diagnostics: [PARTIAL(1)] }),
        result('a-extractor', 'alpha', { selector: 'y/**', diagnostics: [PARTIAL(4)] }),
      ),
    );
    assert.deepEqual(
      found.map((c) => [c.scope, c.filesNotRead]),
      [
        ['alpha', 4],
        ['zeta', 1],
      ],
    );
  });
});
