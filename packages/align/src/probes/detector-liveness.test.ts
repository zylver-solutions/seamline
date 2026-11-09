import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  ALL_PASS,
  caseFiles,
  run,
  withResult,
  type CaseOptions,
  type RunOptions,
} from '../__fixtures__/build.ts';
import type { FactsRun } from '../facts.ts';
import type { ExtractorResult } from '@seamline/ontology';

const GAP = 'Unexplained gap:absent-in-implementation';

/** `class:reason` of a detector subject, or `aligned`. */
function detector(code: string, options: CaseOptions = {}, run_: RunOptions = {}): string {
  const files = caseFiles(options);
  const ran = run(files, run_);
  const f = ran.findings.find(
    (x) => x.id.endsWith(`DETECTOR_LIVENESS:detector:${code}`) && x.class !== 'Resolved',
  );
  return f === undefined ? 'aligned' : `${f.class}:${f.reason}`;
}

const pkg = (
  dir: string,
  name: string,
  sources: Record<string, string>,
  extra: Record<string, unknown> = {},
): Record<string, string> => ({
  [`packages/${dir}/package.json`]: JSON.stringify({ name, ...extra }),
  ...Object.fromEntries(
    Object.entries(sources).map(([file, text]) => [`packages/${dir}/${file}`, text]),
  ),
});

const MANIFEST_TYPE = "import type { ExtractorManifest } from '@seamline/ontology';\n";

