import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SifLine } from '@seamline/ontology';

import { canonicalSifLine } from './canonicalize.ts';
import { parseSifLine, readSif, readSifStream, SifParseError } from './reader.ts';
import { caught, caughtAsync, makeEdge, makeNode, makeResult, makeRun, shuffle } from './test-fixtures.ts';
import { writeSif } from './writer.ts';
import { SIF_FRAME } from './framing.ts';

function sample(): SifLine[] {
  const fileA = makeNode('File', 'src/a.ts', { path: 'src/a.ts', sourceRef: 'src/a.ts:1:1' });
  const fileB = makeNode('File', 'src/b.ts', { path: 'src/b.ts', untrusted: false });
  const sym = makeNode('Symbol', 'src/a.ts#User', { path: 'src/a.ts' });
  const column = makeNode('Column', 'main.public.users.email', {
    sensitivity: 'confidential',
    props: { nullable: false, type: 'text', maxLength: 255 },
  });
  const codeField = makeNode('CodeField', 'src/a.ts#User.email', { path: 'src/a.ts' });
  return [
    { t: 'run', run: makeRun({ results: [makeResult()] }) },
    { t: 'status', result: makeResult() },
    { t: 'node', node: fileA },
    { t: 'node', node: fileB },
    { t: 'node', node: sym },
    { t: 'node', node: column },
    { t: 'node', node: codeField },
    { t: 'edge', edge: makeEdge('IMPORTS', fileA, fileB, { srcFile: 'src/a.ts', dstFile: 'src/b.ts' }) },
    { t: 'edge', edge: makeEdge('EXPORTS', fileA, sym) },
    { t: 'edge', edge: makeEdge('MAPS_TO_FIELD', column, codeField, { confidence: 0.82 }) },
  ];
}

/** Serialize without the writer's own validation, so the reader is what is under test. */
function raw(line: SifLine): string {
  return JSON.stringify(line);
}

function nodeLine(overrides: Record<string, unknown>): string {
  return raw({ t: 'node', node: makeNode('File', 'src/a.ts', overrides) });
}

function bodyLines(lines: SifLine[]): string[] {
  const body = writeSif(lines).split('\n');
  assert.equal(body.shift(), SIF_FRAME);
  return body.filter((line) => line.length > 0);
}

describe('readSif — round trip', () => {
  it('round-trips a full document with fidelity', () => {
    const text = writeSif(sample());
    const parsed = readSif(text);
    assert.equal(parsed.length, sample().length);
    assert.equal(writeSif(parsed), text);
  });

  it('re-serializes to identical bytes no matter how the input was ordered', () => {
    const baseline = writeSif(sample());
    for (let seed = 1; seed <= 10; seed++) {
      assert.equal(writeSif(readSif(writeSif(shuffle(sample(), seed)))), baseline);
    }
  });

  it('preserves props values by type', () => {
    const parsed = readSif(writeSif(sample()));
    const column = parsed.find((l) => l.t === 'node' && l.node.kind === 'Column');
    assert.ok(column !== undefined && column.t === 'node');
    assert.deepEqual(column.node.props, { nullable: false, type: 'text', maxLength: 255 });
  });

  it('preserves the run record and its extractor results', () => {
    const parsed = readSif(writeSif(sample()));
    const run = parsed.find((l) => l.t === 'run');
    assert.ok(run !== undefined && run.t === 'run');
    assert.equal(run.run.runId, 'run-0001');
    assert.equal(run.run.results.length, 1);
    assert.equal(run.run.results[0]?.status, 'PASS');
    assert.deepEqual(run.run.results[0]?.authoritative[0]?.kinds, ['File', 'Symbol']);
  });

  it('tolerates a blank line and CRLF without losing a record', () => {
    const lines = bodyLines(sample());
    assert.equal(readSif(`${lines.join('\r\n')}\r\n\r\n`).length, lines.length);
  });
});

