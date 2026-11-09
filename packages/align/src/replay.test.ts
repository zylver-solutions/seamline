import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ALL_PASS, run } from './__fixtures__/build.ts';
import { DETECTOR_FILES_PREFIX } from './__fixtures__/frozen-detectors.ts';

/**
 * The replay of 12.1 / 12.3 over frozen inputs: the ten real detector files of
 * the pre-fix tree, the four extractors the committed baseline SIF records (all PASS),
 * and the extractor packages of the tree as the design lists them. `ontology`
 * names every node kind and is exempt by name; `contradictions`, `mcp` name
 * `TestCase` and `CoverageRecord` and are not extractor packages.
 */
function tree(): Record<string, string> {
  const pkg = (
    dir: string,
    name: string,
    source: string,
    extra: Record<string, unknown> = {},
  ): Record<string, string> => ({
    [`packages/${dir}/package.json`]: JSON.stringify({ name, ...extra }),
    [`packages/${dir}/src/index.ts`]: source,
  });
  const catalog = [
    '| Code | What |',
    '| --- | --- |',
    ...Array.from({ length: 10 }, (_, i) => `| X${i + 1} | detector ${i + 1} |`),
  ].join('\n');
  return {
    'package.json': JSON.stringify({
      name: 'seamline-monorepo',
      private: true,
      engines: { node: '>=22.13.0' },
    }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'README.md': `${catalog}\n`,
    ...DETECTOR_FILES_PREFIX,
    ...pkg(
      'contradictions',
      '@seamline/contradictions',
      "export const kinds = ['TestCase', 'CoverageRecord'];\n",
    ),
    ...pkg('mcp', '@seamline/mcp', "export const kinds = ['TestCase', 'CoverageRecord'];\n"),
    ...pkg(
      'ontology',
      '@seamline/ontology',
      "export interface ExtractorManifest { name: string }\nexport const NODE_KINDS = ['TestCase', 'CoverageRecord', 'Symbol'];\n",
    ),
    ...pkg(
      'core',
      '@seamline/core',
      "import type { ExtractorManifest } from '@seamline/ontology';\nexport const check = (m: ExtractorManifest): string => m.name;\n",
    ),
    ...pkg(
      'extract-change',
      '@seamline/extract-change',
      "export const kinds = ['Commit', 'Changeset'];\n",
    ),
    ...pkg(
      'extract-code-ts',
      '@seamline/extract-code-ts',
      "export const kinds = ['Symbol', 'File'];\n",
    ),
    ...pkg(
      'extract-contracts',
      '@seamline/extract-contracts',
      "export const kinds = ['Contract'];\n",
    ),
    ...pkg('extract-data', '@seamline/extract-data', "export const kinds = ['Table', 'Column'];\n"),
    ...pkg('infer-join', '@seamline/infer-join', 'export const none = 0;\n'),
  };
}

describe('the frozen pre-fix detector registry', () => {
  const ran = run(tree(), { results: ALL_PASS });
  const state = (n: number): string => {
    const f = ran.findings.find(
      (x) => x.id.endsWith(`DETECTOR_LIVENESS:detector:X${n}`) && x.class !== 'Resolved',
    );
    return f === undefined ? 'live' : `${f.class}:${f.reason}`;
  };

  test('X10 is the only detector found dormant: X1 to X9 are live', () => {
    for (let n = 1; n <= 9; n += 1) assert.equal(state(n), 'live', `X${n}`);
    assert.equal(state(10), 'Unexplained gap:absent-in-implementation');
  });

  test('the X10 fact rests on the scope check and states its basis', () => {
    const fact = ran.find('detector:X10')?.fact;
    assert.equal(fact?.result, 'ABSENT');
    assert.match(fact?.detail ?? '', /^node-kind level/);
    assert.match(fact?.detail ?? '', /CoverageRecord or TestCase/);
    assert.match(fact?.detail ?? '', /code\.ts=PASS, contracts=PASS, data=PASS, infer-join=PASS/);
    assert.match(
      fact?.detail ?? '',
      /@seamline\/core, @seamline\/extract-change, @seamline\/extract-code-ts, @seamline\/extract-contracts, @seamline\/extract-data, @seamline\/infer-join/,
    );
    assert.doesNotMatch(
      fact?.detail ?? '',
      /@seamline\/ontology|@seamline\/mcp|@seamline\/contradictions/,
    );
  });

  test('had one of X10’s three required scopes been missing or failed, the record would be Unknown(scope-not-pass), not a gap', () => {
    for (const missing of ['extract-code-ts', 'extract-data', 'infer-join']) {
      const results = ALL_PASS.filter((r) => r.extractor !== missing);
      const r = run(tree(), { results }).find('detector:X10');
      assert.equal(`${r?.class}:${r?.reason}`, 'Unknown:scope-not-pass', missing);
    }
  });

  test('when an extractor produces TestCase the probe says HOLDS and a marker beside it is Unknown(cannot-confirm-presence), never drift', () => {
    const produced = ALL_PASS.map((r) =>
      r.extractor === 'extract-data'
        ? {
            ...r,
            authoritative: [
              { scope: 'data', kinds: [...(r.authoritative[0]?.kinds ?? []), 'TestCase'] as never },
            ],
          }
        : r,
    );
    const marked = run(
      {
        ...tree(),
        'README.md': `${tree()['README.md']}\n- **X10 (untested PII write path) does not fire on real repositories yet.** Because.\n`,
      },
      { results: produced },
    );
    const x10 = marked.find('detector:X10');
    assert.equal(`${x10?.class}:${x10?.reason}`, 'Unknown:cannot-confirm-presence');
  });
});
