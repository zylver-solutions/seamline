/**
 * `unknownWhen`: a detector that cannot answer for a reason other than a scope
 * status (design `docs/design/real-world-inputs.md`, section 5.2, "Mechanism").
 *
 * The fixture detector is shaped like the one row E will give X5: it fires on
 * every `Table`, and it is UNKNOWN when the `Repo` node does not say that no
 * write went unattributed (`untracedWriteCalls`), a count that is absent where
 * the extractor did not measure it. A missing prop is not zero.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nodeId, type GraphView } from '@seamline/ontology';

import { defineDetector, type FindingDraft, type SeamlineDetector } from './detector.ts';
import { graph, type MemoryGraph } from './graph-memory.ts';
import { numProp } from './props.ts';
import { runDetectors, summarize } from './runner.ts';
import { SCOPE_CODE } from './scopes.ts';

const REPO = nodeId('repo', 'Repo', 'repo');

/** A graph with one table, and a `Repo` node carrying `repoProps` (none: no `Repo` node at all). */
function world(
  repoProps?: Readonly<Record<string, number>>,
  scopes: Readonly<Record<string, 'PASS' | 'FAIL' | 'UNAVAILABLE'>> = {},
): MemoryGraph {
  return graph({
    scopes,
    nodes: [
      { kind: 'Table', name: 'users', canonical: 'public.users' },
      ...(repoProps === undefined
        ? []
        : [{ kind: 'Repo' as const, name: 'repo', props: repoProps }]),
    ],
  });
}

function repoCount(g: GraphView, key: string): number | undefined {
  const repo = g.node(REPO);
  return repo === undefined ? undefined : numProp(repo.props, key);
}

interface Probe {
  readonly detector: SeamlineDetector;
  readonly calls: { find: number; unknownWhen: number };
}

/** Fires on every table. `unknownWhen` is the X5 shape: an absent count and a non-zero one are both a reason. */
function probe(options: { readonly hook: boolean }): Probe {
  const calls = { find: 0, unknownWhen: 0 };
  const detector = defineDetector({
    code: 'X5_UNWRITTEN_COLUMN',
    severity: 'medium',
    requiredScopes: [SCOPE_CODE],
    description: 'fixture: fires on every table',
    find(g): ReadonlyArray<FindingDraft> {
      calls.find += 1;
      return g.nodesByKind('Table').map((t) => ({
        left: t.id,
        right: t.id,
        claim: `fixture finding on ${t.name}`,
        leftFact: 'fact',
        rightFact: 'fact',
        viaPath: [],
        confidence: 1,
      }));
    },
    ...(options.hook
      ? {
          unknownWhen(g: GraphView): string | undefined {
            calls.unknownWhen += 1;
            const n = repoCount(g, 'untracedWriteCalls');
            if (n === undefined)
              return 'untracedWriteCalls is absent: the extractor did not measure it';
            return n > 0 ? `${n} write call(s) could not be attributed to a table` : undefined;
          },
        }
      : {}),
  });
  return { detector, calls };
}

function only(g: GraphView, p: Probe) {
  const report = runDetectors(g, [p.detector]);
  const d = report.detectors[0];
  assert.ok(d !== undefined);
  return { report, d };
}

