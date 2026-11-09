import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  claimSetDigest,
  decide,
  factDigest,
  resolvedBy,
  resolvesDrift,
  type Standing,
} from './classify.ts';
import {
  PROBE_COMPLETENESS,
  absent,
  different,
  holds,
  unknownFact,
  type ClaimKind,
  type Polarity,
  type ProbeFact,
} from './types.ts';

const POLARITIES: Polarity[] = ['AFFIRM', 'DEFERRED', 'ABSENT'];
const subsets = (): Set<Polarity>[] => {
  const out: Set<Polarity>[] = [];
  for (let mask = 0; mask < 8; mask += 1)
    out.push(new Set(POLARITIES.filter((_, i) => (mask >> i) & 1)));
  return out;
};
const FACTS: Record<string, ProbeFact> = {
  HOLDS: holds(true, ''),
  DIFFERENT: different('1.0.0', ''),
  ABSENT: absent(''),
  UNKNOWN: unknownFact('scope-not-pass', ''),
};

/** The table of section 6 written as rows, tried in order: the first match gives the standing result. */
function oracle(claims: Set<Polarity>, result: string, exact: boolean): string {
  const A = claims.has('AFFIRM');
  const D = claims.has('DEFERRED');
  const X = claims.has('ABSENT');
  const rows: [string, boolean, string][] = [
    ['D1', result === 'UNKNOWN', 'Unknown'],
    ['D2', A && result === 'DIFFERENT', 'Observed drift'],
    ['D3', A && !D && result === 'ABSENT', 'Unexplained gap'],
    ['D4', A && D && result === 'ABSENT', 'Planned gap'],
    ['D5', D && !A && result === 'ABSENT', 'Planned gap'],
    ['D6', (claims.size === 0 || (A && !D && !X)) && result === 'HOLDS', 'aligned'],
    ['D7', D && result === 'HOLDS', exact ? 'Observed drift' : 'Unknown'],
    ['D8', X && !D && result === 'HOLDS', exact ? 'Observed drift' : 'Unknown'],
    ['D9', X && !A && !D && result === 'ABSENT', 'aligned'],
    ['D10', claims.size === 0 && (result === 'ABSENT' || result === 'DIFFERENT'), 'nothing'],
  ];
  return rows.find((r) => r[1])?.[2] ?? 'Unknown';
}

function label(s: Standing): string {
  return s.kind === 'class' ? s.class : s.kind;
}

describe('decision table (6): every combination, against the table written as rows', () => {
  for (const kind of [
    'RUNTIME_FLOOR',
    'OUTPUT_FORMAT_SET',
    'DETECTOR_LIVENESS',
    'CONTROL_ENFORCEMENT',
  ] as ClaimKind[]) {
    test(`${kind}: all 8 polarity sets against all 4 facts`, () => {
      const exact =
        PROBE_COMPLETENESS[
          kind === 'RUNTIME_FLOOR'
            ? 'manifest-field'
            : kind === 'OUTPUT_FORMAT_SET'
              ? 'format-witness'
              : kind === 'DETECTOR_LIVENESS'
                ? 'detector-liveness'
                : 'module-wiring'
        ] === 'exact';
      for (const claims of subsets()) {
        for (const [name, fact] of Object.entries(FACTS)) {
          assert.equal(
            label(decide(kind, claims, fact)),
            oracle(claims, name, exact),
            `${kind} [${[...claims].join(',')}] x ${name}`,
          );
        }
      }
    });
  }

  test('a subject with no probe result is nothing', () => {
    assert.equal(decide('RUNTIME_FLOOR', new Set(), null).kind, 'nothing');
  });

  test('the reasons: value-mismatch, absent-in-implementation, deferred-and-absent, cannot-confirm-presence', () => {
    const reason = (
      c: Polarity[],
      f: ProbeFact,
      kind: ClaimKind = 'OUTPUT_FORMAT_SET',
    ): string | undefined => {
      const s = decide(kind, new Set(c), f);
      return s.kind === 'class' ? s.reason : undefined;
    };
    assert.equal(reason(['AFFIRM'], FACTS['DIFFERENT']!, 'RUNTIME_FLOOR'), 'value-mismatch');
    assert.equal(reason(['AFFIRM'], FACTS['ABSENT']!), 'absent-in-implementation');
    assert.equal(reason(['AFFIRM', 'DEFERRED'], FACTS['ABSENT']!), 'deferred-and-absent');
    assert.equal(reason(['DEFERRED'], FACTS['ABSENT']!), 'deferred-and-absent');
    assert.equal(reason(['DEFERRED'], FACTS['HOLDS']!), 'cannot-confirm-presence');
    assert.equal(reason(['ABSENT'], FACTS['HOLDS']!), 'cannot-confirm-presence');
    assert.equal(reason(['AFFIRM'], unknownFact('limit-exceeded', '')), 'limit-exceeded');
  });

  test('D11 guards a combination no row covers and says which: a DIFFERENT fact against markers only', () => {
    const s = decide('RUNTIME_FLOOR', new Set<Polarity>(['DEFERRED']), FACTS['DIFFERENT']!);
    assert.equal(s.kind === 'class' && s.class, 'Unknown');
    assert.equal(s.kind === 'class' && s.reason, 'probe-failed');
    assert.match(s.kind === 'class' ? (s.detail ?? '') : '', /DEFERRED/);
  });

  test('stale-deferral and stale-absence are drift only under an exact probe, which carries no markers in v1', () => {
    assert.deepEqual(decide('RUNTIME_FLOOR', new Set<Polarity>(['DEFERRED']), FACTS['HOLDS']!), {
      kind: 'class',
      class: 'Observed drift',
      reason: 'stale-deferral',
    });
    assert.deepEqual(decide('RUNTIME_FLOOR', new Set<Polarity>(['ABSENT']), FACTS['HOLDS']!), {
      kind: 'class',
      class: 'Observed drift',
      reason: 'stale-absence',
    });
    assert.equal(
      label(decide('OUTPUT_FORMAT_SET', new Set<Polarity>(['DEFERRED']), FACTS['HOLDS']!)),
      'Unknown',
    );
  });

  test('no combination of claims against any fact classifies code that no document mentions (D10)', () => {
    for (const name of ['ABSENT', 'DIFFERENT']) {
      assert.equal(decide('OUTPUT_FORMAT_SET', new Set(), FACTS[name]!).kind, 'nothing');
    }
  });

  test('only a probe that can see absence reports a gap: a presence-only probe fact never carries ABSENT, so a control is aligned or Unknown', () => {
    // module-wiring has no ABSENT result (4.4): its facts are HOLDS or UNKNOWN, which decide() maps to aligned or Unknown only.
    for (const claims of subsets()) {
      for (const fact of [FACTS['HOLDS']!, FACTS['UNKNOWN']!]) {
        const standing = decide('CONTROL_ENFORCEMENT', claims, fact);
        const klass = label(standing);
        assert.ok(
          ['aligned', 'nothing', 'Unknown', 'Observed drift'].includes(klass) &&
            klass !== 'Unexplained gap' &&
            klass !== 'Planned gap',
        );
      }
    }
  });
});

