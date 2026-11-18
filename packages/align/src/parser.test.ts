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
import {
  PARSER_FUNCTIONS,
  PARSER_SYNTAX_KINDS,
  SUPPORTED_TYPESCRIPT_RANGE,
  TYPESCRIPT_MISSING,
  faultText,
  parserLoadFailure,
  resolveParser,
} from './ts.ts';
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
  for (const version of ['5.9.3', '6.0.2', '7.0.0', '60.0.3']) {
    const refused = resolveParser({ ...ts, version });
    assert.equal(refused.ts, null, version);
    assert.equal(
      refused.unavailable,
      `the installed typescript ${version} is outside the supported range ^6.0.3`,
    );
  }
  for (const version of ['6.0.3', '6.0.4', '6.1.0', '6.9.12']) {
    assert.equal(resolveParser({ ...ts, version }).unavailable, null, version);
  }
  // In range by its version, but without the API: refused by what it lacks, not trusted by its label.
  assert.equal(
    resolveParser({ version: '6.0.3' }).unavailable,
    'the installed typescript 6.0.3 lacks the parser API the probes need (createSourceFile); the supported range is ^6.0.3',
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

  test(`${name}: an unread registry reads claims for catalog codes only, never for prose`, () => {
    const extra: Record<string, string> = {
      ...files,
      'docs/notes.md':
        'X9 does not fire on real repositories yet.\n\nx64 builds are not yet supported.\n',
      'docs/catalog.md': '| Code | Meaning |\n| --- | --- |\n| X1 | a |\n| X2 | b |\n| X7 | c |\n',
    };
    const withParser = run(extra);
    const without = run(extra, { ts: parser });
    for (const ran of [withParser, without]) {
      assert.equal(ran.find('detector:X64'), undefined, 'x64 in prose is not a detector');
      assert.equal(ran.find('detector:X9'), undefined, 'a marker for a code no catalog names');
    }
    // The registry holds X1 to X3. X7 is named by a catalog only: a claim when the registry is unread.
    assert.equal(withParser.find('detector:X7'), undefined);
    const x7 = without.find('detector:X7');
    assert.equal(x7?.class, 'Unknown');
    assert.equal(x7?.unknown?.detail, reason);
    assert.equal(without.packet.summary.claims, withParser.packet.summary.claims + 1);
    const probe = without.packet.inputs.probes.find((p) => p.probe === 'detector-liveness');
    assert.ok(
      probe?.diagnostics.some(
        (d) =>
          d.startsWith('registry: not read in full (probe-failed: ') &&
          d.includes('a catalog table names: X1, X2, X3, X7;'),
      ),
      (probe?.diagnostics ?? []).join('\n'),
    );
    // A tree with no registry has no detector claims at all, with or without a parser.
    const { 'packages/contradictions/src/detectors/index.ts': _registry, ...bare } = extra;
    for (const ran of [run(bare), run(bare, { ts: parser })])
      assert.deepEqual(
        ran.findings.filter((f) => f.claimKind === 'DETECTOR_LIVENESS'),
        [],
      );
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

test('the supported range has one definition: the bounds follow the range string', () => {
  assert.equal(resolveParser({ ...ts, version: '7.1.2' }, '^7.1.0').unavailable, null);
  assert.equal(resolveParser({ ...ts, version: '7.2.0' }, '^7.1.0').unavailable, null);
  for (const version of ['7.0.9', '6.9.9', '8.0.0']) {
    assert.equal(
      resolveParser({ ...ts, version }, '^7.1.0').unavailable,
      `the installed typescript ${version} is outside the supported range ^7.1.0`,
    );
  }
  // A range that is not a caret range with a major of at least 1 admits nothing.
  for (const range of ['>=6.0.3', '6.x', '^0.6.3', '~6.0.3', ''])
    assert.equal(resolveParser({ ...ts, version: '6.0.3' }, range).ts, null, range);
});

test('a prerelease or nightly build is outside the range, whatever its base version', () => {
  for (const version of ['6.0.3-rc', '6.1.0-beta', '6.1.0-dev.20261101', '7.0.0-dev.20261101']) {
    const refused = resolveParser({ ...ts, version });
    assert.equal(refused.ts, null, version);
    assert.equal(
      refused.unavailable,
      `the installed typescript ${version} is outside the supported range ^6.0.3 (a prerelease or nightly build is not in it)`,
    );
  }
});

test('an in-range module without any one member the probes use is refused by name', () => {
  for (const name of PARSER_FUNCTIONS) {
    assert.equal(
      resolveParser({ ...ts, version: '6.0.3', [name]: undefined }).unavailable,
      `the installed typescript 6.0.3 lacks the parser API the probes need (${name}); the supported range is ^6.0.3`,
    );
  }
  for (const kind of PARSER_SYNTAX_KINDS) {
    const refused = resolveParser({
      ...ts,
      version: '6.0.3',
      SyntaxKind: { ...ts.SyntaxKind, [kind]: undefined },
    });
    assert.match(refused.unavailable ?? '', new RegExp(`\\(SyntaxKind\\.${kind}\\)`));
  }
  assert.match(
    resolveParser({ ...ts, version: '6.0.3', ScriptTarget: {} }).unavailable ?? '',
    /\(ScriptTarget\.Latest\)/,
  );
  // Inspecting a module never throws.
  const trap = new Proxy(
    {},
    {
      get: () => {
        throw new Error('trap');
      },
    },
  );
  assert.equal(
    resolveParser(trap).unavailable,
    'the installed typescript could not be inspected: trap',
  );
});

test('an in-range module that lacks a used member gives Unknown with the reason, and no throw', async () => {
  const lacking = { ...ts, version: '6.0.3', isSatisfiesExpression: undefined };
  const reason =
    'the installed typescript 6.0.3 lacks the parser API the probes need (isSatisfiesExpression); the supported range is ^6.0.3';
  const ran = run(files, { ts: lacking });
  for (const suffix of PARSER_FINDINGS) {
    assert.equal(ran.find(suffix)?.class, 'Unknown', suffix);
    assert.equal(ran.find(suffix)?.unknown?.detail, reason, suffix);
  }
  assert.ok((await output({ ts: lacking })).includes(`Unknown: ${reason}, so 2 probe(s)`));
});

test('a parser that faults while a probe runs gives Unknown with the fault, and no throw', async () => {
  const faulty = {
    ...ts,
    version: '6.0.3',
    createSourceFile: () => {
      throw new TypeError('boom in /srv/app/node_modules/typescript/lib/typescript.js\nat line 2');
    },
  };
  const ran = run(files, { ts: faulty });
  const csv = ran.find('output-format:csv');
  assert.equal(csv?.class, 'Unknown');
  assert.equal(csv?.reason, 'probe-failed');
  assert.equal(csv?.unknown?.detail, 'the format-witness probe stopped: boom in <path>');
  const x1 = ran.find('detector:X1');
  assert.equal(x1?.class, 'Unknown');
  assert.equal(
    x1?.unknown?.detail,
    'reading packages/contradictions/src/detectors/index.ts stopped: boom in <path>',
  );
  assert.doesNotMatch(ran.bytes, /srv\/app/);
  assert.equal(ran.find('RUNTIME_FLOOR:runtime:node')?.class, 'Observed drift');
  assert.match(await output({ ts: faulty }), /Unknown\s+7\n/);
});

const REGISTRY = 'packages/contradictions/src/detectors/index.ts';
for (const [name, registry, reasonCode, detail, known] of [
  [
    'with syntax errors',
    'export const ALL_DETECTORS = [x1, x2,;\n',
    'source-unreadable',
    `${REGISTRY} has syntax errors`,
    [],
  ],
  [
    'whose ALL_DETECTORS is not an array literal',
    "import { build } from './build.ts';\n\nexport const ALL_DETECTORS = build();\n",
    'reads-unresolvable',
    `${REGISTRY} does not declare ALL_DETECTORS as an array literal`,
    [],
  ],
  [
    'with an element that does not resolve',
    "import { detector as x1 } from './x1.ts';\nimport { detector as x2 } from './x2.ts';\nimport { detector as x3 } from './gone.ts';\n\nexport const ALL_DETECTORS = [x1, x2, x3];\n",
    'reads-unresolvable',
    `${REGISTRY}: x3 in ALL_DETECTORS does not resolve to a detector file whose code can be read`,
    ['X1', 'X2'],
  ],
] as const) {
  test(`a registry ${name} is unread, not empty: its catalog codes are Unknown, with a parser present`, () => {
    const ran = run({
      ...files,
      [REGISTRY]: registry,
      'docs/notes.md': 'x64 builds are not yet supported.\n',
    });
    for (const code of ['X1', 'X2', 'X3']) {
      const finding = ran.find(`detector:${code}`);
      if ((known as readonly string[]).includes(code)) {
        assert.notEqual(finding?.unknown?.detail, detail, `${code} was read and is probed`);
        continue;
      }
      assert.equal(finding?.class, 'Unknown', code);
      assert.equal(finding?.reason, reasonCode, code);
      assert.equal(finding?.unknown?.detail, detail, code);
    }
    assert.equal(ran.find('detector:X64'), undefined);
    assert.equal(run(files).packet.summary.claims, ran.packet.summary.claims);
  });
}

test('an oversized registry is unread with the bound as the reason', () => {
  const ran = run(
    { ...files, [REGISTRY]: `${files[REGISTRY] ?? ''}// ${'x'.repeat(400)}\n` },
    { limits: { maxSourceBytes: 300 } },
  );
  assert.equal(ran.find('detector:X2')?.reason, 'limit-exceeded');
  assert.match(ran.find('detector:X2')?.unknown?.detail ?? '', /over the bound of 300/);
});

test('only a missing typescript package is "not installed"; another load error is named', () => {
  const notFound = Object.assign(
    new Error(
      "Cannot find package 'typescript' imported from /srv/app/node_modules/@seamline/align/dist/ts.js",
    ),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
  assert.equal(parserLoadFailure(notFound).unavailable, TYPESCRIPT_MISSING);
  const inner = Object.assign(
    new Error(
      "Cannot find module '/srv/app/node_modules/typescript/lib/typescript.js' imported from /srv/app/x.js",
    ),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
  assert.equal(
    parserLoadFailure(inner).unavailable,
    "the installed typescript failed to load: Cannot find module '<path>' imported from <path>",
  );
  assert.equal(
    parserLoadFailure(new SyntaxError('Unexpected token')).unavailable,
    'the installed typescript failed to load: Unexpected token',
  );
  assert.equal(parserLoadFailure(new SyntaxError('Unexpected token')).ts, null);
});

test('fault diagnostics stay total when a thrown value cannot be converted to text', () => {
  const noPrimitive = Object.create(null) as object;
  const badMessage = Object.defineProperty(new Error('unreadable'), 'message', {
    get() {
      throw undefined;
    },
  });
  for (const error of [noPrimitive, badMessage]) {
    assert.equal(faultText(error), 'unprintable error');
    assert.deepEqual(parserLoadFailure(error), {
      ts: null,
      unavailable: 'the installed typescript failed to load: unprintable error',
    });
    const parser = new Proxy(
      {},
      {
        get: () => {
          throw error;
        },
      },
    );
    assert.deepEqual(resolveParser(parser), {
      ts: null,
      unavailable: 'the installed typescript could not be inspected: unprintable error',
    });
  }
});

test('load failure classification does not let an unreadable error code escape', () => {
  const error = Object.defineProperty(new Error('load stopped'), 'code', {
    get() {
      throw new Error('unreadable code');
    },
  });
  assert.deepEqual(parserLoadFailure(error), {
    ts: null,
    unavailable: 'the installed typescript failed to load: load stopped',
  });
});

test('a non-stringable parser fault remains Unknown through the actual evaluation', () => {
  const faulty = {
    ...ts,
    version: '6.0.3',
    createSourceFile: () => {
      throw Object.create(null);
    },
  };
  const ran = run(files, { ts: faulty });
  for (const suffix of PARSER_FINDINGS) {
    const finding = ran.find(suffix);
    assert.equal(finding?.class, 'Unknown', suffix);
    assert.equal(finding?.reason, 'probe-failed', suffix);
    assert.match(finding?.unknown?.detail ?? '', /unprintable error$/);
  }
  assert.equal(ran.find('RUNTIME_FLOOR:runtime:node')?.class, 'Observed drift');
});

test('the version gate admits release build metadata and rejects leading-zero core numbers', () => {
  for (const version of ['6.0.3+build.1', '6.1.0+00.local', '6.1000000.0']) {
    const candidate = { ...ts, version };
    assert.equal(resolveParser(candidate).ts === candidate, true, version);
  }
  for (const version of ['06.0.3', '6.00.3', '6.0.03', '6.0.3+', '6.0.3+build..1']) {
    assert.equal(resolveParser({ ...ts, version }).ts, null, version);
  }
  for (const version of ['6.0.3-rc+build.1', '6.1.0-beta+00']) {
    assert.equal(resolveParser({ ...ts, version }).ts, null, version);
  }
});

test('non-finite, fractional and negative compiler enum members are refused before a probe runs', () => {
  for (const value of [NaN, Infinity, -1, 1.5]) {
    const target = resolveParser({ ...ts, ScriptTarget: { ...ts.ScriptTarget, Latest: value } });
    assert.equal(target.ts === null, true, `ScriptTarget.Latest=${String(value)}`);
    assert.match(target.unavailable ?? '', /\(ScriptTarget\.Latest\)/);
    for (const kind of PARSER_SYNTAX_KINDS) {
      const parser = resolveParser({ ...ts, SyntaxKind: { ...ts.SyntaxKind, [kind]: value } });
      assert.equal(parser.ts === null, true, `SyntaxKind.${kind}=${String(value)}`);
      assert.ok(parser.unavailable?.includes(`(SyntaxKind.${kind})`));
    }
  }
});
