import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  claimDigest,
  dormancyMarkers,
  extractClaims,
  matchFormatTemplates,
  prepareLabel,
  type ClaimContext,
} from './claims.ts';
import {
  EXTRACT_CONTRACTS_README_3,
  README_FORMATS_PREFIX,
  README_FORMATS_MAIN,
  README_X10_MAIN,
  REAL_WORLD_INPUTS_356,
  THREATMODEL_CONTROLS_PREFIX,
  THREATMODEL_CONTROLS_MAIN,
  V3_DEFERRED_260,
} from './__fixtures__/frozen.ts';
import { prepareSentences } from './scan.ts';
import type { ClaimKind } from './types.ts';

const REGISTRY = new Set(['X1', 'X2', 'X3', 'X10']);

function context(over: Partial<ClaimContext> = {}): ClaimContext {
  const existing = new Set([
    'packages/core',
    'packages/cli',
    'packages/mcp',
    'scripts/license-gate.mjs',
    'packages/guard/src/guard.ts',
  ]);
  return {
    commit: 'c'.repeat(40),
    registryCodes: REGISTRY,
    pathExists: (p) => existing.has(p),
    packageNameOf: () => null,
    scan: { maxLineLength: 4096 },
    ...over,
  };
}

/** `kind|subject|polarity|value` of each claim, in document order. */
function read(doc: string, over: Partial<ClaimContext> = {}, path = 'README.md'): string[] {
  return extractClaims(path, doc, context(over)).claims.map(
    (c) => `${c.kind}|${c.subject}|${c.polarity}|${c.value ?? ''}`,
  );
}

interface Pair {
  readonly name: string;
  readonly kind: ClaimKind;
  readonly doc: string;
  /** What the grammar must produce. Empty is a does-not-fire case. */
  readonly expect: readonly string[];
}

const F = (members: Record<string, string>): string[] =>
  Object.entries(members).map(
    ([m, polarity]) => `OUTPUT_FORMAT_SET|cli:output-format:${m}|${polarity}|`,
  );

