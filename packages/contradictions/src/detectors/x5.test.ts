/**
 * X5 reports a NOT NULL column that no traced insert supplies, and only where
 * the extractors saw the write paths (docs/design/real-world-inputs.md, 5.1 and
 * 5.2). Every case is a pair: the graph that fires and the one fact changed to
 * make it silent, withheld or UNKNOWN. The graphs come from `x5Spec`, whose
 * options each change one fact.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { x5Spec, type X5Options } from '../fixtures.ts';
import { graph, type GraphSpec } from '../graph-memory.ts';
import { runDetectors } from '../runner.ts';
import { SCOPE_CODE, SCOPE_DATA } from '../scopes.ts';

const CODE = 'X5_UNWRITTEN_COLUMN';

function report(spec: GraphSpec) {
  const d = runDetectors(graph(spec)).detectors.find((x) => x.code === CODE);
  assert.ok(d !== undefined);
  return d;
}

const fired = (o: X5Options): boolean => report(x5Spec(o)).outcome === 'fired';

describe('X5 requires fact insert assertions and column membership', () => {
  it('fires with EXTRACTED or DECLARED assertions', () => {
    for (const provenance of ['EXTRACTED', 'DECLARED'] as const) {
      const spec = x5Spec();
      const d = report({ ...spec, edges: (spec.edges ?? []).map((e) => ({ ...e, provenance })) });
      assert.equal(d.outcome, 'fired', provenance);
      assert.equal(d.findings.length, 1);
    }
  });

  for (const kind of ['QUERIES', 'CONTAINS'] as const) {
    for (const provenance of ['INFERRED', 'LLM_SUGGESTED'] as const) {
      it(`does not derive an omission from a ${provenance} ${kind} assertion`, () => {
        const spec = x5Spec();
        const d = report({
          ...spec,
          edges: (spec.edges ?? []).map((e) => e.kind === kind ? { ...e, provenance } : e),
        });
        assert.equal(d.outcome, 'clean');
        assert.deepEqual(d.findings, []);
      });
    }
  }

  it('withholds a fact insert whose writer node is inferred', () => {
    const spec = x5Spec();
    const d = report({
      ...spec,
      nodes: spec.nodes.map((n) => n.kind === 'Symbol' ? { ...n, provenance: 'INFERRED' } : n),
    });
    assert.equal(d.outcome, 'clean');
    assert.deepEqual(d.findings, []);
    assert.deepEqual(d.notes, [
      'table accounts was not evaluated: an insert assertion or its writer is not a fact',
    ]);
  });

  it('withholds a table rather than discarding a non-fact writer that may supply the column', () => {
    const spec = x5Spec({ second: {
      operation: 'insert', insertColumns: 'id,label,tenant_id', insertComplete: true,
    } });
    let writer = 0;
    const d = report({
      ...spec,
      edges: (spec.edges ?? []).map((e) => e.kind === 'QUERIES' && ++writer === 2
        ? { ...e, provenance: 'INFERRED' } : e),
    });
    assert.equal(d.outcome, 'clean');
    assert.deepEqual(d.findings, []);
    assert.deepEqual(d.notes, [
      'table accounts was not evaluated: an insert assertion or its writer is not a fact',
    ]);
  });
});

function reason(o: X5Options): string {
  const d = report(x5Spec(o));
  assert.equal(d.outcome, 'unknown');
  return d.result.known ? '' : d.result.reason;
}

describe('X5 reads inserts only (5.1 item 1)', () => {
  it('fires on an insert that omits a NOT NULL column with no default', () => {
    const d = report(x5Spec());
    assert.equal(d.outcome, 'fired');
    assert.equal(d.findings.length, 1);
    assert.match(d.findings[0]!.claim, /^accounts\.tenant_id is NOT NULL and has no default/u);
  });

  it('reports the insert edge source reference as the witness location', () => {
    const d = report(x5Spec());
    assert.equal(d.outcome, 'fired');
    assert.match(
      d.findings[0]!.rightFact,
      /^createAccount inserts into accounts columns \[id, label\] \(src\/repo\/accounts\.ts:19\)$/u,
    );
  });

  it('is silent on an update that does not set the column', () => {
    const d = report(
      x5Spec({ operation: 'update', insertColumns: undefined, insertComplete: undefined }),
    );
    assert.equal(d.outcome, 'clean');
    assert.deepEqual(d.notes, []);
  });

  it('is silent when the only statement is a delete or a select', () => {
    for (const operation of ['delete', 'select']) {
      assert.equal(
        fired({ operation, insertColumns: undefined, insertComplete: undefined }),
        false,
        operation,
      );
    }
  });

  it('is silent when the insert names the column', () => {
    assert.equal(fired({ insertColumns: 'id,label,tenant_id' }), false);
  });

  it('reads the insert half of an upsert, and ignores the update columns of an edge that has both', () => {
    assert.equal(fired({ operation: 'upsert' }), true);
    // An insert plus an update from another symbol: the update changes nothing about the insert.
    assert.equal(
      fired({ second: { operation: 'update' } }),
      true,
      'an update beside the insert does not supply the column',
    );
  });
});

describe('an insert edge with no insertComplete is incomplete (5.1 items 2 and 3)', () => {
  it('silences the table, and names it in the notes', () => {
    const d = report(x5Spec({ insertComplete: undefined, insertColumns: undefined }));
    assert.equal(d.outcome, 'clean');
    assert.deepEqual(d.notes, [
      'table accounts was not evaluated: an insert into it has no complete column list',
    ]);
  });

  it('silences the table when insertComplete is false', () => {
    assert.equal(fired({ insertComplete: false }), false);
  });

  it('one incomplete insert among complete ones silences the table', () => {
    assert.equal(
      fired({ second: { operation: 'insert', insertColumns: 'id', insertComplete: false } }),
      false,
    );
    assert.equal(
      fired({ second: { operation: 'insert', insertColumns: 'id', insertComplete: true } }),
      true,
      'the same second insert, complete, leaves the table evaluated',
    );
  });

  it('an edge that says nothing about its statements may hold an insert', () => {
    const spec = x5Spec({
      operation: undefined,
      insertColumns: undefined,
      insertComplete: undefined,
    });
    const d = report(spec);
    assert.equal(d.outcome, 'clean');
    assert.equal(d.notes.length, 1);
  });

  it('a complete insert with an empty column list (DEFAULT VALUES) omits every required column', () => {
    assert.equal(fired({ insertColumns: undefined }), true);
  });
});

describe('a default is supplied by the writers it reaches (5.1 item 4, 4.4)', () => {
  it('a database default reaches every writer, raw SQL included', () => {
    assert.equal(fired({ defaultSite: 'db' }), false);
  });

  it('a client-side default is not supplied to a raw insert', () => {
    const d = report(x5Spec({ defaultSite: 'client' }));
    assert.equal(d.outcome, 'fired');
    assert.match(d.findings[0]!.claim, /client-side default, which a raw insert does not receive/u);
  });

  it('a client-side default is supplied by an insert that went through the ORM client', () => {
    assert.equal(fired({ defaultSite: 'client', insertOrm: true }), false);
    assert.equal(
      fired({
        defaultSite: 'client',
        second: { operation: 'insert', insertColumns: 'id', insertComplete: true, insertOrm: true },
      }),
      false,
      'one ORM writer supplies it; the sibling raw insert is the 9.4 recall limit',
    );
  });

  it('an absent defaultSite is unknown, never "no default"', () => {
    assert.equal(fired({ defaultSite: undefined }), false);
  });
});

describe('confidence is the minimum of the contributing insert edges (5.1 item 7)', () => {
  it('a name-only table binding keeps its 0.7', () => {
    const d = report(x5Spec({ confidence: 0.7 }));
    assert.equal(d.findings[0]?.confidence, 0.7);
  });

  it('the weakest of several insert edges governs', () => {
    const d = report(
      x5Spec({
        confidence: 1,
        second: { operation: 'insert', insertColumns: 'id', insertComplete: true, confidence: 0.7 },
      }),
    );
    assert.equal(d.findings[0]?.confidence, 0.7);
  });

  it('an update edge does not lower it', () => {
    const d = report(x5Spec({ second: { operation: 'update', confidence: 0.5 } }));
    assert.equal(d.findings[0]?.confidence, 1);
  });
});

describe('a table is withheld, with a note, when its facts cannot support the claim (5.1 items 6 and 8, 5.2)', () => {
  const noteOf = (o: X5Options): string => {
    const d = report(x5Spec(o));
    assert.equal(d.outcome, 'clean');
    assert.equal(d.notes.length, 1, d.notes.join('|'));
    return d.notes[0] as string;
  };

  it('declarations above one: a union of sources', () => {
    assert.match(
      noteOf({ declarations: 2 }),
      /^table accounts was not evaluated: 2 source files declare it/u,
    );
    assert.equal(fired({ declarations: 1 }), true);
    assert.equal(
      fired({ declarations: 0 }),
      true,
      'declared only by migrations is not a union of declarations',
    );
  });

  it('an absent declarations is unknown, never one declaration', () => {
    assert.match(noteOf({ declarations: undefined }), /declaration count was not recorded/u);
  });

  it('a BEFORE INSERT trigger may supply the column', () => {
    assert.match(noteOf({ insertTrigger: true }), /BEFORE INSERT trigger on it may supply/u);
    assert.equal(fired({ insertTrigger: false }), true);
  });

  it('an absent insertTrigger is unknown, never "no trigger"', () => {
    assert.match(
      noteOf({ insertTrigger: undefined }),
      /BEFORE INSERT trigger supplies its columns was not recorded/u,
    );
  });

  it('a table in unknownWriterTables is withheld, by name without regard to case', () => {
    assert.match(noteOf({ unknownWriterTables: 'accounts' }), /unknownWriterTables/u);
    assert.match(noteOf({ unknownWriterTables: 'audit,Accounts' }), /unknownWriterTables/u);
    assert.equal(
      fired({ unknownWriterTables: 'audit,ledger' }),
      true,
      'another table in the list leaves this one evaluated',
    );
  });

  it('a table with no insert path is not mentioned at all', () => {
    const d = report(
      x5Spec({
        declarations: 2,
        operation: 'select',
        insertColumns: undefined,
        insertComplete: undefined,
      }),
    );
    assert.deepEqual(d.notes, []);
  });
});

describe('X5 is UNKNOWN when the repository-wide facts say a writer was not seen (5.2)', () => {
  it('untracedWriteCalls above zero', () => {
    assert.match(reason({ untracedWriteCalls: 3 }), /untracedWriteCalls is 3/u);
    assert.equal(fired({ untracedWriteCalls: 0 }), true);
  });

  it('writeHooks above zero', () => {
    assert.match(reason({ writeHooks: 1 }), /writeHooks is 1/u);
  });

  it('dynamicDdl above zero', () => {
    assert.match(reason({ dynamicDdl: 2 }), /dynamicDdl is 2/u);
  });

  it('runtime DDL blocks default-absence findings; absent or withheld measurement is not zero', () => {
    assert.match(reason({ runtimeDdl: 1 }), /runtimeDdl is 1/u);
    assert.match(reason({ runtimeDdl: undefined }), /runtimeDdl is absent on Repo/u);
    assert.match(reason({ runtimeDdl: -1 }), /runtimeDdl is invalid on Repo/u);
    assert.match(reason({ runtimeDdl: 0.5 }), /runtimeDdl is invalid on Repo/u);
    assert.equal(fired({ runtimeDdl: 0 }), true);
  });

  it('a missing prop is not zero: each absent count names itself', () => {
    assert.match(
      reason({ untracedWriteCalls: undefined }),
      /untracedWriteCalls is absent on Repo/u,
    );
    assert.match(reason({ writeHooks: undefined }), /writeHooks is absent on Repo/u);
    assert.match(reason({ dynamicDdl: undefined }), /dynamicDdl is absent on DataSource/u);
  });

  it('an unmeasured unknownWriterTables is not an empty list', () => {
    assert.match(reason({ unknownWriterTables: undefined }), /unknownWriterTables is absent/u);
    // The measured empty list ('') is a measurement.
    assert.equal(fired({ unknownWriterTables: '' }), true);
  });

  it('no Repo node and no DataSource node at all is UNKNOWN, not zero', () => {
    const spec = x5Spec();
    const d = report({
      ...spec,
      nodes: spec.nodes.filter((n) => n.kind !== 'Repo' && n.kind !== 'DataSource'),
    });
    assert.equal(d.outcome, 'unknown');
    const text = d.result.known ? '' : d.result.reason;
    assert.match(text, /no Repo node records untracedWriteCalls/u);
    assert.match(text, /no DataSource node records dynamicDdl/u);
  });

  it('several reasons are all given', () => {
    const text = reason({ untracedWriteCalls: 1, writeHooks: 2 });
    assert.match(text, /untracedWriteCalls is 1/u);
    assert.match(text, /writeHooks is 2/u);
  });

  it('stays UNKNOWN with a scope reason first when a required scope is not PASS', () => {
    for (const scope of [SCOPE_CODE, SCOPE_DATA]) {
      const d = report({ ...x5Spec(), scopes: { [scope]: 'UNAVAILABLE' } });
      assert.equal(d.outcome, 'unknown', scope);
      assert.deepEqual(d.blockedScopes, [scope]);
    }
  });
});
