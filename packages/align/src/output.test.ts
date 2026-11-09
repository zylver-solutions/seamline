import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMIT, caseFiles, factsFor, run, runCase } from './__fixtures__/build.ts';
import { AlignError } from './errors.ts';
import { readBaseline } from './baseline.ts';
import { redactPacket, RedactedPacket } from './redact.ts';
import { runAlign, type AlignRequest } from './run.ts';
import { summaryJson, summaryObject, summaryText } from './summary.ts';
import { gitTree, memTree, resolveCommit, worktreeTree } from './tree.ts';
import { Rendered, renderPacket, writeOutput, type AlignSink } from './write.ts';

/** A credential-shaped canary the redactor recognises (a GitHub personal access token shape). */
const CANARY = `ghp_${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5'}`;

function sinkOf(): AlignSink & { out: string[]; files: Map<string, string> } {
  const out: string[] = [];
  const files = new Map<string, string>();
  return { out, files, stdout: (t) => void out.push(t), file: (p, t) => void files.set(p, t) };
}

const request = (over: Partial<AlignRequest> = {}, files = caseFiles()): AlignRequest => ({
  repoRoot: '/nowhere',
  repo: 'fx',
  at: null,
  worktree: false,
  facts: factsFor(files),
  baselineText: null,
  config: {},
  output: { packet: false, json: false },
  producer: { toolVersion: '0.0.0-test', sifVersion: '1.0.0' },
  tree: { tree: memTree(files), commit: COMMIT },
  ...over,
});

