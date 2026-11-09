/**
 * A detector that is UNKNOWN for its own reason (`unknownWhen`), through the whole CLI.
 *
 * The extractors write `untracedWriteCalls` on the `Repo` node; a detector reads it in
 * `unknownWhen`; `check --json` and the MCP `contradictions` tool list the detector as UNKNOWN
 * with that reason, not as clean and not with a finding. Both surfaces take the list from the
 * same port (`contradictionsDetectorPort`), so the new path reaches both. The detector here is
 * a fixture shaped like the one X5 will become (design 5.2): it would fire on any repository,
 * and it stands down when the repository records a write it could not attribute.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { defineDetector, SCOPE_CODE, SCOPE_DATA } from '@seamline/contradictions';
import type { FindingDraft } from '@seamline/contradictions';
import type { GraphView } from '@seamline/ontology';
import { CONFIG_FILENAME, defaultConfig, serializeConfig } from '../config.ts';
import { bufferIo, EXIT_OK } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { runCli } from '../run.ts';
import { buildCliDeps, contradictionsDetectorPort } from '../wiring.ts';

const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['src'],
});

function repoWith(appSource: string): Promise<string> {
  return (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seamline-unknown-when-'));
    roots.push(dir);
    const files: Readonly<Record<string, string>> = {
      [CONFIG_FILENAME]: serializeConfig(defaultConfig('demo')),
      'db/schema.sql': 'CREATE TABLE users (id integer PRIMARY KEY);\n',
      'src/app.ts': appSource,
      'tsconfig.json': TSCONFIG,
      'package.json': JSON.stringify({ name: '@demo/app', version: '1.0.0', type: 'module' }),
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text, 'utf8');
    }
    return dir;
  })();
}

/** Fires on every `Repo`; UNKNOWN when `untracedWriteCalls` is absent or above zero. */
const fixture = defineDetector({
  code: 'X5_UNWRITTEN_COLUMN',
  severity: 'medium',
  requiredScopes: [SCOPE_CODE],
  description: 'fixture: would fire on any repository',
  find(g: GraphView): ReadonlyArray<FindingDraft> {
    return g.nodesByKind('Repo').map((r) => ({
      left: r.id,
      right: r.id,
      claim: 'fixture finding',
      leftFact: 'fact',
      rightFact: 'fact',
      viaPath: [],
      confidence: 1,
    }));
  },
  unknownWhen(g: GraphView): string | undefined {
    const repo = g.nodesByKind('Repo')[0];
    const n = repo?.props['untracedWriteCalls'];
    if (typeof n !== 'number')
      return 'untracedWriteCalls is absent: the extractor did not measure it';
    return n > 0 ? `${n} write call(s) could not be attributed to a table` : undefined;
  },
});

type Session = CliDeps & { io: ReturnType<typeof bufferIo> };

function session(cwd: string, frames: readonly unknown[] = []): Session {
  const io = bufferIo({ cwd, isTty: false, env: { SEAMLINE_DETERMINISTIC: '1' } });
  const lines = frames.map((f) => `${JSON.stringify(f)}\n`);
  return {
    ...buildCliDeps(io),
    io,
    detectors: contradictionsDetectorPort([fixture]),
    input: () =>
      (async function* () {
        for (const line of lines) yield line;
      })(),
  };
}

async function extracted(appSource: string): Promise<string> {
  const dir = await repoWith(appSource);
  const d = session(dir);
  const code = await runCli(d, [
    'extract',
    '--repo',
    dir,
    '--only',
    'extract-code-ts',
    '--only',
    'extract-data',
  ]);
  assert.equal(code, EXIT_OK, d.io.stderr());
  return dir;
}

interface CheckJson {
  readonly outcome: string;
  readonly contradictions: ReadonlyArray<{ readonly code: string }>;
  readonly unknownDetectors: ReadonlyArray<{
    readonly code: string;
    readonly reason: string;
    readonly scopes: readonly string[];
    readonly scopeStatus: Record<string, string>;
  }>;
}

async function check(dir: string): Promise<CheckJson> {
  const d = session(dir);
  assert.equal(await runCli(d, ['check', '--repo', dir, '--json']), EXIT_OK, d.io.stderr());
  return JSON.parse(d.io.stdout()) as CheckJson;
}

