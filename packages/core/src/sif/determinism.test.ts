import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SifLine } from '@seamline/ontology';

import {
  assertByteIdentical,
  assertDeterministic,
  checkDeterminism,
  compareSif,
  formatDivergence,
  formatReport,
} from './determinism.ts';
import { caught, caughtAsync, makeEdge, makeNode, makeRun, shuffle } from './test-fixtures.ts';
import { writeSif } from './writer.ts';

function sample(overrides: Record<string, unknown> = {}): SifLine[] {
  const fileA = makeNode('File', 'src/a.ts', { path: 'src/a.ts' });
  const fileB = makeNode('File', 'src/b.ts', { path: 'src/b.ts' });
  const column = makeNode('Column', 'main.public.users.email', {
    props: { nullable: false, type: 'text' },
    ...overrides,
  });
  return [
    { t: 'run', run: makeRun() },
    { t: 'node', node: fileA },
    { t: 'node', node: fileB },
    { t: 'node', node: column },
    { t: 'edge', edge: makeEdge('IMPORTS', fileA, fileB) },
  ];
}

/** An edge that sorts strictly after everything else, so appending it adds a final line. */
function trailingEdge(): SifLine {
  const fileA = makeNode('File', 'src/a.ts', { path: 'src/a.ts' });
  const fileB = makeNode('File', 'src/b.ts', { path: 'src/b.ts' });
  return { t: 'edge', edge: makeEdge('RENAMED_FROM', fileB, fileA) };
}

describe('compareSif — identical', () => {
  it('reports byte identity for the same text', () => {
    const text = writeSif(sample());
    const report = compareSif(text, text);
    assert.equal(report.identical, true);
    assert.equal(report.divergence, null);
    assert.equal(report.leftLineCount, 6);
    assert.equal(report.rightLineCount, 6);
    assert.equal(formatReport(report), '(identical)');
  });

  it('reports byte identity across shuffled producers, which is the gate', () => {
    const a = writeSif(shuffle(sample(), 11));
    const b = writeSif(shuffle(sample(), 29));
    assert.equal(compareSif(a, b).identical, true);
  });

  it('treats two empty documents as identical', () => {
    assert.equal(compareSif('', '').identical, true);
  });
});

describe('compareSif — first divergence', () => {
  it('points at the first differing line, not the last', () => {
    const left = writeSif(sample());
    const right = writeSif(sample({ props: { nullable: true, type: 'text' } }));
    const report = compareSif(left, right);
    assert.equal(report.identical, false);
    assert.ok(report.divergence !== null);

    const leftLines = left.split('\n');
    const rightLines = right.split('\n');
    const expected = leftLines.findIndex((l, i) => l !== rightLines[i]) + 1;
    assert.equal(report.divergence.line, expected);
    assert.equal(report.divergence.left, leftLines[expected - 1]);
    assert.equal(report.divergence.right, rightLines[expected - 1]);
  });

  it('names the exact field that differs and both of its values', () => {
    const left = writeSif(sample());
    const right = writeSif(sample({ props: { nullable: true, type: 'text' } }));
    const d = compareSif(left, right).divergence;
    assert.ok(d !== null);
    assert.equal(d.fieldPath, 'node.props.nullable');
    assert.equal(d.leftValue, 'false');
    assert.equal(d.rightValue, 'true');
  });

  it('reports the column of the first differing character', () => {
    const left = 'abcdef\n';
    const right = 'abcXef\n';
    const d = compareSif(left, right).divergence;
    assert.ok(d !== null);
    assert.equal(d.line, 1);
    assert.equal(d.column, 4);
  });

  it('names a field present on only one side', () => {
    const left = '{"t":"node","node":{"a":1,"b":2}}\n';
    const right = '{"t":"node","node":{"a":1}}\n';
    const d = compareSif(left, right).divergence;
    assert.ok(d !== null);
    assert.equal(d.fieldPath, 'node.b');
    assert.equal(d.leftValue, '2');
    assert.equal(d.rightValue, null);
  });

  it('walks in canonical key order, so "first field" matches what the bytes show', () => {
    const left = '{"a":1,"b":1,"c":1}\n';
    const right = '{"a":1,"b":2,"c":2}\n';
    const d = compareSif(left, right).divergence;
    assert.ok(d !== null);
    assert.equal(d.fieldPath, 'b');
  });

  it('descends into arrays with an index in the path', () => {
    const left = '{"r":{"results":[{"status":"PASS"},{"status":"PASS"}]}}\n';
    const right = '{"r":{"results":[{"status":"PASS"},{"status":"FAIL"}]}}\n';
    const d = compareSif(left, right).divergence;
    assert.ok(d !== null);
    assert.equal(d.fieldPath, 'r.results[1].status');
    assert.equal(d.leftValue, '"PASS"');
    assert.equal(d.rightValue, '"FAIL"');
  });
});