describe('detector-liveness: the read model and the scope check (4.3)', () => {
  test('X3 reads a kind no scope produces, with no marker: an Unexplained gap; X1 and X2 are live', () => {
    assert.equal(detector('X3'), GAP);
    assert.equal(detector('X1'), 'aligned');
    assert.equal(detector('X2'), 'aligned');
  });

  test('the fact states its level, and the packet names the registry', () => {
    const ran = run(caseFiles());
    assert.match(ran.find('detector:X3')?.fact?.detail ?? '', /^node-kind level/);
    assert.match(ran.find('detector:X3')?.fact?.detail ?? '', /extractor packages scanned/);
    assert.match(
      ran.packet.inputs.probes
        .find((p) => p.probe === 'detector-liveness')
        ?.diagnostics.join(' ') ?? '',
      /X1, X2, X3/,
    );
  });

  test('when every kind is produced X3 is aligned', () => {
    assert.equal(detector('X3', { x3Kind: 'Column' }), 'aligned');
  });

  test('(i) a SIF with no extract-data result: X1 and X3 (which require data) are Unknown(scope-not-pass), X2 is aligned, and nothing is an Unexplained gap', () => {
    const results = ALL_PASS.filter((r) => r.extractor !== 'extract-data');
    const ran = run(caseFiles(), { results });
    assert.equal(ran.find('detector:X1')?.reason, 'scope-not-pass');
    assert.match(ran.find('detector:X1')?.unknown?.detail ?? '', /data: not declared/);
    assert.deepEqual(ran.find('detector:X1')?.unknown?.scopes, ['code.ts', 'data']);
    assert.equal(ran.find('detector:X3')?.class, 'Unknown');
    assert.equal(ran.find('detector:X2'), undefined);
    assert.ok(
      !ran.findings.some(
        (f) => f.class === 'Unexplained gap' && f.claimKind === 'DETECTOR_LIVENESS',
      ),
    );
    // read by format-witness and module-wiring the same fixture is unchanged: they ask for code.ts only.
    const full = run(caseFiles());
    for (const suffix of ['output-format:csv', 'output-format:mermaid', 'control:C1']) {
      assert.equal(ran.find(suffix)?.class, full.find(suffix)?.class, suffix);
    }
  });

  test('(ii) an extract-change result UNAVAILABLE with no scopes changes no detector when the tree carries an extract-change package', () => {
    const lost: ExtractorResult = {
      ...ALL_PASS[0]!,
      extractor: 'extract-change',
      status: 'UNAVAILABLE',
      authoritative: [],
    };
    const files = {
      ...pkg('extract-change', '@fx/extract-change', { 'src/index.ts': 'export const x = 1;\n' }),
    };
    assert.equal(detector('X3', { files }, { results: [...ALL_PASS, lost] }), GAP);
    assert.equal(detector('X1', { files }, { results: [...ALL_PASS, lost] }), 'aligned');
  });

  test('(ii-b) the same run without that package: a lost extractor, so X3 is Unknown(scope-not-pass) naming it', () => {
    const lost: ExtractorResult = {
      ...ALL_PASS[0]!,
      extractor: 'extract-change',
      status: 'UNAVAILABLE',
      authoritative: [],
    };
    const ran = run(caseFiles(), { results: [...ALL_PASS, lost] });
    assert.equal(ran.find('detector:X3')?.class, 'Unknown');
    assert.equal(ran.find('detector:X3')?.reason, 'scope-not-pass');
    assert.match(ran.find('detector:X3')?.unknown?.detail ?? '', /extract-change/);
    assert.equal(ran.find('detector:X3')?.unknown?.scopes.length, 0);
    assert.equal(ran.find('detector:X1'), undefined);
  });

  test('(iii) a FAIL result that kept its scopes and declares the unproduced kind: Unknown(scope-not-pass) naming that scope, not ABSENT', () => {
    const results = withResult(ALL_PASS, 'extract-contracts', (r) => ({
      ...r,
      status: 'FAIL' as const,
      authoritative: [{ scope: 'contracts', kinds: ['TestCase'] as never }],
    }));
    const ran = run(caseFiles(), { results });
    assert.equal(ran.find('detector:X3')?.reason, 'scope-not-pass');
    assert.deepEqual(ran.find('detector:X3')?.unknown?.scopes, ['contracts']);
  });

  test('a failed extractor recorded with no scope is Unknown for the detectors that require it (a crash is never dormancy)', () => {
    for (const status of ['FAIL', 'UNAVAILABLE'] as const) {
      const results = withResult(ALL_PASS, 'extract-data', (r) => ({
        ...r,
        status,
        authoritative: [],
      }));
      const ran = run(caseFiles(), { results });
      assert.equal(ran.find('detector:X1')?.reason, 'scope-not-pass');
      assert.equal(ran.find('detector:X3')?.reason, 'scope-not-pass');
    }
  });

  test('no extractor result at all is Unknown(facts-missing)', () => {
    assert.equal(detector('X3', {}, { results: [] }), 'Unknown:facts-missing');
  });

  const results = (
    ...scopes: [string, string[], ExtractorResult['status']?][]
  ): ExtractorResult[] =>
    scopes.map(([extractor, kinds, status]) => ({
      ...ALL_PASS[0]!,
      extractor,
      status: status ?? 'PASS',
      authoritative: [
        { scope: extractor === 'extract-code-ts' ? 'code.ts' : 'data', kinds: kinds as never },
      ],
    }));

  test('(iv) a store whose newest run holds only code.ts while an earlier run declared data: X1 is evaluated and run.scopes shows the earlier run', () => {
    const runs: FactsRun[] = [
      {
        runId: 'new',
        commit: null,
        ontologyVersion: '1.0.0',
        results: results(['extract-code-ts', ['File', 'Symbol']]),
      },
      {
        runId: 'old',
        commit: null,
        ontologyVersion: '1.0.0',
        results: results(['extract-data', ['Column']]),
      },
    ];
    const ran = run(caseFiles(), { runs, source: 'store' });
    assert.equal(ran.find('detector:X1'), undefined);
    assert.equal(ran.packet.run.scopes.find((s) => s.scope === 'data')?.runId, 'old');
    assert.equal(ran.packet.run.scopes.find((s) => s.scope === 'code.ts')?.runId, 'new');
  });

  test('(v) the same store, the newest run also holding an UNAVAILABLE extract-data with no scopes: data is UNAVAILABLE, the earlier PASS does not stand in', () => {
    const lost: ExtractorResult = { ...ALL_PASS[1]!, status: 'UNAVAILABLE', authoritative: [] };
    const runs: FactsRun[] = [
      {
        runId: 'new',
        commit: null,
        ontologyVersion: '1.0.0',
        results: [...results(['extract-code-ts', ['File', 'Symbol']]), lost],
      },
      {
        runId: 'old',
        commit: null,
        ontologyVersion: '1.0.0',
        results: results(['extract-data', ['Column']]),
      },
    ];
    const ran = run(caseFiles(), { runs, source: 'store' });
    assert.equal(ran.find('detector:X1')?.reason, 'scope-not-pass');
    assert.equal(ran.packet.run.scopes.find((s) => s.scope === 'data')?.status, 'UNAVAILABLE');
  });

  test('12.4 item 8: a failed extractor over an earlier declaration is entered with the earlier kinds and the newest run id', () => {
    const lost: ExtractorResult = { ...ALL_PASS[1]!, status: 'UNAVAILABLE', authoritative: [] };
    const runs: FactsRun[] = [
      {
        runId: 'new',
        commit: null,
        ontologyVersion: '1.0.0',
        results: [...results(['extract-code-ts', ['File', 'Symbol']]), lost],
      },
      {
        runId: 'old',
        commit: null,
        ontologyVersion: '1.0.0',
        results: results(['extract-data', ['Column', 'Table']]),
      },
    ];
    const ran = run(caseFiles(), { runs, source: 'store' });
    const data = ran.packet.run.scopes.find((s) => s.scope === 'data');
    assert.deepEqual(data, {
      scope: 'data',
      status: 'UNAVAILABLE',
      kinds: ['Column', 'Table'],
      runId: 'new',
    });
    assert.equal(ran.packet.run.scopes.find((s) => s.scope === 'code.ts')?.runId, 'new');
  });

  test('(vi) a required scope through an imported constant and a string literal give the same result; a call expression is Unknown(reads-unresolvable)', () => {
    const literal = {
      'packages/contradictions/src/detectors/x2.ts':
        "import { defineDetector } from '../define.ts';\nimport { factNodes } from '../facts.ts';\n\nexport const detector = defineDetector({\n  code: 'X2_TYPE',\n  requiredScopes: ['code.ts'],\n  find(g: unknown) {\n    return factNodes(g, 'Symbol');\n  },\n});\n",
    };
    assert.equal(detector('X2', { files: literal }), 'aligned');
    const call = {
      'packages/contradictions/src/detectors/x2.ts': literal[
        'packages/contradictions/src/detectors/x2.ts'
      ].replace("['code.ts']", '[scope()]'),
    };
    assert.equal(detector('X2', { files: call }), 'Unknown:reads-unresolvable');
    const missing = {
      'packages/contradictions/src/detectors/x2.ts': literal[
        'packages/contradictions/src/detectors/x2.ts'
      ].replace("  requiredScopes: ['code.ts'],\n", ''),
    };
    assert.equal(detector('X2', { files: missing }), 'Unknown:reads-unresolvable');
  });

  test('a read whose kind is not a literal, and a detector that reads nothing, are Unknown(reads-unresolvable)', () => {
    const base = (find: string): Record<string, string> => ({
      'packages/contradictions/src/detectors/x2.ts': `import { defineDetector } from '../define.ts';\nimport { factNodes } from '../facts.ts';\nimport { SCOPE_CODE } from '../scopes.ts';\n\nexport const detector = defineDetector({\n  code: 'X2_TYPE',\n  requiredScopes: [SCOPE_CODE],\n  find(g: unknown) {\n    ${find}\n  },\n});\n`,
    });
    assert.equal(
      detector('X2', { files: base('const k = String(g); return factNodes(g, k);') }),
      'Unknown:reads-unresolvable',
    );
    assert.equal(detector('X2', { files: base('return [];') }), 'Unknown:reads-unresolvable');
  });

  test('read groups: a || chain whose operands each read is one group, any member suffices; an optional read joins no group', () => {
    const files = (find: string): Record<string, string> => ({
      'packages/contradictions/src/detectors/x2.ts': `import { defineDetector } from '../define.ts';\nimport { factNodes } from '../facts.ts';\nimport { SCOPE_CODE } from '../scopes.ts';\n\nexport const detector = defineDetector({\n  code: 'X2_TYPE',\n  requiredScopes: [SCOPE_CODE],\n  find(g: unknown) {\n    ${find}\n  },\n});\n`,
    });
    // TestCase is unproduced but Symbol is produced: the group is produced, X2 is live.
    assert.equal(
      detector('X2', {
        files: files(
          "return factNodes(g, 'TestCase').length > 0 || factNodes(g, 'Symbol').length > 0 ? [1] : [];",
        ),
      }),
      'aligned',
    );
    // Two required reads, one unproduced: the group of one is unproduced, a gap.
    assert.equal(
      detector('X2', {
        files: files(
          "return factNodes(g, 'Symbol').length > 0 && factNodes(g, 'TestCase').length > 0 ? [1] : [];",
        ),
      }),
      GAP,
    );
    // An optional read (the chain has an operand with no read) is not required: the documented over-report shape is the other way round.
    assert.equal(
      detector('X2', {
        files: files(
          "return factNodes(g, 'Symbol').length > 0 && (g === null || factNodes(g, 'TestCase').length > 0) ? [1] : [];",
        ),
      }),
      'aligned',
    );
  });
});

