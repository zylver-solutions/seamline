import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LineFramer, encode, failure, parseMessage } from './jsonrpc.ts';
import { createServer } from './server.ts';
import { serveStdio, terminalLog, type StdioStreams } from './stdio.ts';
import { fixedNonce, makeNode, memorySource } from './testing.ts';
import { AUDIT_PROFILE } from '@seamline/core';

test('LineFramer splits on newlines and holds a partial line', () => {
  const f = new LineFramer();
  assert.deepEqual(f.push('{"a":1}\n{"b":').lines, ['{"a":1}']);
  assert.deepEqual(f.push('2}\n').lines, ['{"b":2}']);
});

test('LineFramer tolerates CRLF and blank lines', () => {
  const f = new LineFramer();
  const r = f.push('{"a":1}\r\n\n{"b":2}\n');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
});

test('LineFramer bounds the buffer so a peer cannot exhaust memory', () => {
  const f = new LineFramer(64);
  const r = f.push('x'.repeat(200));
  assert.equal(r.overflow, true);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(f.push('\n').lines, [], 'the oversized buffer was dropped, not split');
});

test('flush returns a trailing line from a peer that closed without a newline', () => {
  const f = new LineFramer();
  f.push('{"a":1}');
  assert.deepEqual(f.flush(), ['{"a":1}']);
  assert.deepEqual(f.flush(), []);
});

test('encode always produces exactly one line', () => {
  const line = encode(failure(1, -32600, 'bad\nrequest'));
  assert.equal(line.split('\n').length, 2, 'content plus the terminating newline');
  assert.ok(line.endsWith('\n'));
});

test('parseMessage rejects a non-object message', () => {
  const r = parseMessage('[1,2,3]');
  assert.ok('response' in r);
});

test('parseMessage keeps a notification distinguishable from a request', () => {
  const notification = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.ok('request' in notification);
  assert.equal(notification.request.id, undefined);

  const request = parseMessage('{"jsonrpc":"2.0","id":7,"method":"ping"}');
  assert.ok('request' in request);
  assert.equal(request.request.id, 7);
});

function streams(input: readonly string[]): StdioStreams & { out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    input: (async function* gen(): AsyncGenerator<string> {
      for (const chunk of input) yield chunk;
    })(),
    write: (s) => {
      outChunks.push(s);
    },
    writeErr: (s) => {
      errChunks.push(s);
    },
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
  };
}

test('serveStdio answers a full initialize / list / call session over the pipe', async () => {
  const node = makeNode({ kind: 'Column', canonicalName: 'public.users.email' });
  const server = createServer({ profile: AUDIT_PROFILE, graph: memorySource({ nodes: [node] }), nonce: fixedNonce() });
  const io = streams([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
    `${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'context', arguments: { symbol: 'public.users.email' } } })}\n`,
  ]);

  await serveStdio(server, io);

  const replies = io.out().trim().split('\n').map((l) => JSON.parse(l) as { id: number });
  assert.deepEqual(replies.map((r) => r.id), [1, 2, 3], 'the notification got no reply');
});

test('serveStdio handles two messages arriving in one chunk', async () => {
  const server = createServer({ profile: AUDIT_PROFILE, graph: memorySource({}), nonce: fixedNonce() });
  const io = streams([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`,
  ]);
  await serveStdio(server, io);
  assert.equal(io.out().trim().split('\n').length, 2);
});

test('serveStdio reports an over-long line on stdout as an error frame and warns on stderr', async () => {
  const server = createServer({ profile: AUDIT_PROFILE, graph: memorySource({}), nonce: fixedNonce() });
  const io = streams(['x'.repeat(500)]);
  await serveStdio(server, io, { maxLineBytes: 64 });
  const frames = io.out().trim().split('\n');
  assert.equal((JSON.parse(frames[0] as string) as { error: { code: number } }).error.code, -32600);
  assert.match(io.err(), /over-long input line/);
});

test('stdout carries only protocol frames; diagnostics go to stderr', async () => {
  const server = createServer({ profile: AUDIT_PROFILE, graph: memorySource({}), nonce: fixedNonce() });
  const io = streams([`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`]);
  await serveStdio(server, io);
  for (const line of io.out().trim().split('\n')) {
    assert.doesNotThrow(() => JSON.parse(line), `every stdout line is a JSON frame: ${line}`);
  }
});

test('terminalLog writes one escaped line: controls and line breaks in repository text cannot reach stderr raw', () => {
  const written: string[] = [];
  terminalLog((t) => void written.push(t))('cannot read x\u001b]0;pwned\u0007\u009b2J\u202e\nCRITICAL forged');
  assert.deepEqual(written, ['cannot read x\\x1b]0;pwned\\x07\\x9b2J\\u202e\\nCRITICAL forged\n']);
});