describe('compareSif — length mismatch', () => {
  it('reports the extra line when the right side is longer', () => {
    const base = sample();
    const left = writeSif(base);
    const right = writeSif([...base, trailingEdge()]);
    const report = compareSif(left, right);
    assert.equal(report.identical, false);
    assert.ok(report.divergence !== null);
    assert.equal(report.divergence.line, 7);
    assert.equal(report.divergence.left, null);
    assert.ok(report.divergence.right !== null);
    assert.match(report.divergence.summary, /run A ended after 6 line\(s\)/);
    assert.equal(report.leftLineCount, 6);
    assert.equal(report.rightLineCount, 7);
  });

  it('reports the extra line when the left side is longer', () => {
    const base = sample();
    const left = writeSif([...base, trailingEdge()]);
    const right = writeSif(base);
    const d = compareSif(left, right).divergence;
    assert.ok(d !== null);
    assert.equal(d.right, null);
    assert.match(d.summary, /run B ended after 6 line\(s\)/);
  });

  it('finds a divergence in the middle when an extra record sorts into the middle', () => {
    const base = sample();
    const extra: SifLine = { t: 'node', node: makeNode('File', 'src/zzz.ts', { path: 'src/zzz.ts' }) };
    const report = compareSif(writeSif(base), writeSif([...base, extra]));
    assert.equal(report.identical, false);
    // src/zzz.ts sorts after src/b.ts but before any edge, so both sides still
    // have a line 6 and the divergence is a content difference, not a length one.
    assert.equal(report.divergence?.line, 6);
    assert.ok(report.divergence?.left !== null);
    assert.ok(report.divergence?.right !== null);
  });

  it('catches a missing trailing newline rather than normalizing it away', () => {
    const text = writeSif(sample());
    const report = compareSif(text, text.slice(0, -1));
    assert.equal(report.identical, false);
    assert.ok(report.divergence !== null);
    assert.match(report.divergence.summary, /line termination/);
  });
});

describe('formatReport', () => {
  it('renders line, column, both lines, a caret and the field values', () => {
    const left = writeSif(sample());
    const right = writeSif(sample({ props: { nullable: true, type: 'text' } }));
    const rendered = formatReport(compareSif(left, right));
    assert.match(rendered, /first divergence at line \d+, column \d+/);
    assert.match(rendered, /run A: /);
    assert.match(rendered, /run B: /);
    assert.match(rendered, /\^/);
    assert.match(rendered, /field: node\.props\.nullable/);
    assert.match(rendered, /run A: false/);
    assert.match(rendered, /run B: true/);
  });

  it('puts the caret under the differing column', () => {
    const rendered = formatReport(compareSif('abcdef\n', 'abcXef\n'));
    const lines = rendered.split('\n');
    const caretLine = lines.find((l) => l.trim() === '^');
    const runA = lines.find((l) => l.includes('abcdef'));
    assert.ok(caretLine !== undefined && runA !== undefined);
    // column 4 is the 'd' / 'X' position, so the caret sits three past the start.
    assert.equal(caretLine.indexOf('^'), runA.indexOf('abcdef') + 3);
  });

  it('labels the document lengths distinctly from the line contents', () => {
    const rendered = formatReport(compareSif('abcdef\n', 'abcXef\n'));
    assert.match(rendered, /document length: run A = 1 line\(s\), run B = 1 line\(s\)/);
  });

  it('formatDivergence renders a divergence on its own', () => {
    const d = compareSif('{"a":1}\n', '{"a":2}\n').divergence;
    assert.ok(d !== null);
    const rendered = formatDivergence(d);
    assert.match(rendered, /first divergence at line 1, column 6/);
    assert.match(rendered, /field: a/);
    assert.match(rendered, /run A: 1/);
    assert.match(rendered, /run B: 2/);
  });

  it('clips a very long line around the divergence instead of dumping it', () => {
    const filler = 'x'.repeat(500);
    const rendered = formatReport(compareSif(`${filler}A${filler}\n`, `${filler}B${filler}\n`));
    assert.ok(rendered.length < 800, `expected a clipped rendering, got ${rendered.length} chars`);
    assert.ok(rendered.includes('…'));
  });
});

describe('checkDeterminism / assertDeterministic', () => {
  it('passes for a producer whose output does not depend on input order', async () => {
    let seed = 0;
    const produce = (): string => writeSif(shuffle(sample(), ++seed));
    const report = await checkDeterminism(produce);
    assert.equal(report.identical, true);
  });

  it('fails for a producer that leaks a counter into the output', async () => {
    let counter = 0;
    const produce = (): string =>
      writeSif(sample({ props: { nullable: false, type: 'text', seq: ++counter } }));
    const report = await checkDeterminism(produce);
    assert.equal(report.identical, false);
    assert.equal(report.divergence?.fieldPath, 'node.props.seq');
    assert.equal(report.divergence?.leftValue, '1');
    assert.equal(report.divergence?.rightValue, '2');
  });

  it('accepts an async producer', async () => {
    const produce = async (): Promise<string> => Promise.resolve(writeSif(sample()));
    assert.equal((await checkDeterminism(produce)).identical, true);
  });

  it('accepts two different producers', async () => {
    const report = await checkDeterminism(
      () => writeSif(shuffle(sample(), 3)),
      () => writeSif(shuffle(sample(), 17)),
    );
    assert.equal(report.identical, true);
  });

  it('assertByteIdentical is silent on success and explains itself on failure', () => {
    const text = writeSif(sample());
    assert.doesNotThrow(() => assertByteIdentical(text, text));
    const error = caught<Error>(() =>
      assertByteIdentical(text, writeSif(sample({ props: { nullable: true } })), 'extract twice'),
    );
    assert.match(error.message, /^extract twice is not byte-reproducible\./);
    assert.match(error.message, /first divergence at line/);
    assert.match(error.message, /field: node\.props\./);
  });

  it('assertDeterministic rejects with the rendered diff', async () => {
    let counter = 0;
    const error = await caughtAsync<Error>(
      assertDeterministic(() => writeSif(sample({ props: { seq: ++counter } })), undefined, 'extract'),
    );
    assert.match(error.message, /extract is not byte-reproducible/);
    assert.match(error.message, /node\.props\.seq/);
  });
});
