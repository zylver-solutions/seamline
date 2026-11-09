/**
 * `seamline mcp` against a real extracted store.
 *
 * The bundled harbor-books example is extracted with the real extractors into
 * a temporary copy, then an MCP client session is driven over the command's
 * stdio: `initialize`, then `tools/call lineage`. The answer must reach the
 * same joins `seamline why` reports for that field, with no UNKNOWN scopes,
 * because the server is reading the store the CLI just wrote, not an empty
 * placeholder graph.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, test } from 'node:test';
import { bufferIo, EXIT_OK, EXIT_USAGE } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { runCli } from '../run.ts';
import { buildCliDeps } from '../wiring.ts';
import type { WhyReport } from './why.ts';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../examples/harbor-books');

/** The extractors that do not depend on git history, as in the dogfood gate. */
const NON_HISTORY = ['extract-code-ts', 'extract-data', 'extract-contracts', 'infer-join'];

type Session = CliDeps & { io: ReturnType<typeof bufferIo> };

function session(cwd: string, frames: readonly unknown[] = []): Session {
  const io = bufferIo({ cwd, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const lines = frames.map((f) => `${JSON.stringify(f)}\n`);
  return {
    ...buildCliDeps(io),
    io,
    input: () =>
      (async function* () {
        for (const line of lines) yield line;
      })(),
  };
}

function rpc(id: number, method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

const LINEAGE_SESSION = [
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }),
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  rpc(2, 'tools/call', { name: 'lineage', arguments: { field: 'shipped_at' } }),
];

interface LineageStructured {
  readonly unknown: readonly unknown[];
  readonly result: {
    readonly found: boolean;
    readonly chains: ReadonlyArray<{ readonly hops: ReadonlyArray<{ readonly to: string }> }>;
  };
}

function replies(out: string): Map<number, Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>();
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line) as { id?: number };
    if (typeof msg.id === 'number') byId.set(msg.id, msg as Record<string, unknown>);
  }
  return byId;
}