const UNTRACED = `declare const prisma: { $executeRawUnsafe(q: string): unknown };
export function run(query: string): unknown {
  return prisma.$executeRawUnsafe(query);
}
`;
const TRACED = `export const answer = 42;
`;

function mcpSession(tool: string, args: Record<string, unknown>): readonly unknown[] {
  return [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    },
  ];
}

interface ContradictionsResult {
  readonly result: {
    readonly findings: ReadonlyArray<{ readonly code: string }>;
    readonly unknownDetectors: ReadonlyArray<{
      readonly code: string;
      readonly reason: string;
      readonly scopes: readonly string[];
    }>;
  };
  readonly notices: readonly string[];
}

interface ToolReply<R> {
  readonly result: R;
  readonly unknown: readonly unknown[];
  readonly notices: readonly string[];
}

async function callMcp<R>(
  dir: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolReply<R>> {
  const d = session(dir, mcpSession(tool, args));
  assert.equal(
    await runCli(d, ['mcp', '--repo', dir, '--profile', 'team']),
    EXIT_OK,
    d.io.stderr(),
  );
  for (const line of d.io.stdout().split('\n')) {
    if (line.trim().length === 0) continue;
    const msg = JSON.parse(line) as {
      id?: number;
      result?: { structuredContent: ToolReply<R>; isError: boolean };
    };
    if (msg.id === 2 && msg.result !== undefined) {
      assert.equal(msg.result.isError, false);
      return msg.result.structuredContent;
    }
  }
  assert.fail('no reply to tools/call');
}

function viaMcp(dir: string): Promise<ContradictionsResult> {
  return callMcp<ContradictionsResult['result']>(dir, 'contradictions', {});
}

interface ExplainResult {
  readonly found: boolean;
  readonly contradictions: readonly unknown[];
  readonly detectionAvailable: boolean;
  readonly unknownDetectors: ReadonlyArray<{
    readonly code: string;
    readonly scopes: readonly string[];
  }>;
}

const REPO_ID = 'demo:Repo:demo';

test('check --json lists a detector that stands down on the extracted Repo facts as UNKNOWN, with its reason and no scope', async () => {
  const dir = await extracted(UNTRACED);
  const report = await check(dir);
  assert.equal(
    report.outcome,
    'unknown',
    'a run with a detector UNKNOWN is never reported as clean',
  );
  assert.deepEqual(report.contradictions, []);
  assert.deepEqual(report.unknownDetectors, [
    {
      code: 'X5_UNWRITTEN_COLUMN',
      severity: 'medium',
      reason: '1 write call(s) could not be attributed to a table',
      scopes: [],
      scopeStatus: {},
    },
  ]);
});

test('the MCP contradictions tool lists the same detector, with no scope to blame', async () => {
  const dir = await extracted(UNTRACED);
  const body = await viaMcp(dir);
  assert.deepEqual(body.result.findings, []);
  assert.equal(body.result.unknownDetectors.length, 1);
  assert.equal(body.result.unknownDetectors[0]?.code, 'X5_UNWRITTEN_COLUMN');
  // The profile rebuilds every reason from facts it can vouch for (default-deny), so the detector's own
  // text is not passed on; what reaches the client names no scope, because no scope is to blame.
  assert.equal(
    body.result.unknownDetectors[0]?.reason,
    'the extractors recorded facts that leave this detector unable to answer',
  );
  assert.deepEqual(body.result.unknownDetectors[0]?.scopes, []);
  assert.match(body.notices.join('\n'), /UNKNOWN, not clean/);
});

test('with nothing unattributed the same detector speaks, on both surfaces', async () => {
  const dir = await extracted(TRACED);
  const report = await check(dir);
  assert.deepEqual(report.unknownDetectors, []);
  assert.deepEqual(
    report.contradictions.map((c) => c.code),
    ['X5_UNWRITTEN_COLUMN'],
  );
  const body = await viaMcp(dir);
  assert.deepEqual(body.result.unknownDetectors, []);
  assert.deepEqual(
    body.result.findings.map((f) => f.code),
    ['X5_UNWRITTEN_COLUMN'],
  );
});

test('the MCP explain tool does not read a detector that stood down as a verified negative', async () => {
  const dir = await extracted(UNTRACED);
  const body = await callMcp<ExplainResult>(dir, 'explain', { id: REPO_ID });
  assert.equal(body.result.found, true);
  assert.equal(body.result.detectionAvailable, true);
  assert.deepEqual(body.result.contradictions, []);
  assert.deepEqual(
    body.result.unknownDetectors.map((u) => u.code),
    ['X5_UNWRITTEN_COLUMN'],
  );
  assert.deepEqual(body.result.unknownDetectors[0]?.scopes, []);
  assert.match(
    body.notices.join('\n'),
    /1 detector\(s\) could not run: X5_UNWRITTEN_COLUMN\. Those checks are UNKNOWN, not clean\./,
  );
});

test('the MCP explain tool, on a repository where the detector runs, carries no UNKNOWN notice', async () => {
  const dir = await extracted(TRACED);
  const body = await callMcp<ExplainResult>(dir, 'explain', { id: REPO_ID });
  assert.equal(body.result.found, true);
  assert.deepEqual(body.result.unknownDetectors, []);
  assert.deepEqual(
    body.result.contradictions.map((c) => (c as { code: string }).code),
    ['X5_UNWRITTEN_COLUMN'],
  );
  assert.doesNotMatch(body.notices.join('\n'), /could not run/);
});

interface WhyJson {
  readonly contradictionsAvailable: boolean;
  readonly contradictions: readonly unknown[];
  readonly unknownDetectors: ReadonlyArray<{
    readonly code: string;
    readonly scopes: readonly string[];
  }>;
}

async function why(dir: string, json: boolean): Promise<{ code: number; session: Session }> {
  const d = session(dir);
  const code = await runCli(d, ['why', 'users.id', '--repo', dir, ...(json ? ['--json'] : [])]);
  return { code, session: d };
}

test('why --json lists a detector that stood down, so an empty contradictions list is not a verified negative', async () => {
  const dir = await extracted(UNTRACED);
  const { code, session: d } = await why(dir, true);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const report = JSON.parse(d.io.stdout()) as WhyJson;
  assert.equal(report.contradictionsAvailable, true);
  assert.deepEqual(
    report.unknownDetectors.map((u) => u.code),
    ['X5_UNWRITTEN_COLUMN'],
  );
});

test('why (human) does not print "none touching this lineage" in green when a detector could not run', async () => {
  const dir = await extracted(UNTRACED);
  const { code, session: d } = await why(dir, false);
  assert.equal(code, EXIT_OK, d.io.stderr());
  const out = d.io.stdout();
  assert.match(out, /1 detector\(s\) could not run: X5_UNWRITTEN_COLUMN/);
  assert.doesNotMatch(out, /none touching this lineage/);
});

test('why, where every detector ran, keeps its clean line and an empty unknownDetectors list', async () => {
  const dir = await extracted(TRACED);
  const json = await why(dir, true);
  const report = JSON.parse(json.session.io.stdout()) as WhyJson;
  assert.deepEqual(report.unknownDetectors, []);
  const human = await why(dir, false);
  assert.match(human.session.io.stdout(), /none touching this lineage/);
  assert.doesNotMatch(human.session.io.stdout(), /could not run/);
});

test('check (human): a detector that stood down for its own reason is not told to fix an extractor', async () => {
  const dir = await extracted(UNTRACED);
  const d = session(dir);
  assert.equal(await runCli(d, ['check', '--repo', dir]), EXIT_OK, d.io.stderr());
  const out = d.io.stdout();
  assert.match(out, /X5_UNWRITTEN_COLUMN {2}1 write call\(s\) could not be attributed to a table/);
  assert.doesNotMatch(out, /Fix the extractor/);
  assert.match(out, /stood down on facts the extractors recorded/);
});

test('check (human): a detector blocked by a scope is still told to fix the extractor', async () => {
  const dir = await repoWith(TRACED);
  const e = session(dir);
  assert.equal(
    await runCli(e, ['extract', '--repo', dir, '--only', 'extract-code-ts']),
    EXIT_OK,
    e.io.stderr(),
  );
  const blocked = defineDetector({
    code: 'X5_UNWRITTEN_COLUMN',
    severity: 'medium',
    requiredScopes: [SCOPE_DATA],
    description: 'fixture: needs the data scope, which this run did not produce',
    find: () => [],
  });
  const d = { ...session(dir), detectors: contradictionsDetectorPort([blocked]) };
  assert.equal(await runCli(d, ['check', '--repo', dir]), EXIT_OK, d.io.stderr());
  const out = d.io.stdout();
  assert.match(out, /Fix the extractor, then re-check/);
  assert.doesNotMatch(out, /stood down on facts/);
});