const PAIRS: Pair[] = [
  // ---- RUNTIME_FLOOR (4.1)
  {
    name: 'floor: list-item lead label',
    kind: 'RUNTIME_FLOOR',
    doc: '- **Node >= 22.11, developed on 24.** The floor.\n',
    expect: ['RUNTIME_FLOOR|runtime:node|AFFIRM|22.11.0'],
  },
  {
    name: 'floor: the single-character operator',
    kind: 'RUNTIME_FLOOR',
    doc: '- **Node ≥ 20** yes\n',
    expect: ['RUNTIME_FLOOR|runtime:node|AFFIRM|20.0.0'],
  },
  {
    name: 'floor: Node.js and a three-part version',
    kind: 'RUNTIME_FLOOR',
    doc: '- **Node.js >= 18.17.1** yes\n',
    expect: ['RUNTIME_FLOOR|runtime:node|AFFIRM|18.17.1'],
  },
  {
    name: 'floor: pnpm',
    kind: 'RUNTIME_FLOOR',
    doc: '- **pnpm >= 9** yes\n',
    expect: ['RUNTIME_FLOOR|runtime:pnpm|AFFIRM|9.0.0'],
  },
  {
    name: 'floor: first column of a table',
    kind: 'RUNTIME_FLOOR',
    doc: '| Requirement | Why |\n| --- | --- |\n| Node >= 22.13 | built in |\n| `pnpm` >= 10 | workspace |\n',
    expect: [
      'RUNTIME_FLOOR|runtime:node|AFFIRM|22.13.0',
      'RUNTIME_FLOOR|runtime:pnpm|AFFIRM|10.0.0',
    ],
  },
  {
    name: 'floor: > ^ ~ = match nothing',
    kind: 'RUNTIME_FLOOR',
    doc: '- **Node > 20**\n- **Node ^20**\n- **Node ~20**\n- **Node = 20**\n',
    expect: [],
  },
  {
    name: 'floor: a paragraph is not an anchor',
    kind: 'RUNTIME_FLOOR',
    doc: 'Node >= 22 is needed.\n',
    expect: [],
  },
  {
    name: 'floor: the bold span must begin the item',
    kind: 'RUNTIME_FLOOR',
    doc: '- You need **Node >= 22** here.\n',
    expect: [],
  },
  {
    name: 'floor: a second column cell is not an anchor',
    kind: 'RUNTIME_FLOOR',
    doc: '| Why | Requirement |\n| --- | --- |\n| built in | Node >= 22 |\n',
    expect: [],
  },
  // ---- OUTPUT_FORMAT_SET (4.2)
  {
    name: 'format: T1 bare subject with the tail',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'Output is JSON, CSV, and Mermaid from the CLI.\n',
    expect: F({ json: 'AFFIRM', csv: 'AFFIRM', mermaid: 'AFFIRM' }),
  },
  {
    name: 'format: T1 with the CLI as subject',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'The CLI output is text and JSON.\n',
    expect: F({ text: 'AFFIRM', json: 'AFFIRM' }),
  },
  {
    name: 'format: T2',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'The CLI emits JSON and YAML output.\n',
    expect: F({ json: 'AFFIRM', yaml: 'AFFIRM' }),
  },
  {
    name: 'format: M1 not implemented',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'CSV and Mermaid output are not implemented.\n',
    expect: F({ csv: 'ABSENT', mermaid: 'ABSENT' }),
  },
  {
    name: 'format: M2 deferred',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'CSV or Mermaid support is planned.\n',
    expect: F({ csv: 'DEFERRED', mermaid: 'DEFERRED' }),
  },
  {
    name: 'format: a bare "Output is A and B" names no CLI and matches nothing',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'Output is JSON and YAML.\n',
    expect: [],
  },
  {
    name: 'format: the same with the CLI named in the tail',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'Output is JSON and YAML from the CLI.\n',
    expect: F({ json: 'AFFIRM', yaml: 'AFFIRM' }),
  },
  {
    name: 'format: a single format never makes a claim',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'The CLI emits JSON.\n',
    expect: [],
  },
  {
    name: 'format: SEP "csv, and mermaid"',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'CSV, and Mermaid output are not implemented.\n',
    expect: F({ csv: 'ABSENT', mermaid: 'ABSENT' }),
  },
  {
    name: 'format: SEP "csv or mermaid"',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'CSV or Mermaid output are not implemented.\n',
    expect: F({ csv: 'ABSENT', mermaid: 'ABSENT' }),
  },
  {
    name: 'format: SEP carries its spaces, so "CSVandMermaid" is no enumeration',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'CSVandMermaid output are not implemented.\n',
    expect: [],
  },
  {
    name: 'format: a slash separates members',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'CSV/Mermaid output is not supported.\n',
    expect: F({ csv: 'ABSENT', mermaid: 'ABSENT' }),
  },
  {
    name: 'format: a parenthetical enumeration is an aside, not the claim (extract-contracts README:3)',
    kind: 'OUTPUT_FORMAT_SET',
    doc: EXTRACT_CONTRACTS_README_3,
    expect: [],
  },
  {
    name: 'format: the "Deferred:" sentence of v3 keeps CSV and Mermaid in a parenthetical',
    kind: 'OUTPUT_FORMAT_SET',
    doc: V3_DEFERRED_260,
    expect: [],
  },
  {
    name: 'format: a sentence about the output of something else yields nothing',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'The extractor reads JSON, CSV and YAML input and emits nodes.\n',
    expect: [],
  },
  {
    name: 'format: an enumeration after an output verb whose subject is not the CLI',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'The exporter emits JSON and CSV.\n',
    expect: [],
  },
  {
    name: 'format: a sentence that begins with a code span is split from the one before it',
    kind: 'OUTPUT_FORMAT_SET',
    doc: 'Output is JSON and CSV from the CLI. `seamline` rocks.\n',
    expect: F({ json: 'AFFIRM', csv: 'AFFIRM' }),
  },
  {
    name: 'format: the sentence that drifted in the pre-fix tree (README.md:166)',
    kind: 'OUTPUT_FORMAT_SET',
    doc: README_FORMATS_PREFIX,
    expect: F({ json: 'AFFIRM', csv: 'AFFIRM', mermaid: 'AFFIRM' }),
  },
  {
    name: 'format: the sentence that corrected it on main (README.md:172) yields no AFFIRM',
    kind: 'OUTPUT_FORMAT_SET',
    doc: README_FORMATS_MAIN,
    expect: F({ csv: 'ABSENT', mermaid: 'ABSENT' }),
  },
  // ---- DETECTOR_LIVENESS (4.3)
  {
    name: 'detector: a three-row catalog table',
    kind: 'DETECTOR_LIVENESS',
    doc: '| Code | What |\n| --- | --- |\n| X1 | a |\n| X2 | b |\n| X3 | c |\n',
    expect: [
      'DETECTOR_LIVENESS|detector:X1|AFFIRM|',
      'DETECTOR_LIVENESS|detector:X2|AFFIRM|',
      'DETECTOR_LIVENESS|detector:X3|AFFIRM|',
    ],
  },
  {
    name: 'detector: two rows are not a catalog',
    kind: 'DETECTOR_LIVENESS',
    doc: '| Code | What |\n| --- | --- |\n| X1 | a |\n| X2 | b |\n',
    expect: [],
  },
  {
    name: 'detector: a first column that links to a per-code page does not match',
    kind: 'DETECTOR_LIVENESS',
    doc: '| Code | What |\n| --- | --- |\n| [X1_NULLABILITY](X1.md) | a |\n| [X2_TYPE](X2.md) | b |\n| [X3_CONSTRAINT](X3.md) | c |\n',
    expect: [],
  },
  {
    name: 'detector: a code outside the registry yields no claim',
    kind: 'DETECTOR_LIVENESS',
    doc: 'X7 does not fire yet.\n',
    expect: [],
  },
  {
    name: 'detector: F1 a range inside a sentence marks nothing',
    kind: 'DETECTOR_LIVENESS',
    doc: 'Every X1 to X3 either fires on a corpus repository or is disclosed dormant with its reason.\n',
    expect: [],
  },
  {
    name: 'detector: F2 a range in a lead label marks nothing',
    kind: 'DETECTOR_LIVENESS',
    doc: '- **X1 to X3 do not fire yet.** Waiting for extractors.\n',
    expect: [],
  },
  {
    name: 'detector: F3 a hyphenated range marks nothing',
    kind: 'DETECTOR_LIVENESS',
    doc: 'X1-X3 are dormant on real repositories.\n',
    expect: [],
  },
  {
    name: 'detector: F4 "through" marks nothing',
    kind: 'DETECTOR_LIVENESS',
    doc: 'X1 through X3 are dormant on real repositories.\n',
    expect: [],
  },
  {
    name: 'detector: F5 one code and a cue',
    kind: 'DETECTOR_LIVENESS',
    doc: 'X3 does not fire yet.\n',
    expect: ['DETECTOR_LIVENESS|detector:X3|DEFERRED|'],
  },
  {
    name: 'detector: F6 a list of codes',
    kind: 'DETECTOR_LIVENESS',
    doc: 'X2, X3 do not fire yet.\n',
    expect: ['DETECTOR_LIVENESS|detector:X2|DEFERRED|', 'DETECTOR_LIVENESS|detector:X3|DEFERRED|'],
  },
  {
    name: 'detector: F7 a code written outside the range still counts',
    kind: 'DETECTOR_LIVENESS',
    doc: 'X1 to X2 are live, but X3 is dormant.\n',
    expect: ['DETECTOR_LIVENESS|detector:X3|DEFERRED|'],
  },
  {
    name: 'detector: a label with the code in a code span and a parenthetical, read with the code kept as text',
    kind: 'DETECTOR_LIVENESS',
    doc: '- **`X10` (untested PII write path) does not fire on real repositories yet.** Because.\n',
    expect: ['DETECTOR_LIVENESS|detector:X10|DEFERRED|'],
  },
  {
    name: 'detector: README.md:184 on main, whose X10 is plain text, marks X10 by its label and by its sentence',
    kind: 'DETECTOR_LIVENESS',
    doc: README_X10_MAIN,
    expect: [
      'DETECTOR_LIVENESS|detector:X10|DEFERRED|',
      'DETECTOR_LIVENESS|detector:X10|DEFERRED|',
    ],
  },
  {
    name: 'detector: a code inside parentheses is not the subject of the cue',
    kind: 'DETECTOR_LIVENESS',
    doc: '- **The detector (X3) works.** It runs fine.\n',
    expect: [],
  },
  {
    name: 'detector: a code without a cue marks nothing',
    kind: 'DETECTOR_LIVENESS',
    doc: 'X3 fires on every repository.\n',
    expect: [],
  },
  // ---- CONTROL_ENFORCEMENT (4.4)
  {
    name: 'control: a row with a cue and an existing path',
    kind: 'CONTROL_ENFORCEMENT',
    doc: '## 6. Controls in this version\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | The guard is wired into the cli. | `packages/guard/src/guard.ts` |\n',
    expect: ['CONTROL_ENFORCEMENT|control:C1|AFFIRM|'],
  },
  {
    name: 'control: the same table under another heading is not read',
    kind: 'CONTROL_ENFORCEMENT',
    doc: '## Mitigations\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | The guard is wired into the cli. | `packages/guard/src/guard.ts` |\n',
    expect: [],
  },
  {
    name: 'control: a row without an enforcement cue yields nothing',
    kind: 'CONTROL_ENFORCEMENT',
    doc: '## Controls\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | The guard exists. | `packages/guard/src/guard.ts` |\n',
    expect: [],
  },
  {
    name: 'control: the cue is a whole word, case-insensitively',
    kind: 'CONTROL_ENFORCEMENT',
    doc: '## Controls\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | Wired at startup. | `packages/cli` |\n| C2 | Unwired code. | `packages/cli` |\n',
    expect: ['CONTROL_ENFORCEMENT|control:C1|AFFIRM|'],
  },
];

