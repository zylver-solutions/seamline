import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bandIndex,
  calibrate,
  clusteredTally,
  detectorStatus,
  strictStat,
  formatRatio,
  headline,
  meetsReleaseBar,
  precision,
  precisionStat,
  rawTally,
  recall,
  wilson95,
} from './metrics.ts';

test('precision is tp over tp+fp, and n/a when nothing was reviewed', () => {
  assert.equal(precision(9, 1), 0.9);
  assert.equal(precision(0, 4), 0);
  assert.equal(precision(5, 0), 1);
  assert.equal(precision(0, 0), null);
});

test('recall is detected over mutants, and n/a when there were no mutants', () => {
  assert.equal(recall(3, 4), 0.75);
  assert.equal(recall(0, 2), 0);
  assert.equal(recall(0, 0), null);
});

test('n/a is printed as n/a and never as zero', () => {
  assert.equal(formatRatio(null), 'n/a');
  assert.equal(formatRatio(0), '0.000');
  assert.equal(formatRatio(2 / 3), '0.667');
});

test('confidence bands: lower bound inclusive, upper exclusive, 1.0 in the last band', () => {
  assert.equal(bandIndex(0), 0);
  assert.equal(bandIndex(0.4999), 0);
  assert.equal(bandIndex(0.5), 1);
  assert.equal(bandIndex(0.6999), 1);
  assert.equal(bandIndex(0.7), 2);
  assert.equal(bandIndex(0.8499), 2);
  assert.equal(bandIndex(0.85), 3);
  assert.equal(bandIndex(1), 3);
});

test('calibration counts labelled findings and observed precision per band', () => {
  const rows = calibrate([
    { confidence: 0.3, verdict: 'fp' },
    { confidence: 0.45, verdict: null },
    { confidence: 0.6, verdict: 'tp' },
    { confidence: 0.65, verdict: 'fp' },
    { confidence: 0.9, verdict: 'tp' },
    { confidence: 1, verdict: 'tp' },
    { confidence: 1, verdict: 'tp' },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.band, r.findings, r.labelled, r.tp, r.fp, r.precision]),
    [
      ['[0.00, 0.50)', 2, 1, 0, 1, 0],
      ['[0.50, 0.70)', 2, 2, 1, 1, 0.5],
      ['[0.70, 0.85)', 0, 0, 0, 0, null],
      ['[0.85, 1.00]', 3, 3, 3, 0, 1],
    ],
  );
  assert.equal(rows[2]?.interval, null);
});

test('the Wilson interval widens when the sample is small', () => {
  assert.equal(wilson95(0, 0), null);
  const small = wilson95(3, 3);
  const large = wilson95(30, 30);
  assert.ok(small !== null && large !== null);
  assert.ok(small.lo < large.lo, 'three of three says less than thirty of thirty');
  assert.equal(small.hi, 1);
  assert.ok(Math.abs(large.lo - 0.886) < 0.005);
});

test('the release bar needs strict precision >= 0.90, a Wilson lower bound >= 0.75, and 30 labelled', () => {
  assert.equal(meetsReleaseBar(27, 3), false, '27 of 30 is 0.90 but its lower bound is about 0.74');
  assert.equal(meetsReleaseBar(28, 2), true, '28 of 30 has a lower bound of about 0.79');
  assert.equal(meetsReleaseBar(26, 4), false, 'below 0.9');
  assert.equal(meetsReleaseBar(29, 0), false, 'perfect but only 29 reviewed');
  assert.equal(meetsReleaseBar(0, 0), false, 'nothing reviewed');
  assert.equal(meetsReleaseBar(28, 1, 1), true, 'unclear counts against: 28 of 30 clusters');
  assert.equal(meetsReleaseBar(27, 0, 3), false, 'three unclear clusters sink 27 of 30');
  assert.equal(meetsReleaseBar(30, 0, 0), true);
});

test('the strict reading keeps unclear in the denominator; the lenient reading leaves it out', () => {
  const t = { tp: 18, fp: 0, unclear: 2, unlabelled: 0 };
  const strict = strictStat(t);
  const lenient = precisionStat(t);
  assert.deepEqual([strict.n, strict.precision], [20, 0.9]);
  assert.deepEqual([lenient.n, lenient.precision], [18, 1]);
  assert.ok(
    (strict.interval?.lo ?? 1) < (lenient.interval?.lo ?? 0),
    'strict is the more cautious',
  );
  assert.deepEqual([strictStat({ tp: 0, fp: 0, unclear: 0, unlabelled: 4 }).precision], [null]);
});

test('a detector with fewer than 5 labelled clusters is unmeasured; with 5 or more it needs 0.80', () => {
  const stat = (tp: number, fp: number, unclear = 0) =>
    strictStat({ tp, fp, unclear, unlabelled: 0 });
  assert.equal(detectorStatus(stat(4, 0)), 'unmeasured', 'perfect, but only 4 clusters');
  assert.equal(detectorStatus(stat(0, 0)), 'unmeasured');
  assert.equal(
    detectorStatus(stat(4, 0, 1)),
    'meets',
    '5 labelled clusters counting the unclear one, 0.80',
  );
  assert.equal(detectorStatus(stat(3, 1, 1)), 'below', '0.60');
  assert.equal(detectorStatus(stat(4, 1)), 'meets', 'exactly 0.80');
});