describe('readSif — contract validation', () => {
  it('rejects an unknown node kind, naming the line, the field and the vocabulary', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ kind: 'Widget' }), 7));
    assert.ok(error instanceof SifParseError);
    assert.equal(error.line, 7);
    assert.equal(error.field, 'node.kind');
    assert.match(error.message, /"Widget" is not a known node kind/);
    assert.match(error.message, /Repo, File, Module/);
  });

  it('suggests the intended kind on a near miss', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ kind: 'Colum' }), 1));
    assert.match(error.message, /Did you mean "Column"/);
  });

  it('rejects an edge outside its declared signature', () => {
    const table = makeNode('Table', 'main.public.users');
    const codeField = makeNode('CodeField', 'src/a.ts#User.email');
    const line = raw({ t: 'edge', edge: makeEdge('MAPS_TO_FIELD', table, codeField) });
    const error = caught<SifParseError>(() => parseSifLine(line, 4));
    assert.ok(error instanceof SifParseError);
    assert.equal(error.line, 4);
    assert.equal(error.field, 'edge.kind');
    assert.match(error.message, /MAPS_TO_FIELD is not declared for Table -> CodeField/);
    assert.match(error.message, /Column -> CodeField/);
  });

  it('accepts the same edge kind between its declared endpoints', () => {
    const column = makeNode('Column', 'main.public.users.email');
    const codeField = makeNode('CodeField', 'src/a.ts#User.email');
    const line = raw({ t: 'edge', edge: makeEdge('MAPS_TO_FIELD', column, codeField) });
    assert.doesNotThrow(() => parseSifLine(line, 1));
  });

  it('rejects an unknown edge kind', () => {
    const a = makeNode('File', 'src/a.ts');
    const b = makeNode('File', 'src/b.ts');
    const line = raw({ t: 'edge', edge: makeEdge('IMPORTS', a, b, { kind: 'SLURPS' }) });
    const error = caught<SifParseError>(() => parseSifLine(line, 2));
    assert.equal(error.field, 'edge.kind');
    assert.match(error.message, /not a known edge kind/);
  });

  it('rejects an endpoint that is not a NodeId', () => {
    const line = '{"t":"edge","edge":{"kind":"IMPORTS","src":"nope","dst":"nope","provenance":"EXTRACTED","confidence":1,"props":{},"firstSeenRun":"r","lastSeenRun":"r","deletedAt":null}}';
    const error = caught<SifParseError>(() => parseSifLine(line, 1));
    assert.equal(error.field, 'edge.src');
    assert.match(error.message, /is not a NodeId/);
  });

  it('rejects an id whose encoded kind disagrees with node.kind', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ kind: 'Module' }), 3));
    assert.equal(error.field, 'node.id');
    assert.match(error.message, /id encodes kind "File" but node\.kind is "Module"/);
  });

  it('rejects illegal provenance and sensitivity', () => {
    const p = caught<SifParseError>(() => parseSifLine(nodeLine({ provenance: 'GUESSED' }), 1));
    assert.equal(p.field, 'node.provenance');
    assert.match(p.message, /EXTRACTED, DECLARED, INFERRED, LLM_SUGGESTED/);
    const s = caught<SifParseError>(() => parseSifLine(nodeLine({ sensitivity: 'secret' }), 1));
    assert.equal(s.field, 'node.sensitivity');
    assert.match(s.message, /public, internal, confidential, restricted/);
  });

  it('rejects confidence outside [0, 1]', () => {
    for (const bad of [-0.1, 1.5, Number.NaN, '0.5', null]) {
      const node = { ...makeNode('File', 'src/a.ts'), confidence: bad };
      const error = caught<SifParseError>(() => parseSifLine(JSON.stringify({ t: 'node', node }), 1));
      assert.ok(error instanceof SifParseError, `expected a SifParseError for confidence ${String(bad)}`);
      assert.equal(error.field, 'node.confidence');
    }
  });

  it('accepts the endpoints of [0, 1]', () => {
    for (const good of [0, 1, 0.5]) {
      const node = { ...makeNode('File', 'src/a.ts'), confidence: good };
      assert.doesNotThrow(() => parseSifLine(JSON.stringify({ t: 'node', node }), 1));
    }
  });

  it('rejects a nested object in props, which has no canonical merge semantics', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ props: { nested: { a: 1 } } }), 1));
    assert.equal(error.field, 'node.props.nested');
  });

  it('rejects a missing required field by name', () => {
    const node = makeNode('File', 'src/a.ts') as unknown as Record<string, unknown>;
    delete node['deletedAt'];
    const error = caught<SifParseError>(() => parseSifLine(JSON.stringify({ t: 'node', node }), 1));
    assert.equal(error.field, 'node.deletedAt');
    assert.match(error.message, /is required/);
  });

  it('rejects an extractor status outside the vocabulary', () => {
    const line = raw({ t: 'status', result: makeResult({ status: 'OK' }) });
    const error = caught<SifParseError>(() => parseSifLine(line, 1));
    assert.equal(error.field, 'result.status');
    assert.match(error.message, /PASS, FAIL, UNAVAILABLE/);
  });
});