describe('claim grammars: fires / does-not-fire pairs (ADR-0005 rule 3, applied to claims)', () => {
  for (const pair of PAIRS) {
    test(pair.name, () => {
      const got = read(pair.doc).filter((c) => c.startsWith(`${pair.kind}|`));
      assert.deepEqual(got, [...pair.expect]);
    });
  }

  test('meta: every claim kind has a case that fires and a case that does not', () => {
    for (const kind of [
      'RUNTIME_FLOOR',
      'OUTPUT_FORMAT_SET',
      'DETECTOR_LIVENESS',
      'CONTROL_ENFORCEMENT',
    ] as const) {
      const of = PAIRS.filter((p) => p.kind === kind);
      assert.ok(
        of.some((p) => p.expect.length > 0),
        `${kind} has no fires case`,
      );
      assert.ok(
        of.some((p) => p.expect.length === 0),
        `${kind} has no does-not-fire case`,
      );
    }
  });
});

describe('format templates (4.2)', () => {
  test('SEP is exactly ", and ", ", or ", ", ", " and ", " or " and "/"', () => {
    const members = (s: string) => matchFormatTemplates(s)?.members;
    assert.deepEqual(members('csv, and mermaid output are not implemented'), ['csv', 'mermaid']);
    assert.deepEqual(members('csv, or mermaid output are not implemented'), ['csv', 'mermaid']);
    assert.deepEqual(members('csv, mermaid output are not implemented'), ['csv', 'mermaid']);
    assert.deepEqual(members('csv and mermaid output are not implemented'), ['csv', 'mermaid']);
    assert.deepEqual(members('csv or mermaid output are not implemented'), ['csv', 'mermaid']);
    assert.deepEqual(members('csv/mermaid output are not implemented'), ['csv', 'mermaid']);
    assert.equal(members('csv & mermaid output are not implemented'), undefined);
    assert.equal(members('csv,mermaid output are not implemented'), undefined);
  });

  test('a sentence must match whole, not contain the words', () => {
    assert.equal(
      matchFormatTemplates('note that json and csv output are not implemented in the old viewer'),
      null,
    );
    assert.equal(matchFormatTemplates('see json and csv'), null);
  });

  test('"Output is JSON, CSV, and Mermaid from the CLI." yields AFFIRM for three members', () => {
    const [sentence] = prepareSentences('Output is JSON, CSV, and Mermaid from the CLI.');
    assert.deepEqual(matchFormatTemplates(sentence ?? ''), {
      template: 'T1',
      polarity: 'AFFIRM',
      members: ['json', 'csv', 'mermaid'],
    });
  });
});

