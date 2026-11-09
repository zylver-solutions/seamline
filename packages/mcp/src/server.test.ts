import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INVALID_PARAMS, METHOD_NOT_FOUND, PARSE_ERROR, type JsonRpcResponse } from './jsonrpc.ts';
import { createServer, LATEST_PROTOCOL_VERSION } from './server.ts';
import { fixedNonce, makeEdge, makeNode, memorySource } from './testing.ts';
import { AUDIT_PROFILE } from '@seamline/core';

const column = makeNode({ kind: 'Column', canonicalName: 'public.users.email' });
const field = makeNode({ kind: 'CodeField', canonicalName: 'User.email' });

function server(): ReturnType<typeof createServer> {
  return createServer({
    profile: AUDIT_PROFILE,
    graph: memorySource({
      nodes: [column, field],
      edges: [makeEdge({ kind: 'MAPS_TO_FIELD', src: column.id, dst: field.id, confidence: 0.9 })],
    }),
    nonce: fixedNonce(),
  });
}

async function rpc(s: ReturnType<typeof createServer>, method: string, params?: unknown, id: number | string = 1): Promise<JsonRpcResponse> {
  const line = await s.handle(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
  assert.ok(line !== null, `${method} produced a reply`);
  return JSON.parse(line) as JsonRpcResponse;
}

test('initialize returns a protocol version, capabilities, and instructions', async () => {
  const res = await rpc(server(), 'initialize', { protocolVersion: LATEST_PROTOCOL_VERSION });
  const r = res.result as { protocolVersion: string; capabilities: { tools: unknown }; instructions: string };
  assert.equal(r.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.ok(r.capabilities.tools !== undefined);
  assert.match(r.instructions, /UNTRUSTED/);
  assert.match(r.instructions, /not "nothing exists"/);
});

test('initialize with an unknown protocol version answers with the latest one it speaks', async () => {
  const res = await rpc(server(), 'initialize', { protocolVersion: '1999-01-01' });
  assert.equal((res.result as { protocolVersion: string }).protocolVersion, LATEST_PROTOCOL_VERSION);
});

test('the initialized notification produces no reply', async () => {
  const line = await server().handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(line, null);
});

test('tools/list advertises exactly the five parameterized tools', async () => {
  const res = await rpc(server(), 'tools/list');
  const tools = (res.result as { tools: Array<{ name: string }> }).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ['context', 'contradictions', 'explain', 'impact', 'lineage']);
});

test('there is no raw query tool of any name', async () => {
  const res = await rpc(server(), 'tools/list');
  const tools = (res.result as { tools: Array<{ name: string; description: string }> }).tools;
  for (const forbidden of ['cypher', 'query', 'sql', 'raw', 'exec', 'eval']) {
    assert.ok(!tools.some((t) => t.name === forbidden), `no \`${forbidden}\` tool`);
  }
});

test('every advertised tool declares a closed input schema', async () => {
  const res = await rpc(server(), 'tools/list');
  const tools = (res.result as {
    tools: Array<{ name: string; inputSchema: { type: string; additionalProperties: boolean } }>;
  }).tools;
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema is an object`);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} rejects unknown parameters`);
  }
});

test('every tool is annotated read-only and closed-world', async () => {
  const res = await rpc(server(), 'tools/list');
  const tools = (res.result as {
    tools: Array<{ name: string; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }>;
  }).tools;
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is read-only`);
    assert.equal(t.annotations.openWorldHint, false);
  }
});

test('tools/call returns text content and structured content', async () => {
  const res = await rpc(server(), 'tools/call', { name: 'context', arguments: { symbol: 'public.users.email' } });
  const r = res.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: { tool: string; unknown: unknown[] };
    isError: boolean;
  };
  assert.equal(r.isError, false);
  assert.equal(r.content[0]?.type, 'text');
  assert.equal(r.structuredContent.tool, 'context');
  assert.ok(Array.isArray(r.structuredContent.unknown), '`unknown` is always present');
});

test('a tool call with malformed params comes back as a tool error listing what was wrong', async () => {
  const res = await rpc(server(), 'tools/call', { name: 'context', arguments: { symbol: 42 } });
  const r = res.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  assert.match(r.content[0]?.text ?? '', /invalid parameters/);
  assert.match(r.content[0]?.text ?? '', /must be a string/);
});

test('a tool call with an unknown parameter is rejected, not silently ignored', async () => {
  const res = await rpc(server(), 'tools/call', {
    name: 'context',
    arguments: { symbol: 'public.users.email', cypher: 'MATCH (n) RETURN n' },
  });
  assert.equal((res.result as { isError: boolean }).isError, true);
});

test('a call to an unknown tool is a tool error naming the available tools', async () => {
  const res = await rpc(server(), 'tools/call', { name: 'cypher', arguments: { q: 'MATCH (n)' } });
  const r = res.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  assert.match(r.content[0]?.text ?? '', /unknown tool `cypher`/);
});

test('tools/call without a name is a protocol-level invalid-params error', async () => {
  const res = await rpc(server(), 'tools/call', { arguments: {} });
  assert.equal(res.error?.code, INVALID_PARAMS);
});

test('an unknown method is method-not-found and says there is no raw query method', async () => {
  const res = await rpc(server(), 'graph/query', { cypher: 'MATCH (n) RETURN n' });
  assert.equal(res.error?.code, METHOD_NOT_FOUND);
  assert.match(JSON.stringify(res.error?.data), /no raw query method/);
});

test('malformed JSON is a parse error, not a crash', async () => {
  const line = await server().handle('{not json');
  assert.ok(line !== null);
  const res = JSON.parse(line) as JsonRpcResponse;
  assert.equal(res.error?.code, PARSE_ERROR);
});

test('a message with the wrong jsonrpc version is an invalid request', async () => {
  const line = await server().handle(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }));
  assert.ok(line !== null);
  assert.equal((JSON.parse(line) as JsonRpcResponse).error?.code, -32600);
});

test('a reply is always exactly one line, so the framing cannot be broken by content', async () => {
  const noisy = makeNode({
    kind: 'Symbol',
    canonicalName: 'weird',
    name: 'line one\nline two',
    untrusted: true,
  });
  const s = createServer({ profile: AUDIT_PROFILE, graph: memorySource({ nodes: [noisy] }), nonce: fixedNonce() });
  const line = await s.handle(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context', arguments: { symbol: 'weird' } } }),
  );
  assert.ok(line !== null);
  assert.equal(line.split('\n').filter((l) => l.length > 0).length, 1);
});

test('ping answers', async () => {
  const res = await rpc(server(), 'ping');
  assert.deepEqual(res.result, {});
});

test('the audit hook sees every call, including a rejected one', async () => {
  const seen: Array<{ tool: string; ok: boolean }> = [];
  const s = createServer({
    profile: AUDIT_PROFILE,
    graph: memorySource({ nodes: [column] }),
    nonce: fixedNonce(),
    audit: (e) => seen.push({ tool: e.tool, ok: e.ok }),
  });
  await s.callTool('context', { symbol: 'public.users.email' });
  await s.callTool('context', { symbol: 42 });
  assert.deepEqual(seen, [
    { tool: 'context', ok: true },
    { tool: 'context', ok: false },
  ]);
});