describe('readSif — determinism rules', () => {
  it('rejects an absolute path', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ path: '/home/example/repo/src/a.ts' }), 12));
    assert.ok(error instanceof SifParseError);
    assert.equal(error.line, 12);
    assert.equal(error.field, 'node.path');
    assert.match(error.message, /absolute/);
  });

  it('rejects a backslash path', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ path: 'src\\a.ts' }), 5));
    assert.equal(error.field, 'node.path');
    assert.match(error.message, /backslash/);
  });

  it('rejects a .. path', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ path: '../outside/a.ts' }), 5));
    assert.match(error.message, /escapes the repo root/);
  });

  it('rejects a node carrying a stray timestamp field', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ createdAt: '2026-01-01T00:00:00.000Z' }), 9));
    assert.ok(error instanceof SifParseError);
    assert.equal(error.line, 9);
    assert.equal(error.field, 'node.createdAt');
    assert.match(error.message, /belongs to the Run record/);
    assert.match(error.message, /byte-identical/);
  });

  it('rejects a timestamp smuggled into props', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ props: { extractedAt: '2026-01-01' } }), 1));
    assert.equal(error.field, 'node.props.extractedAt');
  });

  it('rejects an unknown field, so extension data stays in props', () => {
    const error = caught<SifParseError>(() => parseSifLine(nodeLine({ author: 'alice' }), 1));
    assert.equal(error.field, 'node.author');
    assert.match(error.message, /props/);
  });
});

describe('readSif — line numbers and failure modes', () => {
  it('reports the correct line number for a malformed line mid-document', () => {
    const good = bodyLines(sample());
    const withBad = [...good.slice(0, 3), '{"t":"node","node":{ NOT JSON', ...good.slice(3)];
    const error = caught<SifParseError>(() => readSif(`${withBad.join('\n')}\n`));
    assert.ok(error instanceof SifParseError);
    assert.equal(error.line, 4);
    assert.match(error.message, /^SIF line 4: not valid JSON/);
  });

  it('counts blank lines when numbering, so the number matches the editor', () => {
    const good = bodyLines(sample());
    const text = `${good[0] as string}\n\n\n${nodeLine({ kind: 'Widget' })}\n`;
    const error = caught<SifParseError>(() => readSif(text));
    assert.equal(error.line, 4);
  });

  it('never silently skips a line: one bad line aborts the read', () => {
    const good = bodyLines(sample());
    const withBad = [...good, nodeLine({ kind: 'Widget' })];
    assert.throws(() => readSif(`${withBad.join('\n')}\n`), SifParseError);
  });

  it('always throws a SifParseError with a non-empty message, never undefined', () => {
    const bad = [
      'null',
      '[]',
      '"a string"',
      '{}',
      '{"t":"nope"}',
      '{"t":"node"}',
      '{"t":"node","node":null}',
      '{"t":"node","node":{},"extra":1}',
      '{"t":"edge","edge":{"kind":"IMPORTS","src":"nope","dst":"nope"}}',
      '{"t":"run","run":{}}',
      '{"t":"status","result":{}}',
      '{"t":42}',
      '{"t":"node","node":[]}',
    ];
    for (const line of bad) {
      const error = caught<SifParseError>(() => parseSifLine(line, 1));
      assert.ok(error instanceof SifParseError, `expected a SifParseError for ${line}`);
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.length > 0, `empty message for ${line}`);
      assert.equal(error.line, 1);
      assert.equal(typeof error.field, 'string');
    }
  });
});

describe('readSifStream', () => {
  it('parses across arbitrary chunk boundaries', async () => {
    const text = writeSif(sample());
    async function* chunks(size: number): AsyncGenerator<string> {
      for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
    }
    for (const size of [1, 7, 64, 4096]) {
      const parsed = await readSifStream(chunks(size));
      assert.equal(writeSif(parsed), text, `chunk size ${size}`);
    }
  });

  it('reports the line number of a bad line found mid-stream', async () => {
    const good = bodyLines(sample());
    const withBad = [...good.slice(0, 2), nodeLine({ kind: 'Widget' }), ...good.slice(2)];
    async function* chunks(): AsyncGenerator<string> {
      yield `${withBad.join('\n')}\n`;
    }
    const error = await caughtAsync<SifParseError>(readSifStream(chunks()));
    assert.ok(error instanceof SifParseError);
    assert.equal(error.line, 3);
    assert.equal(error.field, 'node.kind');
  });
});

describe('the writer and the reader agree', () => {
  it('accepts every line a conforming writer emits', () => {
    for (const line of sample()) {
      assert.doesNotThrow(() => parseSifLine(canonicalSifLine(line), 1));
    }
  });
});