describe('detector markers (4.3)', () => {
  test('cues are matched as whole words', () => {
    assert.deepEqual(dormancyMarkers('x3 is dormant'), ['X3']);
    assert.deepEqual(dormancyMarkers('x3 is undormant'), []);
    assert.deepEqual(dormancyMarkers('x3 none of them can fire'), ['X3']);
    assert.deepEqual(dormancyMarkers('x3 never fires'), ['X3']);
  });

  test('a code glued to an identifier is not a code', () => {
    assert.deepEqual(dormancyMarkers('x10_untested does not fire'), []);
    assert.deepEqual(dormancyMarkers('xx3 does not fire'), []);
  });

  test('the label keeps code spans as text and drops parentheticals', () => {
    assert.equal(
      prepareLabel('`X10` (untested PII write path) does not fire yet.'),
      'x10 does not fire yet.',
    );
    assert.equal(prepareLabel('broken (label'), null);
  });

  test('frozen real-world-inputs.md:356: X1 gets no marker, X10 gets one from the sentence after it', () => {
    const claims = read(REAL_WORLD_INPUTS_356, {}, 'docs/design/real-world-inputs.md');
    assert.deepEqual(claims, ['DETECTOR_LIVENESS|detector:X10|DEFERRED|']);
  });

  test('a list item whose label and sentence both mark a code yields both claims, with the same digest', () => {
    const { claims } = extractClaims(
      'README.md',
      '- **X3 does not fire yet.** Waiting.\n',
      context(),
    );
    assert.equal(claims.length, 2);
    assert.equal(claims[0]?.digest, claims[1]?.digest);
  });
});