test('the Wilson interval matches known values', () => {
  const ten = wilson95(10, 10);
  assert.ok(ten !== null && Math.abs(ten.lo - 0.7225) < 1e-3 && ten.hi === 1, JSON.stringify(ten));
  const half = wilson95(5, 10);
  assert.ok(
    half !== null && Math.abs(half.lo - 0.2366) < 1e-3 && Math.abs(half.hi - 0.7634) < 1e-3,
    JSON.stringify(half),
  );
  const zero = wilson95(0, 4);
  assert.ok(
    zero !== null && zero.lo === 0 && Math.abs(zero.hi - 0.4899) < 1e-3,
    JSON.stringify(zero),
  );
  assert.equal(wilson95(0, 0), null, 'no sample, no interval');
});

test('precisionStat carries n and an interval, and has neither ratio nor interval at n = 0', () => {
  const s = precisionStat({ tp: 9, fp: 1, unclear: 4, unlabelled: 2 });
  assert.equal(s.n, 10, 'unclear and unlabelled are not in n');
  assert.equal(s.precision, 0.9);
  assert.ok(s.interval !== null && s.interval.lo < 0.9 && s.interval.hi > 0.9);
  const empty = precisionStat({ tp: 0, fp: 0, unclear: 3, unlabelled: 0 });
  assert.deepEqual([empty.n, empty.precision, empty.interval], [0, null, null]);
});

test('a cluster counts once in the clustered tally and every member counts in the raw tally', () => {
  const items = [
    { repo: 'r', verdict: 'tp' as const, cluster: 'one-bug' },
    { repo: 'r', verdict: 'tp' as const, cluster: 'one-bug' },
    { repo: 'r', verdict: 'tp' as const, cluster: 'one-bug' },
    { repo: 'r', verdict: 'fp' as const },
    { repo: 'r', verdict: 'unclear' as const },
    { repo: 'r', verdict: null },
    { repo: 's', verdict: 'tp' as const, cluster: 'one-bug' },
  ];
  assert.deepEqual(rawTally(items), { tp: 4, fp: 1, unclear: 1, unlabelled: 1 });
  assert.deepEqual(clusteredTally(items), { tp: 2, fp: 1, unclear: 1, unlabelled: 1 });
  assert.deepEqual(
    clusteredTally(items.slice().reverse()),
    clusteredTally(items),
    'order does not matter',
  );
});

test('the headline is the sealed clustered strict precision, and is underpowered below 30 labelled', () => {
  const small = headline({ tp: 20, fp: 0, unclear: 0, unlabelled: 0 });
  assert.equal(small.status, 'underpowered');
  assert.equal(small.meetsBar, null, 'no claim either way when underpowered');
  const met = headline({ tp: 28, fp: 2, unclear: 0, unlabelled: 0 });
  assert.deepEqual([met.status, met.meetsBar, met.strict.n], ['powered', true, 30]);
  const unclearCounts = headline({ tp: 28, fp: 0, unclear: 2, unlabelled: 0 });
  assert.deepEqual([unclearCounts.strict.n, unclearCounts.lenient.n], [30, 28]);
  assert.equal(unclearCounts.meetsBar, true, '28 of 30 strict');
  const short = headline({ tp: 25, fp: 5, unclear: 0, unlabelled: 0 });
  assert.deepEqual([short.status, short.meetsBar], ['powered', false]);
  const lowerBound = headline({ tp: 27, fp: 3, unclear: 0, unlabelled: 0 });
  assert.deepEqual([lowerBound.status, lowerBound.meetsBar], ['powered', false]);
});

test('the headline is incomplete while any sealed finding is unlabelled, however many are labelled', () => {
  const h = headline({ tp: 40, fp: 0, unclear: 0, unlabelled: 3 });
  assert.equal(h.status, 'incomplete');
  assert.equal(h.meetsBar, null, 'no figure is claimed over the labelled easy cases');
  assert.equal(h.unlabelled, 3);
  assert.equal(headline({ tp: 40, fp: 0, unclear: 0, unlabelled: 0 }).status, 'powered');
});

test('a burned sealed partition claims nothing, and a failing detector blocks the bar', () => {
  const burned = headline({ tp: 40, fp: 0, unclear: 0, unlabelled: 0 }, { burned: true });
  assert.deepEqual([burned.status, burned.meetsBar], ['burned', null]);
  const blocked = headline(
    { tp: 40, fp: 0, unclear: 0, unlabelled: 0 },
    { detectorsBelow: ['X3_CONSTRAINT'] },
  );
  assert.deepEqual([blocked.status, blocked.meetsBar], ['powered', false]);
});
