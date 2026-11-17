/**
 * The optional parser (design 5.2, section 9): a missing `typescript`, or one the probes cannot
 * use, makes the parsing probes answer Unknown, and every output says why. A thin report is never
 * mistaken for a clean one, no claim disappears, and nothing throws.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as ts from 'typescript';
import { COMMIT, caseFiles, factsFor, run } from './__fixtures__/build.ts';
import { runAlign, type AlignRequest } from './run.ts';
import { summaryObject, summaryText } from './summary.ts';
import { SUPPORTED_TYPESCRIPT_RANGE, TYPESCRIPT_MISSING, resolveParser } from './ts.ts';
import { memTree } from './tree.ts';
import { redactPacket } from './redact.ts';
import type { AlignSink } from './write.ts';

/** What `import('typescript')` gives with TypeScript 7 installed: a version and no compiler API. */
const TYPESCRIPT_7 = { version: '7.0.2', versionMajorMinor: '7.0' };
const OUT_OF_RANGE = 'the installed typescript 7.0.2 is outside the supported range ^6.0.3';

/** A README naming a detector code the registry does not hold, beside the fixture's catalog. */
const files = caseFiles({ extraReadme: 'X1 does not fire on real repositories yet.' });

const PARSER_FINDINGS = [
  'OUTPUT_FORMAT_SET:cli:output-format:csv',
  'OUTPUT_FORMAT_SET:cli:output-format:json',
  'OUTPUT_FORMAT_SET:cli:output-format:mermaid',
  'DETECTOR_LIVENESS:detector:X1',
  'DETECTOR_LIVENESS:detector:X2',
  'DETECTOR_LIVENESS:detector:X3',
];

function request(over: Partial<AlignRequest>): AlignRequest {
  return {
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
  };
}

async function output(over: Partial<AlignRequest>): Promise<string> {
  const out: string[] = [];
  const sink: AlignSink = { stdout: (t) => void out.push(t), file: () => undefined };
  await runAlign(request(over), sink);
  return out.join('');
}

test('the supported range is the peer range the package manifest declares', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { peerDependencies: Record<string, string> };
  assert.equal(SUPPORTED_TYPESCRIPT_RANGE, manifest.peerDependencies['typescript']);
});

test('resolveParser accepts the installed parser and refuses every other value with a reason', () => {
  assert.equal(resolveParser(ts).unavailable, null);
  assert.equal(resolveParser(ts).ts, ts);
  assert.deepEqual(resolveParser(null), { ts: null, unavailable: TYPESCRIPT_MISSING });
  assert.deepEqual(resolveParser(undefined), { ts: null, unavailable: TYPESCRIPT_MISSING });
  assert.deepEqual(resolveParser(TYPESCRIPT_7), { ts: null, unavailable: OUT_OF_RANGE });
  for (const version of ['5.9.3', '6.0.2', '7.0.0-dev.20261101', '60.0.3']) {
    const refused = resolveParser({ ...ts, version });
    assert.equal(refused.ts, null, version);
    assert.equal(
      refused.unavailable,
      `the installed typescript ${version} is outside the supported range ^6.0.3`,
    );
  }
  for (const version of ['6.0.3', '6.1.0', '6.9.12']) {
    assert.equal(resolveParser({ ...ts, version }).unavailable, null, version);
  }
  // In range by its version, but without the API: refused by what it lacks, not trusted by its label.
  assert.equal(
    resolveParser({ version: '6.0.3' }).unavailable,
    'the installed typescript 6.0.3 lacks the parser API the probes need (createSourceFile); the supported range is ^6.0.3',
  );
  assert.match(
    resolveParser({ ...ts, version: '6.0.3', ScriptTarget: undefined }).unavailable ?? '',
    /lacks the parser API the probes need \(ScriptTarget\)/,
  );
  // A version that is not a plain semver string is not echoed into a report.
  for (const hostile of [
    { ...ts, version: '7.0.2\u001b[31m\nCRITICAL' },
    { ...ts, version: 7 },
    'typescript',
    7,
  ]) {
    assert.equal(
      resolveParser(hostile).unavailable,
      'the installed typescript reports no recognisable version; the supported range is ^6.0.3',
    );
  }
});