describe('unknownWhen', () => {
  it('a defined reason is UNKNOWN with that text and no findings, though find would fire', () => {
    const control = probe({ hook: false });
    assert.equal(
      only(world({ untracedWriteCalls: 2 }), control).d.outcome,
      'fired',
      'the graph fires without the hook',
    );

    const p = probe({ hook: true });
    const { report, d } = only(world({ untracedWriteCalls: 2 }), p);
    assert.equal(d.outcome, 'unknown');
    assert.equal(d.findings.length, 0);
    assert.equal(report.findings.length, 0);
    assert.equal(d.result.known, false);
    if (!d.result.known) {
      assert.equal(d.result.reason, '2 write call(s) could not be attributed to a table');
      assert.deepEqual(d.result.scopes, []);
    }
    assert.deepEqual(d.blockedScopes, []);
    assert.deepEqual(d.notes, []);
    assert.equal(
      p.calls.find,
      0,
      'find is never asked once the detector has said it cannot answer',
    );
    assert.deepEqual(report.counts, { fired: 0, clean: 0, unknown: 1 });
    assert.deepEqual(
      report.blockedScopes,
      [],
      'a detector UNKNOWN for its own reason blocks no scope',
    );
  });

  it('returning undefined leaves the detector exactly as it was', () => {
    const plain = probe({ hook: false });
    const hooked = probe({ hook: true });
    const g = world({ untracedWriteCalls: 0 });
    const a = only(g, plain);
    const b = only(g, hooked);
    assert.equal(b.d.outcome, 'fired');
    assert.deepEqual(b.d.findings, a.d.findings);
    assert.deepEqual(b.d.result, a.d.result);
    assert.ok(hooked.calls.unknownWhen > 0, 'the hook was asked, and had nothing to say');
  });

  it('a prop that is absent is a reason, not a zero', () => {
    for (const g of [world(), world({})]) {
      const { d } = only(g, probe({ hook: true }));
      assert.equal(d.outcome, 'unknown');
      assert.equal(d.result.known, false);
      if (!d.result.known) assert.match(d.result.reason, /untracedWriteCalls is absent/);
    }
  });

  it('a scope that is not PASS keeps its own reason and the hook is not asked', () => {
    for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
      const p = probe({ hook: true });
      const { report, d } = only(world({ untracedWriteCalls: 2 }, { [SCOPE_CODE]: status }), p);
      assert.equal(d.outcome, 'unknown');
      assert.equal(d.result.known, false);
      if (!d.result.known) {
        assert.match(d.result.reason, new RegExp(`${SCOPE_CODE}=${status}`));
        assert.deepEqual(d.result.scopes, [SCOPE_CODE]);
      }
      assert.deepEqual(d.blockedScopes, [SCOPE_CODE]);
      assert.deepEqual(report.blockedScopes, [{ scope: SCOPE_CODE, status }]);
      assert.equal(p.calls.unknownWhen, 0);
    }
  });

  it('a caller that reaches past the runner still gets no finding', () => {
    const p = probe({ hook: true });
    assert.deepEqual(p.detector.detect(world({ untracedWriteCalls: 1 })), []);
    assert.equal(p.calls.find, 0);
    assert.equal(
      p.detector.detect(world({ untracedWriteCalls: 0 })).length,
      1,
      'and without a reason it speaks',
    );
    assert.equal(p.calls.find, 1);
  });

  it('notes are withheld from a detector that is UNKNOWN for its own reason', () => {
    const detector = defineDetector({
      code: 'X5_UNWRITTEN_COLUMN',
      severity: 'medium',
      requiredScopes: [SCOPE_CODE],
      description: 'fixture',
      find: () => [],
      unknownWhen: () => 'not measured',
      notes: () => ['a note that would mislead beside an UNKNOWN'],
    });
    assert.deepEqual(detector.notes(world({})), []);
    assert.equal(detector.unknownReason(world({})), 'not measured');
  });

  it('an empty reason is still UNKNOWN, and says so', () => {
    const detector = defineDetector({
      code: 'X5_UNWRITTEN_COLUMN',
      severity: 'medium',
      requiredScopes: [SCOPE_CODE],
      description: 'fixture',
      find: () => {
        throw new Error('find must not run');
      },
      unknownWhen: () => '',
    });
    const report = runDetectors(world({}), [detector]);
    const d = report.detectors[0];
    assert.equal(d?.outcome, 'unknown');
    assert.equal(d?.result.known, false);
    if (d !== undefined && !d.result.known)
      assert.match(d.result.reason, /without stating a reason/);
  });

  it('a non-string return (null, a cast) is UNKNOWN with the stand-in, not a throw and not a pass', () => {
    for (const bad of [null, false, 0, {}]) {
      const detector = defineDetector({
        code: 'X5_UNWRITTEN_COLUMN',
        severity: 'medium',
        requiredScopes: [SCOPE_CODE],
        description: 'fixture',
        find: () => {
          throw new Error('find must not run');
        },
        unknownWhen: (() => bad) as unknown as () => string | undefined,
      });
      const report = runDetectors(world({}), [detector]);
      const d = report.detectors[0];
      assert.equal(d?.outcome, 'unknown', `${JSON.stringify(bad)}`);
      assert.deepEqual(report.findings, []);
      if (d !== undefined && !d.result.known)
        assert.match(d.result.reason, /without stating a reason/);
      assert.deepEqual(detector.detect(world({})), []);
    }
  });

  it('the summary line carries the reason, and a detector without the hook is unchanged beside it', () => {
    const lines = summarize(
      runDetectors(world({ untracedWriteCalls: 3 }), [probe({ hook: true }).detector]),
    );
    assert.deepEqual(lines, [
      'X5_UNWRITTEN_COLUMN  UNKNOWN  3 write call(s) could not be attributed to a table',
    ]);
  });
});