describe('detector-liveness: the extractor-package scan (4.3 step 5, 12.2 vii)', () => {
  const NAMES_TESTCASE = "export const kinds = ['TestCase'];\n";
  const fire = (name: string, files: Record<string, string>, run_: RunOptions = {}): void => {
    test(`fire: ${name}`, () => {
      const ran = run(caseFiles({ files }), run_);
      const f = ran.find('detector:X3');
      assert.equal(`${f?.class}:${f?.reason}`, 'Unknown:scope-not-pass');
      assert.match(f?.unknown?.detail ?? '', /TestCase|did not finish/);
    });
  };
  const gap = (name: string, files: Record<string, string>): void => {
    test(`do not fire: ${name}`, () => {
      assert.equal(detector('X3', { files }), GAP);
    });
  };

  fire(
    'E1 an extract-tests package that names TestCase, with no result in the run',
    pkg('extract-tests', '@fx/extract-tests', {
      'src/index.ts': `${MANIFEST_TYPE}export const m: ExtractorManifest = { kinds: ['TestCase'] } as never;\n`,
    }),
  );
  fire(
    'E2 the same with a FAIL result and no scopes',
    pkg('extract-tests', '@fx/extract-tests', { 'src/index.ts': NAMES_TESTCASE }),
    {
      results: [
        ...ALL_PASS,
        { ...ALL_PASS[0]!, extractor: 'extract-tests', status: 'FAIL', authoritative: [] },
      ],
    },
  );
  fire(
    'E6 a package not named extract-* with an annotated variable naming CoverageRecord and TestCase',
    pkg('x', '@fx/x', {
      'src/m.ts': `${MANIFEST_TYPE}export const m: ExtractorManifest = { kinds: ['CoverageRecord', 'TestCase'] } as never;\n`,
    }),
  );
  fire(
    'E7 only a parameter of that type',
    pkg('x', '@fx/x', {
      'src/m.ts': `${MANIFEST_TYPE}export function f(m: ExtractorManifest): string[] { return [m.name, 'TestCase']; }\n`,
    }),
  );
  fire(
    'E11 satisfies ExtractorManifest',
    pkg('x', '@fx/x', {
      'src/m.ts': `${MANIFEST_TYPE}export const m = { kinds: ['TestCase'] } satisfies Partial<ExtractorManifest>;\n`,
    }),
  );
  fire(
    'E12 as ExtractorManifest',
    pkg('x', '@fx/x', {
      'src/m.ts': `${MANIFEST_TYPE}export const m = { kinds: ['TestCase'] } as unknown as ExtractorManifest;\n`,
    }),
  );
  fire(
    'E13 a bare import type',
    pkg('x', '@fx/x', { 'src/m.ts': `${MANIFEST_TYPE}export const kinds = ['TestCase'];\n` }),
  );
  fire(
    'E18 a declared return type',
    pkg('x', '@fx/x', {
      'src/m.ts': `${MANIFEST_TYPE}export function make(): ExtractorManifest { return { kinds: ['TestCase'] } as never; }\n`,
    }),
  );
  fire(
    'E8 a package named infer-join',
    pkg('infer-join', '@fx/infer-join', { 'src/index.ts': NAMES_TESTCASE }),
  );
  fire(
    'E17 an npm name @scope/extract-x under another directory',
    pkg('tools', '@scope/extract-x', { 'src/index.ts': NAMES_TESTCASE }),
  );
  fire(
    'E16b its own interface ExtractorManifest and a manifest naming TestCase',
    pkg('x', '@fx/x', {
      'src/m.ts':
        "export interface ExtractorManifest { kinds: string[] }\nexport const m: ExtractorManifest = { kinds: ['TestCase'] };\n",
    }),
  );
  fire(
    'E16c its own alias',
    pkg('x', '@fx/x', {
      'src/m.ts':
        "type Base = { kinds: string[] };\nexport type ExtractorManifest = Base & { name: string };\nexport const kinds = ['TestCase'];\n",
    }),
  );
  fire(
    'E16d a package named @fx/ontology declares the type and names TestCase: the exemption is a name, not a shape',
    pkg('ontology', '@fx/ontology', {
      'src/m.ts':
        "export interface ExtractorManifest { kinds: string[] }\nexport const kinds = ['TestCase'];\n",
    }),
  );
  fire(
    'E20 a kind named as a member of a constants object',
    pkg('extract-k', '@fx/extract-k', {
      'src/k.ts': 'declare const K: { TestCase: string };\nexport const kind = K.TestCase;\n',
    }),
  );

  test('E3 an extract-tests result that is PASS and declares TestCase: X3 is aligned', () => {
    const results = [
      ...ALL_PASS,
      {
        ...ALL_PASS[0]!,
        extractor: 'extract-tests',
        authoritative: [{ scope: 'tests', kinds: ['TestCase'] as never }],
      },
    ];
    assert.equal(
      detector(
        'X3',
        { files: pkg('extract-tests', '@fx/extract-tests', { 'src/index.ts': NAMES_TESTCASE }) },
        { results },
      ),
      'aligned',
    );
  });

  gap(
    'E4 the name only in a test file of the extractor package',
    pkg('extract-tests', '@fx/extract-tests', {
      'src/index.ts': 'export const x = 1;\n',
      'src/index.test.ts': NAMES_TESTCASE,
    }),
  );
  gap(
    'E5 the name in a package that is not an extractor package',
    pkg('app', '@fx/app', { 'src/index.ts': NAMES_TESTCASE }),
  );
  gap(
    'E10 a literal that merely contains the name',
    pkg('extract-tests', '@fx/extract-tests', {
      'src/index.ts': "export const k = ['TestCaseX'];\n",
    }),
  );
  gap(
    'E14 a package that builds its manifest with an inferred type and never mentions the identifier',
    pkg('x', '@fx/x', { 'src/m.ts': 'export const make = () => ({ kinds: [] as string[] });\n' }),
  );
  gap(
    'E15 a comment and a string literal are not an identifier',
    pkg('x', '@fx/x', {
      'src/m.ts':
        "// ExtractorManifest\nexport const label = 'ExtractorManifest';\nexport const kinds = ['TestCase'];\n",
    }),
  );
  gap(
    'E16a the vocabulary package @seamline/ontology that declares the type and names TestCase',
    pkg('ontology', '@seamline/ontology', {
      'src/contract.ts':
        "export interface ExtractorManifest { kinds: string[] }\nexport const NODE_KINDS = ['TestCase'];\n",
    }),
  );
  gap(
    'E16a2 the same without a manifest value',
    pkg('ontology', '@seamline/ontology', {
      'src/contract.ts':
        "export interface ExtractorManifest { kinds: string[] }\nexport const k = 'TestCase';\n",
    }),
  );
  gap(
    'E20b a member access in a test file only',
    pkg('extract-k', '@fx/extract-k', {
      'src/k.ts': 'export const x = 1;\n',
      'src/k.test.ts': 'declare const K: { TestCase: string };\nexport const kind = K.TestCase;\n',
    }),
  );
  gap(
    'E20c a member access in a package that is not an extractor package',
    pkg('app', '@fx/app', {
      'src/k.ts': 'declare const K: { TestCase: string };\nexport const kind = K.TestCase;\n',
    }),
  );
  gap(
    'E19b the same extractor package without a .py file',
    pkg('extract-py', '@fx/extract-py', { 'src/index.ts': 'export const x = 1;\n' }),
  );
  gap('E19c a .py file in a package that is not an extractor package', {
    ...pkg('app', '@fx/app', { 'src/index.ts': 'export const x = 1;\n' }),
    'packages/app/tools/gen.py': 'print(1)\n',
  });

  test('E19 an extractor package that tracks a .py file and names no kind is Unknown(source-unreadable)', () => {
    const files = {
      ...pkg('extract-py', '@fx/extract-py', { 'src/index.ts': 'export const x = 1;\n' }),
      'packages/extract-py/tools/gen.py': 'print(1)\n',
    };
    assert.equal(detector('X3', { files }), 'Unknown:source-unreadable');
  });

  test('E19d an extractor package with a source file that has a syntax error, E19e a non-extractor package with one: Unknown(source-unreadable)', () => {
    assert.equal(
      detector('X3', {
        files: pkg('extract-bad', '@fx/extract-bad', { 'src/index.ts': 'export const = ;\n' }),
      }),
      'Unknown:source-unreadable',
    );
    assert.equal(
      detector('X3', { files: pkg('app', '@fx/app', { 'src/index.ts': 'export const = ;\n' }) }),
      'Unknown:source-unreadable',
    );
  });

  test('E9 an unparseable package.json anywhere in the tree is Unknown(manifest-unparseable)', () => {
    assert.equal(
      detector('X3', { files: { 'packages/broken/package.json': '{ nope' } }),
      'Unknown:manifest-unparseable',
    );
  });

  test('a bound exceeded in the name scan is Unknown(limit-exceeded)', () => {
    const ran = run(caseFiles(), { limits: { maxSourceFiles: 3 } });
    assert.equal(ran.find('detector:X3')?.reason, 'limit-exceeded');
  });

  test('DL1 an extractor outside the discovered packages whose failure the run does not record is residue: an Unexplained gap', () => {
    assert.equal(
      detector('X3', {
        files: {
          'vendor/extract-tests/package.json': JSON.stringify({ name: 'ext' }),
          'vendor/extract-tests/src/index.ts': NAMES_TESTCASE,
        },
      }),
      GAP,
    );
  });

  test('DL5 a lost extractor that maps to a package of the tree is covered by that package; one the tree does not carry is Unknown, by directory name or npm name', () => {
    const lostOf = (extractor: string): RunOptions => ({
      results: [...ALL_PASS, { ...ALL_PASS[0]!, extractor, status: 'FAIL', authoritative: [] }],
    });
    const carried = pkg('extract-tests', '@fx/extract-tests', {
      'src/index.ts': 'export const x = 1;\n',
    });
    assert.equal(detector('X3', { files: carried }, lostOf('extract-tests')), GAP);
    assert.equal(detector('X3', { files: carried }, lostOf('@fx/extract-tests')), GAP);
    assert.equal(
      detector('X3', { files: carried }, lostOf('extract-elsewhere')),
      'Unknown:scope-not-pass',
    );
    const passed = {
      results: [
        ...ALL_PASS,
        {
          ...ALL_PASS[0]!,
          extractor: 'extract-elsewhere',
          status: 'PASS' as const,
          authoritative: [],
        },
      ],
    };
    assert.equal(detector('X3', { files: carried }, passed), GAP);
  });
});

describe('detector-liveness: the registry', () => {
  test('a repository with no registry yields no detector claims at all', () => {
    const files = { ...caseFiles() };
    delete files['packages/contradictions/src/detectors/index.ts'];
    const ran = run(files);
    assert.ok(!ran.findings.some((f) => f.claimKind === 'DETECTOR_LIVENESS'));
  });
});