describe('redaction: the existing redactor is the sole writer (8.5)', () => {
  test('a canary planted in a document sentence, in a manifest value and in a code identifier appears nowhere in the bytes', async () => {
    const files = caseFiles({
      formats: `Output is JSON, CSV, and Mermaid from the CLI. The deploy token is ${CANARY} for now.`,
      engines: `>=20.3.0 ${CANARY}`,
      files: {
        'packages/guard/src/guard.ts': `export function guard${CANARY.replace(/_/g, '')}(): boolean {\n  return true;\n}\n`,
      },
    });
    const ran = run(files);
    assert.ok(!ran.bytes.includes(CANARY), 'the packet carries a credential');
    assert.ok(
      !ran.bytes.includes(CANARY.replace(/_/g, '')),
      'the packet carries the identifier canary',
    );
    assert.match(ran.bytes, /\[REDACTED|redacted|secret/i);
    assert.equal(ran.find('runtime:node')?.reason, 'unsupported-range');
    assert.match(ran.find('runtime:node')?.unknown?.detail ?? '', /unsupported|comparator/);
    const sink = sinkOf();
    await runAlign(
      request({ output: { packet: true, file: 'packet.json', json: true } }, files),
      sink,
    );
    const everything = [...sink.out, ...sink.files.values()].join('\n');
    assert.ok(!everything.includes(CANARY));
  });

  test('a canary in a document’s path refuses the whole packet, names the field, and never repeats the credential', async () => {
    const files = { ...caseFiles(), [`docs/${CANARY}.md`]: 'text\n' };
    const sink = sinkOf();
    await assert.rejects(
      () => runAlign(request({}, files), sink),
      (error: unknown) => {
        assert.ok(error instanceof AlignError);
        assert.equal(error.kind, 'runtime');
        assert.match(error.message, /inputs\.docs\[\]\.path/);
        assert.ok(!error.message.includes(CANARY));
        return true;
      },
    );
    assert.deepEqual(sink.out, [], 'nothing is written');
    assert.equal(sink.files.size, 0);
  });

  test('a canary in a subject refuses the packet too (identity is never rewritten)', () => {
    const body = runCase().body;
    const poisoned = { ...body, repo: `fx-${CANARY}` };
    assert.throws(
      () => redactPacket(poisoned),
      (e: unknown) => e instanceof AlignError && !e.message.includes(CANARY),
    );
  });

  test('a RedactedPacket cannot be constructed outside the redaction function', () => {
    const packet = runCase().packet;
    assert.throws(() => new RedactedPacket(Symbol('forged'), packet), TypeError);
    assert.throws(() => new Rendered(Symbol('forged'), 'x'), TypeError);
    assert.throws(
      () => writeOutput(sinkOf(), { to: 'stdout' }, { text: 'raw' } as unknown as Rendered),
      TypeError,
    );
  });
});

describe('one write site (8.5)', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const sources = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('__fixtures__'));

  test('exactly one source file of the package writes a file or stdout, and it does so in exactly one function', () => {
    const WRITES =
      /\b(?:writeFileSync|writeFile|appendFile|appendFileSync|createWriteStream|process\.stdout|process\.stderr|console\.\w+|sink\.stdout|sink\.file|\.stdout\(|\.file\()/;
    const writers = sources.filter((f) =>
      WRITES.test(readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
    );
    assert.deepEqual(writers, ['write.ts']);
    const text = readFileSync(join(dir, 'write.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      '',
    );
    const body = text.slice(text.indexOf('export function writeOutput'));
    assert.equal((text.match(/sink\.stdout\(/g) ?? []).length, 1);
    assert.equal((text.match(/sink\.file\(/g) ?? []).length, 1);
    assert.ok(
      body.includes('sink.stdout(') && body.includes('sink.file('),
      'both calls sit in writeOutput',
    );
  });

  test('the package imports no network, process or child-process module outside the tree reader', () => {
    for (const file of sources) {
      const text = readFileSync(join(dir, file), 'utf8');
      assert.ok(!/from 'node:(?:net|http|https|dgram|tls|dns|worker_threads|vm)'/.test(text), file);
      if (file !== 'tree.ts')
        assert.ok(!/node:child_process/.test(text), `${file} spawns a process`);
    }
  });

  test('every output mode goes through the write site: summaries are projections of the redacted packet', async () => {
    const files = caseFiles({
      formats: `Output is JSON, CSV, and Mermaid from the CLI. Token ${CANARY}.`,
    });
    for (const output of [
      { packet: false, json: false },
      { packet: false, json: true },
      { packet: true, file: null, json: false },
      { packet: true, file: 'out.json', json: true },
    ] as const) {
      const sink = sinkOf();
      await runAlign(request({ output }, files), sink);
      assert.ok(sink.out.length > 0);
      assert.ok(
        ![...sink.out, ...sink.files.values()].some((t) => t.includes(CANARY)),
        JSON.stringify(output),
      );
    }
  });
});

describe('outputs (8.8)', () => {
  test('without a profile: a human summary, or a summary object with only id, class, claimKind, member and reason', async () => {
    const sink = sinkOf();
    await runAlign(request({ output: { packet: false, json: true } }), sink);
    const summary = JSON.parse(sink.out.join('')) as ReturnType<typeof summaryObject>;
    assert.equal(summary.schema, 'seamline.alignment-summary');
    assert.deepEqual(Object.keys(summary.findings[0] ?? {}), [
      'claimKind',
      'class',
      'id',
      'member',
      'reason',
    ]);
    assert.equal(summary.classes['Unexplained gap'], 3);
    const text = sink.out.join('');
    assert.ok(
      !text.includes('excerpt') &&
        !text.includes('observed') &&
        !text.includes('docs/toolchain.md'),
      'no excerpt, observed value or path',
    );
    const human = sinkOf();
    await runAlign(request(), human);
    assert.match(human.out.join(''), /pairing asserted \(asserted by the caller, not verified\)/);
    assert.match(human.out.join(''), /exits 0 whatever it finds/);
  });

  test('a document that was not read in full is named in the summary, so 0 drift is never silently clean', async () => {
    const files = caseFiles();
    const base = sinkOf();
    await runAlign(request({ output: { packet: false, json: true } }, files), base);
    const baseSummary = JSON.parse(base.out.join('')) as ReturnType<typeof summaryObject>;
    assert.deepEqual(baseSummary.documentsNotReadInFull, { count: 0, reasons: {} });
    const big = {
      ...files,
      'README.md': `${files['README.md'] ?? ''}\n${'x '.repeat(700 * 1024)}\n`,
    };
    const sink = sinkOf();
    await runAlign(request({ output: { packet: false, json: true } }, big), sink);
    const summary = JSON.parse(sink.out.join('')) as ReturnType<typeof summaryObject>;
    assert.deepEqual(summary.documentsNotReadInFull, {
      count: 1,
      reasons: { 'limit-exceeded': 1 },
    });
    assert.ok(!sink.out.join('').includes('README.md'), 'no path in the summary');
    const human = sinkOf();
    await runAlign(request({}, big), human);
    assert.match(
      human.out.join(''),
      /Unknown: 1 document\(s\) not read in full \(limit-exceeded: 1\)/,
    );
    const clean = sinkOf();
    await runAlign(request({}, files), clean);
    assert.ok(!clean.out.join('').includes('not read in full'));
  });

  test('a packet to stdout is exactly the canonical bytes; with a file, the file holds the packet and stdout the summary', async () => {
    const stdout = sinkOf();
    const redacted = await runAlign(
      request({ output: { packet: true, file: null, json: false } }),
      stdout,
    );
    assert.deepEqual(stdout.out, [redacted.bytes]);
    const file = sinkOf();
    await runAlign(request({ output: { packet: true, file: 'p.json', json: false } }), file);
    assert.equal(file.files.get('p.json'), redacted.bytes);
    assert.match(file.out.join(''), /Unexplained gap/);
  });

  test('summaries are projections of the redacted packet and agree with it', () => {
    const redacted = redactPacket(runCase().body);
    assert.equal(
      JSON.parse(summaryJson(redacted)).findings.length,
      redacted.packet.findings.length,
    );
    assert.match(summaryText(redacted), /Unexplained gap\s+3/);
    assert.equal(renderPacket(redacted).text, redacted.bytes);
  });
});

describe('the baseline is read as data (7)', () => {
  const written = (): string => runCase().bytes;

  test('a packet written by align is a valid baseline: its digest verifies', () => {
    const baseline = readBaseline(written());
    assert.match(baseline.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(baseline.findings.length, 5);
  });

  test('a changed packet, a different schema version, a different schema and non-JSON are usage errors', () => {
    const text = written();
    for (const bad of [
      text.replace('"Unexplained gap"', '"Planned gap"'),
      text.replace('"schemaVersion": 1', '"schemaVersion": 2'),
      text.replace('seamline.alignment-packet', 'other'),
      'not json',
    ]) {
      assert.throws(
        () => readBaseline(bad),
        (e: unknown) => e instanceof AlignError && e.kind === 'usage',
      );
    }
  });

  test('a baseline reformatted without changing its content still verifies', () => {
    assert.doesNotThrow(() => readBaseline(JSON.stringify(JSON.parse(written()))));
  });
});

describe('the tree is read from the git object database (3.1)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8' },
    );

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'align-tree-'));
    dirs.push(dir);
    git(dir, 'init', '-q');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), 'committed text\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'one');
    return dir;
  }

  test('files are read at the evaluated commit, never from a working tree that moved', () => {
    const dir = repo();
    const commit = resolveCommit(dir, 'HEAD');
    writeFileSync(join(dir, 'docs', 'a.md'), 'edited in the working tree\n');
    writeFileSync(join(dir, 'untracked.md'), 'not tracked\n');
    const tree = gitTree(dir, commit);
    assert.deepEqual(tree.tracked, ['docs/a.md', 'package.json']);
    assert.equal(
      new TextDecoder().decode(tree.read('docs/a.md') ?? new Uint8Array()),
      'committed text\n',
    );
    assert.equal(tree.size('docs/a.md'), 15);
    const work = worktreeTree(dir);
    assert.equal(
      new TextDecoder().decode(work.read('docs/a.md') ?? new Uint8Array()),
      'edited in the working tree\n',
    );
    assert.deepEqual(work.tracked, ['docs/a.md', 'package.json']);
  });

  test('an unknown revision is a usage error, and so is something that looks like an option', () => {
    const dir = repo();
    for (const rev of ['no-such-rev', '--help', '']) {
      assert.throws(
        () => resolveCommit(dir, rev),
        (e: unknown) => e instanceof AlignError && e.kind === 'usage',
        rev,
      );
    }
    assert.match(resolveCommit(dir, 'HEAD'), /^[0-9a-f]{40}$/);
  });

  test('symbolic links and submodules are not regular files of the tree', () => {
    const dir = repo();
    symlinkSync('docs/a.md', join(dir, 'link.md'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'two');
    assert.deepEqual(gitTree(dir, resolveCommit(dir, 'HEAD')).tracked, [
      'docs/a.md',
      'package.json',
    ]);
  });
});
