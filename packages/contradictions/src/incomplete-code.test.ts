/**
 * `code.ts` can PASS while covering only part of a workspace: the extractor
 * names the packages it could not read on the `Repo` node. A detector that
 * concludes something from the **absence** of a code fact (no producer, no
 * writer, no handler, no test) must then report UNKNOWN, because an unread
 * package could supply the missing fact. A detector that compares two present
 * facts is unaffected: an unread package cannot make two facts disagree.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContradictionCode, GraphView } from '@seamline/ontology';

import { FIXTURES } from './fixtures.ts';
import { graph } from './graph-memory.ts';
import { runDetectors } from './runner.ts';

/** `g` with a `Repo` node saying `dirs` were not read, as `extract-code-ts` emits it. */
function withUnreadPackages(g: GraphView, dirs: ReadonlyArray<string>): GraphView {
  const repo = graph({
    nodes: [
      {
        kind: 'Repo',
        name: 'app',
        props: {
          ...g.nodesByKind('Repo')[0]?.props,
          unreadCodePackageCount: dirs.length,
          unreadCodePackages: JSON.stringify(dirs),
        },
      },
    ],
  }).nodesByKind('Repo');
  return {
    nodesByKind: (kind) => (kind === 'Repo' ? repo : g.nodesByKind(kind)),
    node: (id) => repo.find((n) => n.id === id) ?? g.node(id),
    edgesFrom: (id, kind) => g.edgesFrom(id, kind),
    edgesTo: (id, kind) => g.edgesTo(id, kind),
    scopeStatus: (scope) => g.scopeStatus(scope),
  };
}

const ABSENCE_BASED: ReadonlyArray<ContradictionCode> = [
  'X4_UNBACKED_PROPERTY',
  'X5_UNWRITTEN_COLUMN',
  'X9_CONTRACT_DRIFT',
  'X10_UNTESTED_PII_WRITE',
];

describe('an unread workspace package and the detectors that reason from absence', () => {
  for (const code of ABSENCE_BASED) {
    it(`${code} fires on its fixture, and is UNKNOWN once a package is unread`, () => {
      const fixture = FIXTURES[code];

      const whole = runDetectors(fixture.firing()).detectors.find((d) => d.code === code);
      assert.equal(whole?.outcome, 'fired', 'the control must fire, or this proves nothing');

      const partial = runDetectors(
        withUnreadPackages(fixture.firing(), ['packages/mobile']),
      ).detectors.find((d) => d.code === code);
      assert.equal(partial?.outcome, 'unknown');
      assert.equal(partial?.findings.length, 0);
      assert.equal(partial?.result.known, false);
      if (partial !== undefined && !partial.result.known) {
        assert.match(
          partial.result.reason,
          /did not read 1 workspace package\(s\) \(packages\/mobile\)/,
        );
      }
    });
  }

  it('a directory name holding a comma is one name, and the report carries the exact count', () => {
    const report = runDetectors(withUnreadPackages(FIXTURES['X5_UNWRITTEN_COLUMN'].firing(), ['packages/a,b']));
    const x5 = report.detectors.find((d) => d.code === 'X5_UNWRITTEN_COLUMN');
    assert.equal(x5?.outcome, 'unknown');
    assert.equal(x5?.unreadCodePackages, 1);
    if (x5 !== undefined && !x5.result.known) {
      assert.match(x5.result.reason, /did not read 1 workspace package\(s\) \(packages\/a,b\)/);
    }
  });

  it('a count beyond the names listed is said to be more than the names shown', () => {
    const many = Array.from({ length: 30 }, (_, i) => `packages/p${String(i).padStart(2, '0')}`);
    const g = FIXTURES['X5_UNWRITTEN_COLUMN'].firing();
    const repo = graph({
      nodes: [
        {
          kind: 'Repo',
          name: 'app',
          props: { unreadCodePackageCount: 30, unreadCodePackages: JSON.stringify(many.slice(0, 25)) },
        },
      ],
    }).nodesByKind('Repo');
    const partial: GraphView = {
      nodesByKind: (kind) => (kind === 'Repo' ? repo : g.nodesByKind(kind)),
      node: (id) => repo.find((n) => n.id === id) ?? g.node(id),
      edgesFrom: (id, kind) => g.edgesFrom(id, kind),
      edgesTo: (id, kind) => g.edgesTo(id, kind),
      scopeStatus: (scope) => g.scopeStatus(scope),
    };
    const x5 = runDetectors(partial).detectors.find((d) => d.code === 'X5_UNWRITTEN_COLUMN');
    assert.equal(x5?.unreadCodePackages, 30);
    if (x5 !== undefined && !x5.result.known) {
      assert.match(x5.result.reason, /did not read 30 workspace package\(s\) \(.*, \.\.\.\)/);
    }
  });

  it('detectors that compare two present facts keep reporting', () => {
    for (const code of [
      'X1_NULLABILITY',
      'X2_TYPE',
      'X3_CONSTRAINT',
      'X6_PII_UNAUTHENTICATED',
      'X7_VALIDATOR_DIVERGENCE',
    ] as const) {
      const partial = runDetectors(
        withUnreadPackages(FIXTURES[code].firing(), ['packages/mobile', 'docs']),
        undefined,
        FIXTURES[code].currentObservation,
      ).detectors.find((d) => d.code === code);
      assert.equal(partial?.outcome, 'fired', `${code} compares facts that were read`);
    }
  });

  it('a graph that names no unread package is judged as before', () => {
    for (const code of ABSENCE_BASED) {
      const report = runDetectors(withUnreadPackages(FIXTURES[code].firing(), []));
      assert.equal(report.detectors.find((d) => d.code === code)?.outcome, 'fired', code);
    }
  });
});