describe('digests (7)', () => {
  test('the claim-set digest is the SHA-256 of the sorted claim digests joined by LF, or null', () => {
    assert.equal(claimSetDigest([]), null);
    assert.equal(
      claimSetDigest(['sha256:b', 'sha256:a']),
      claimSetDigest(['sha256:a', 'sha256:b']),
    );
    assert.notEqual(claimSetDigest(['sha256:a']), claimSetDigest(['sha256:a', 'sha256:a']));
  });

  test('the fact digest leaves HOLDS and DIFFERENT out and keeps ABSENT and UNKNOWN', () => {
    const k: ClaimKind = 'RUNTIME_FLOOR';
    assert.equal(factDigest(k, holds('1.0.0', 'one')), factDigest(k, different('1.0.0', 'two')));
    assert.notEqual(factDigest(k, holds('1.0.0', '')), factDigest(k, holds('1.0.1', '')));
    assert.notEqual(factDigest(k, absent('')), factDigest(k, holds(null, '')));
    assert.notEqual(factDigest(k, absent('')), factDigest(k, unknownFact('scope-not-pass', '')));
    assert.equal(factDigest(k, absent('a detail')), factDigest(k, absent('another detail')));
    assert.equal(factDigest(k, null), null);
  });
});

describe('Resolved (7)', () => {
  const aligned: Standing = { kind: 'aligned' };
  const planned: Standing = { kind: 'class', class: 'Planned gap', reason: 'deferred-and-absent' };
  const base = {
    baselineClaimDigest: 'c1',
    baselineFactDigest: 'f1',
    headClaimDigest: 'c1',
    headFactDigest: 'f1',
    headHasClaims: true,
  };

  test('row R: resolved when aligned, a Planned gap or nothing, and never when Unknown, drift or a gap', () => {
    assert.equal(resolvesDrift(aligned), true);
    assert.equal(resolvesDrift({ kind: 'nothing' }), true);
    assert.equal(resolvesDrift(planned), true);
    for (const c of ['Unknown', 'Observed drift', 'Unexplained gap'] as const) {
      assert.equal(resolvesDrift({ kind: 'class', class: c, reason: 'x' }), false, c);
    }
  });

  test('the conditions are checked in order: explained, claim-removed, then the three digest rows', () => {
    assert.equal(resolvedBy({ ...base, headStanding: planned, headHasClaims: false }), 'explained');
    assert.equal(
      resolvedBy({ ...base, headStanding: aligned, headHasClaims: false }),
      'claim-removed',
    );
    assert.equal(
      resolvedBy({ ...base, headStanding: aligned, headClaimDigest: 'c2' }),
      'claim-corrected',
    );
    assert.equal(
      resolvedBy({ ...base, headStanding: aligned, headFactDigest: 'f2' }),
      'fact-changed',
    );
    assert.equal(
      resolvedBy({ ...base, headStanding: aligned, headClaimDigest: 'c2', headFactDigest: 'f2' }),
      'claim-and-fact-changed',
    );
  });

  test('nothing moved yet the standing result changed: no resolution is claimed that cannot be explained', () => {
    assert.equal(resolvedBy({ ...base, headStanding: aligned }), null);
  });
});