describe('seamline mcp over a real store', () => {
  let repo = '';

  before(async () => {
    repo = mkdtempSync(path.join(tmpdir(), 'seamline-mcp-'));
    cpSync(EXAMPLE, repo, { recursive: true });
    const d = session(repo);
    const code = await runCli(d, ['extract', '--repo', repo, ...NON_HISTORY.flatMap((n) => ['--only', n])]);
    assert.equal(code, EXIT_OK, d.io.stderr());
  });

  test('lineage over stdio reaches what `why` reaches, with no UNKNOWN scope', async () => {
    const why = session(repo);
    assert.equal(await runCli(why, ['why', 'shipped_at', '--repo', repo, '--json']), EXIT_OK, why.io.stderr());
    const whyReport = JSON.parse(why.io.stdout()) as WhyReport;
    const whyReached = [...new Set(whyReport.chains.flatMap((c) => c.hops.map((h) => h.to.id)))].sort();
    // Order and OrderResponse are different shapes under the container gate.
    // Keep the real demo limitation visible while proving nonempty MCP parity.
    assert.deepEqual(whyReached, ['harbor-books:CodeField:<root>#Order.shippedAt']);

    const d = session(repo, LINEAGE_SESSION);
    assert.equal(await runCli(d, ['mcp', '--repo', repo, '--profile', 'team']), EXIT_OK, d.io.stderr());

    const byId = replies(d.io.stdout());
    assert.ok(byId.get(1)?.['result'] !== undefined, 'initialize answered');
    const call = byId.get(2)?.['result'] as { structuredContent: LineageStructured; isError: boolean };
    assert.equal(call.isError, false);
    assert.deepEqual(call.structuredContent.unknown, []);
    assert.equal(call.structuredContent.result.found, true);
    // `why` enumerates paths; the MCP tool returns a breadth-first tree, one
    // chain per leaf. The joins they reach must be the same.
    const served = call.structuredContent.result.chains;
    assert.equal(served.length, whyReached.length, 'one chain per joined field');
    const mcpReached = [...new Set(served.flatMap((c) => c.hops.map((h) => h.to)))].sort();
    assert.deepEqual(mcpReached, whyReached);
  });

  test('two sessions over the same store give byte-identical replies, nonce aside', async () => {
    const transcript = async (): Promise<string> => {
      const d = session(repo, LINEAGE_SESSION);
      assert.equal(await runCli(d, ['mcp', '--repo', repo, '--profile', 'team']), EXIT_OK, d.io.stderr());
      return d.io.stdout().replace(/\b[0-9a-f]{16}\b/g, '<nonce>');
    };
    assert.equal(await transcript(), await transcript());
  });

  test('--audit writes one JSON line per tool call to stderr and nothing to stdout', async () => {
    const d = session(repo, LINEAGE_SESSION);
    assert.equal(await runCli(d, ['mcp', '--repo', repo, '--profile', 'team', '--audit']), EXIT_OK, d.io.stderr());
    const audit = d.io
      .stderr()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { tool: string; ok: boolean });
    assert.deepEqual(
      audit.map((e) => [e.tool, e.ok]),
      [['lineage', true]],
    );
    for (const line of d.io.stdout().split('\n').filter((l) => l.length > 0)) {
      assert.equal((JSON.parse(line) as { jsonrpc: string }).jsonrpc, '2.0', 'stdout carries protocol frames only');
    }
  });

  test('a failing detector reaches the client as a generic error, with the detail on stderr only', async () => {
    const d: Session = {
      ...session(repo, [
        rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }),
        rpc(2, 'tools/call', { name: 'contradictions', arguments: {} }),
      ]),
      detectors: { run: () => Promise.reject(new Error('cannot read column public.orders.customer_email')) },
    };
    assert.equal(await runCli(d, ['mcp', '--repo', repo, '--profile', 'public']), EXIT_OK, d.io.stderr());
    const reply = replies(d.io.stdout()).get(2) as { error?: { code: number; message: string } } | undefined;
    assert.equal(reply?.error?.code, -32603);
    assert.doesNotMatch(d.io.stdout(), /customer_email|public\.orders/);
    assert.match(d.io.stderr(), /cannot read column public\.orders\.customer_email/);
  });

  test('the profile applies: the public profile serves no column and no lineage chain', async () => {
    const d = session(repo, LINEAGE_SESSION);
    assert.equal(await runCli(d, ['mcp', '--repo', repo, '--profile', 'public']), EXIT_OK, d.io.stderr());
    const call = replies(d.io.stdout()).get(2)?.['result'] as { structuredContent: LineageStructured };
    assert.equal(call.structuredContent.result.found, false);
    assert.doesNotMatch(d.io.stdout(), /Column:public\.orders/);
  });
});

describe('seamline mcp refuses to start without a usable profile', () => {
  test('no --profile exits 2 and explains that the server is default-deny', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'seamline-mcp-noprofile-'));
    cpSync(EXAMPLE, repo, { recursive: true });
    const d = session(repo, LINEAGE_SESSION);
    assert.equal(await runCli(d, ['mcp', '--repo', repo]), EXIT_USAGE);
    assert.match(d.io.stderr(), /--profile/);
    assert.match(d.io.stderr(), /default-deny/);
    assert.equal(d.io.stdout(), '', 'no protocol frame is served');
  });

  test('an unknown profile exits 2 and names the available ones', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'seamline-mcp-badprofile-'));
    cpSync(EXAMPLE, repo, { recursive: true });
    const d = session(repo, LINEAGE_SESSION);
    assert.equal(await runCli(d, ['mcp', '--repo', repo, '--profile', 'everything']), EXIT_USAGE);
    assert.match(d.io.stderr(), /Available profiles: audit, public, structure, team/);
    assert.equal(d.io.stdout(), '');
  });
});