for (const [name, parser, reason] of [
  ['a missing parser', null, TYPESCRIPT_MISSING],
  ['an out-of-range TypeScript 7 module', TYPESCRIPT_7, OUT_OF_RANGE],
] as const) {
  test(`${name}: the packet gives the reason on every finding and probe it touched`, () => {
    const ran = run(files, { ts: parser });
    for (const suffix of PARSER_FINDINGS) {
      const finding = ran.find(suffix);
      assert.equal(finding?.class, 'Unknown', suffix);
      assert.equal(finding?.reason, 'probe-failed', suffix);
      assert.equal(finding?.unknown?.detail, reason, suffix);
      assert.equal(finding?.fact?.status, 'FAIL', suffix);
      assert.equal(finding?.fact?.detail, reason, suffix);
    }
    const probes = new Map(ran.packet.inputs.probes.map((p) => [p.probe, p] as const));
    for (const probe of ['detector-liveness', 'format-witness']) {
      assert.equal(probes.get(probe)?.status, 'FAIL', probe);
      assert.equal(probes.get(probe)?.diagnostics[0], `parser unavailable: ${reason}`, probe);
    }
    // The probes that read manifests and the graph still ran and say nothing about the parser.
    for (const probe of ['manifest-field', 'module-wiring']) {
      assert.deepEqual(
        probes.get(probe)?.diagnostics.filter((d) => d.includes('parser')),
        [],
        probe,
      );
    }
    assert.equal(ran.find('RUNTIME_FLOOR:runtime:node')?.class, 'Observed drift');
    assert.equal(ran.packet.schemaVersion, 1);
  });

  test(`${name}: no claim disappears, and no absence or drift is concluded from the unread source`, () => {
    const withParser = run(files);
    const without = run(files, { ts: parser });
    assert.equal(without.packet.summary.claims, withParser.packet.summary.claims);
    assert.deepEqual(
      without.packet.inputs.docs.map((d) => [d.path, d.claims]),
      withParser.packet.inputs.docs.map((d) => [d.path, d.claims]),
    );
    // With the parser csv and mermaid are gaps; without it they are not called gaps or aligned.
    assert.equal(withParser.find('output-format:csv')?.class, 'Unexplained gap');
    assert.deepEqual(
      without.findings
        .filter((f) => f.fact?.probe === 'format-witness' || f.fact?.probe === 'detector-liveness')
        .filter((f) => f.fact?.result !== 'UNKNOWN')
        .map((f) => f.id),
      [],
    );
    assert.equal(without.packet.summary.classes['Unexplained gap'], 0);
  });

  test(`${name}: an unread registry keeps a code it cannot place, as Unknown`, () => {
    const extra: Record<string, string> = {
      ...files,
      'docs/notes.md': 'X9 does not fire on real repositories yet.\n',
    };
    assert.equal(run(extra).find('detector:X9'), undefined, 'outside the registry: no claim');
    const finding = run(extra, { ts: parser }).find('detector:X9');
    assert.equal(finding?.class, 'Unknown');
    assert.equal(finding?.unknown?.detail, reason);
    const probe = run(extra, { ts: parser }).packet.inputs.probes.find(
      (p) => p.probe === 'detector-liveness',
    );
    assert.ok(probe?.diagnostics.some((d) => d.startsWith('registry: not read')));
    // A tree with no registry has no detector claims at all, with or without a parser.
    const { 'packages/contradictions/src/detectors/index.ts': _registry, ...bare } = extra;
    assert.equal(run(bare, { ts: parser }).find('detector:X9'), undefined);
  });

  test(`${name}: the human summary states once why the report is thin`, async () => {
    const text = await output({ ts: parser });
    const stated = text.split('\n').filter((l) => l.includes(reason));
    assert.deepEqual(stated, [
      `Unknown: ${reason}, so 2 probe(s) that parse TypeScript did not run (detector-liveness, format-witness). Every claim they check is Unknown (probe-failed), not clean. Install typescript@^6.0.3 next to the CLI for a full report.`,
    ]);
    assert.ok(text.indexOf(reason) < text.indexOf('Observed drift'), 'before the class counts');
    assert.match(text, /detector:X1 {2}\(probe-failed: no usable typescript parser\)/);
    assert.match(text, /output-format:csv {2}\(probe-failed: no usable typescript parser\)/);
    assert.match(text, /Unknown\s+7\n/);
  });

  test(`${name}: the JSON summary carries the reason and the probes that did not run`, async () => {
    const summary = JSON.parse(
      await output({ ts: parser, output: { packet: false, json: true } }),
    ) as {
      parser: unknown;
      classes: Record<string, number>;
    };
    assert.deepEqual(summary.parser, {
      available: false,
      probesNotRun: ['detector-liveness', 'format-witness'],
      reason,
    });
    assert.equal(summary.classes['Unknown'], 7);
  });

  test(`${name}: the packet written through runAlign carries the reason`, async () => {
    const packet = JSON.parse(
      await output({ ts: parser, output: { packet: true, file: null, json: false } }),
    ) as { inputs: { probes: { probe: string; diagnostics: string[] }[] } };
    assert.deepEqual(
      packet.inputs.probes
        .filter((p) => p.diagnostics.includes(`parser unavailable: ${reason}`))
        .map((p) => p.probe)
        .sort(),
      ['detector-liveness', 'format-witness'],
    );
  });
}

test('with a usable parser the summaries say nothing about it', () => {
  const sealed = redactPacket(run(files).body);
  assert.deepEqual(summaryObject(sealed).parser, {
    available: true,
    probesNotRun: [],
    reason: null,
  });
  assert.doesNotMatch(summaryText(sealed), /typescript/);
  assert.doesNotMatch(run(files).bytes, /parser unavailable/);
});
