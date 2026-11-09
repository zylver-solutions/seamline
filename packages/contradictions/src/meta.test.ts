/**
 * The meta-test (v3 section 5, section 7).
 *
 * Every code in `CONTRADICTION_CODES` must have both a fixture that fires it
 * and a fixture that does not, and both must behave as claimed. This is what
 * makes a vacuous detector visible: one that can never fire and one that always
 * fires both pass a one-sided test, and neither passes this.
 *
 * It is driven off `CONTRADICTION_CODES` from the contract rather than off the
 * detector list, so adding a code to the ontology without implementing or
 * testing it fails here rather than shipping silently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTRADICTION_CODES, parseNodeId } from '@seamline/ontology';

import { ALL_DETECTORS, DETECTORS_BY_CODE } from './detectors/index.ts';
import { FIXTURES } from './fixtures.ts';
import { runDetectors } from './runner.ts';

describe('meta: every contradiction code is implemented and non-vacuous', () => {
  it('every code in CONTRADICTION_CODES has a detector', () => {
    const missing = CONTRADICTION_CODES.filter((c) => !DETECTORS_BY_CODE.has(c));
    assert.deepEqual(missing, [], `codes with no detector: ${missing.join(', ')}`);
    assert.equal(ALL_DETECTORS.length, CONTRADICTION_CODES.length);
  });

  it('every code has both a firing and a non-firing fixture', () => {
    const missing = CONTRADICTION_CODES.filter((c) => {
      const f = FIXTURES[c];
      return f === undefined || typeof f.firing !== 'function' || typeof f.clean !== 'function';
    });
    assert.deepEqual(missing, [], `codes with an incomplete fixture pair: ${missing.join(', ')}`);
  });

  for (const code of CONTRADICTION_CODES) {
    describe(code, () => {
      const fixture = FIXTURES[code];

      it(`fires: ${fixture.firingClaim}`, () => {
        const report = runDetectors(fixture.firing(), undefined, fixture.currentObservation);
        const mine = report.detectors.find((d) => d.code === code);
        assert.ok(mine !== undefined);
        assert.equal(
          mine.outcome,
          'fired',
          `${code} did not fire on its firing fixture (outcome ${mine.outcome})`,
        );
        assert.ok(mine.findings.length > 0);
        for (const f of mine.findings) {
          assert.equal(f.code, code);
          assert.ok(f.claim.length > 0, 'a finding must state what disagrees');
          assert.ok(f.leftFact.length > 0 && f.rightFact.length > 0, 'a finding must cite both facts');
          assert.ok(f.confidence > 0 && f.confidence <= 1);
        }
      });

      it('no finding endpoint is a File id', () => {
        // A File id is its repo-relative path (ADR-0016), so it changes when the
        // file moves. A finding id is a hash of `left` and `right`, so an endpoint
        // that was a File id would change the finding's id on a rename.
        const { findings } = runDetectors(fixture.firing(), undefined, fixture.currentObservation);
        assert.ok(findings.length > 0);
        for (const f of findings) {
          assert.notEqual(parseNodeId(f.left).kind, 'File', `${f.code} left is ${f.left}`);
          assert.notEqual(parseNodeId(f.right).kind, 'File', `${f.code} right is ${f.right}`);
        }
      });

      it(`does not fire once ${fixture.cleanedBy}`, () => {
        const report = runDetectors(fixture.clean(), undefined, fixture.currentObservation);
        const mine = report.detectors.find((d) => d.code === code);
        assert.ok(mine !== undefined);
        assert.equal(
          mine.outcome,
          'clean',
          `${code} still fired after the disagreeing fact was corrected: ${mine.findings
            .map((f) => f.claim)
            .join(' | ')}`,
        );
        assert.equal(mine.findings.length, 0);
      });

      it('the pair differs only in the detector under test', () => {
        const firing = runDetectors(fixture.firing(), undefined, fixture.currentObservation).findings.map((f) => f.code);
        const clean = runDetectors(fixture.clean(), undefined, fixture.currentObservation).findings.map((f) => f.code);
        assert.ok(firing.includes(code));
        assert.ok(!clean.includes(code));
        // Other detectors may legitimately be silent, but they must not flip
        // between the two graphs: a fixture that changes one fact must change
        // one detector's answer, or the pair proves nothing about this code.
        const others = new Set([...firing, ...clean].filter((c) => c !== code));
        for (const other of others) {
          assert.equal(
            firing.includes(other),
            clean.includes(other),
            `${other} changed answer between the two ${code} fixtures, so the pair is not isolating ${code}`,
          );
        }
      });
    });
  }
});