describe('control rows (4.4): the thirteen rows of THREATMODEL.md, frozen', () => {
  for (const [label, text] of [
    ['the pre-fix tree', THREATMODEL_CONTROLS_PREFIX],
    ['main', THREATMODEL_CONTROLS_MAIN],
  ] as const) {
    test(`at ${label} exactly C3, C4, C8 and C9 yield a claim, the rest carry no enforcement cue`, () => {
      const { claims } = extractClaims('THREATMODEL.md', text, context());
      assert.equal(text.split('\n').filter((l) => /^\| C\d+ /.test(l)).length, 13);
      assert.deepEqual(
        claims.map((c) => c.subject),
        ['control:C3', 'control:C4', 'control:C8', 'control:C9'],
      );
      const bound = Object.fromEntries(claims.map((c) => [c.subject, c.extras.boundPaths]));
      assert.deepEqual(bound['control:C3'], ['packages/cli', 'packages/core']);
      assert.deepEqual(bound['control:C4'], []);
      assert.deepEqual(bound['control:C8'], ['packages/core', 'packages/mcp']);
      assert.deepEqual(bound['control:C9'], ['scripts/license-gate.mjs']);
    });
  }

  test('a code span that names no tracked path is ignored', () => {
    const doc =
      '## Controls\n\n| # | Control | Where |\n| --- | --- | --- |\n| C1 | Enforced. | `nowhere/at/all` and `packages/cli/` |\n';
    const { claims } = extractClaims('THREATMODEL.md', doc, context());
    assert.deepEqual(claims[0]?.extras.boundPaths, ['packages/cli']);
  });
});

describe('claim records (3.3)', () => {
  test('the subject of a floor under a non-root package is suffixed with the npm name', () => {
    const claims = extractClaims(
      'packages/foo/README.md',
      '- **Node >= 20.3** ok\n',
      context({ packageNameOf: () => '@fx/foo' }),
    ).claims;
    assert.equal(claims[0]?.subject, 'runtime:node@@fx/foo');
  });

  test('the digest covers the meaning and nothing else: not the wording, the path, the lines or the commit', () => {
    const a = extractClaims('README.md', '- **Node >= 20.3** is needed here.\n', context())
      .claims[0];
    const b = extractClaims(
      'docs/x.md',
      '\n\n- **Node >= 20.3.0**, reworded entirely.\n',
      context({ commit: 'd'.repeat(40) }),
    ).claims[0];
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(a.digest, b.digest);
    assert.notEqual(a.excerpt, b.excerpt);
    assert.notEqual(a.source.lineStart, b.source.lineStart);
    assert.equal(
      a.digest,
      claimDigest({
        kind: 'RUNTIME_FLOOR',
        subject: 'runtime:node',
        member: null,
        polarity: 'AFFIRM',
        value: '20.3.0',
      }),
    );
  });

  test('a claim carries its provenance, extractor, lines and an excerpt of at most 240 characters', () => {
    const long = `- **Node >= 20** ${'word '.repeat(100)}\n`;
    const claim = extractClaims('docs/a.md', long, context()).claims[0];
    assert.ok(claim !== undefined);
    assert.equal(claim.provenance, 'DECLARED');
    assert.deepEqual(claim.source.extractor, { name: 'align-docs', version: '1' });
    assert.equal(claim.source.commit, 'c'.repeat(40));
    assert.ok(claim.excerpt.length <= 240);
  });
});