describe('unknownWhen beside absenceOfCode: both UNKNOWN causes work on one detector', () => {
  /** An absence-based detector that also reads a fact of its own. */
  function both(): { detector: SeamlineDetector; calls: { find: number } } {
    const calls = { find: 0 };
    const detector = defineDetector({
      code: 'X5_UNWRITTEN_COLUMN',
      severity: 'medium',
      requiredScopes: [SCOPE_CODE],
      absenceOfCode: true,
      description: 'fixture: absence-based, with an own reason',
      find(g): ReadonlyArray<FindingDraft> {
        calls.find += 1;
        return g.nodesByKind('Table').map((t) => ({
          left: t.id,
          right: t.id,
          claim: 'fixture finding',
          leftFact: 'fact',
          rightFact: 'fact',
          viaPath: [],
          confidence: 1,
        }));
      },
      unknownWhen: (g) => {
        const n = repoCount(g, 'untracedWriteCalls');
        return n !== undefined && n > 0 ? `${n} write call(s) could not be attributed` : undefined;
      },
    });
    return { detector, calls };
  }

  it('fires when neither cause applies', () => {
    const { detector, calls } = both();
    const report = runDetectors(world({ untracedWriteCalls: 0 }), [detector]);
    assert.equal(report.detectors[0]?.outcome, 'fired');
    assert.equal(calls.find, 1);
  });

  it('an unread package is UNKNOWN with its count, and no finding is produced', () => {
    const { detector, calls } = both();
    const g = world({ untracedWriteCalls: 0, unreadCodePackageCount: 2 });
    const d = runDetectors(g, [detector]).detectors[0];
    assert.equal(d?.outcome, 'unknown');
    assert.equal(d?.unreadCodePackages, 2);
    assert.deepEqual(d?.blockedScopes, []);
    assert.deepEqual(detector.detect(g), []);
    assert.equal(calls.find, 0);
  });

  it('the own reason alone is UNKNOWN with no count, and its text is the detector reason', () => {
    const { detector, calls } = both();
    const g = world({ untracedWriteCalls: 3 });
    const d = runDetectors(g, [detector]).detectors[0];
    assert.equal(d?.outcome, 'unknown');
    assert.equal(d?.unreadCodePackages, undefined);
    assert.deepEqual(d?.blockedScopes, []);
    if (d !== undefined && !d.result.known)
      assert.equal(d.result.reason, '3 write call(s) could not be attributed');
    assert.deepEqual(detector.detect(g), []);
    assert.equal(calls.find, 0);
  });

  it('a blocked scope wins over both: its reason, its scopes, no count', () => {
    const { detector } = both();
    const g = world({ untracedWriteCalls: 3, unreadCodePackageCount: 2 }, { [SCOPE_CODE]: 'FAIL' });
    const d = runDetectors(g, [detector]).detectors[0];
    assert.equal(d?.outcome, 'unknown');
    assert.deepEqual(d?.blockedScopes, [SCOPE_CODE]);
    assert.equal(d?.unreadCodePackages, undefined);
    if (d !== undefined && !d.result.known) assert.match(d.result.reason, /^SCOPE_NOT_PASS/);
  });
});
