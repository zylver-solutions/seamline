import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesReads } from '@seamline/core';
import { CHANGE_MANIFEST } from '@seamline/extract-change';
import { manifest as CODE_TS_MANIFEST } from '@seamline/extract-code-ts';
import { MANIFEST as CONTRACTS_MANIFEST } from '@seamline/extract-contracts';
import { MANIFEST as DATA_MANIFEST } from '@seamline/extract-data';
import type { ExtractorManifest } from '@seamline/ontology';
import {
  contentFor,
  extensionOf,
  paddedContentFor,
  sampleForGlob,
  undeclaredName,
} from './globs.ts';

const under = (dir: string | null) => ({ dir, stem: 's' });

describe('sampleForGlob', () => {
  const cases: ReadonlyArray<[string, string | null, string]> = [
    ['**/*.json', 'd', 'd/s.json'],
    ['**/*.json', null, 's.json'],
    ['src/**', 'd', 'src/s'],
    ['**/*.{ts,tsx}', 'd', 'd/s.ts'],
    ['**/*.[yY][mM][lL]', 'd', 'd/s.yml'],
    ['.git/**', 'd', '.git/s'],
    ['a/?.txt', 'd', 'a/a.txt'],
    ['src/*.json', 'd', 'src/s.json'],
    ['{a,b}/x', 'd', 'a/x'],
    ['Makefile', 'd', 'Makefile'],
  ];
  for (const [glob, dir, expected] of cases) {
    it(`${glob} with dir ${String(dir)}`, () => {
      assert.equal(sampleForGlob(glob, under(dir)), expected);
    });
  }

  it('every sample is admitted by the glob it came from, for every bundled extractor', () => {
    for (const manifest of [CODE_TS_MANIFEST, DATA_MANIFEST, CONTRACTS_MANIFEST, CHANGE_MANIFEST]) {
      for (const glob of manifest.reads) {
        for (const dir of ['conformance-samples', null]) {
          const sample = sampleForGlob(glob, under(dir));
          assert.ok(sample !== undefined, `${manifest.name}: ${glob}`);
          assert.ok(
            matchesReads({ reads: [glob] } as unknown as ExtractorManifest, sample),
            `${glob} -> ${sample}`,
          );
        }
      }
    }
  });
});

describe('undeclaredName', () => {
  it('is a name no declared glob of any bundled extractor admits', () => {
    for (const manifest of [CODE_TS_MANIFEST, DATA_MANIFEST, CONTRACTS_MANIFEST, CHANGE_MANIFEST]) {
      const name = undeclaredName(manifest.reads);
      assert.ok(name !== undefined, manifest.name);
      assert.equal(matchesReads(manifest, name), false, `${manifest.name}: ${name}`);
    }
  });

  it('is nothing when every path is declared, rather than a name that is declared after all', () => {
    assert.equal(undeclaredName(['**']), undefined);
  });
});

describe('content', () => {
  it('stays valid for the kind of file the name says it is', () => {
    assert.deepEqual(JSON.parse(contentFor('a.json', 'hello  world')), {
      conformance: 'hello world',
    });
    assert.equal(contentFor('a.ts', 'x'), '// x\n');
    assert.equal(contentFor('a.sql', 'x'), '-- x\n');
    assert.equal(contentFor('a.yaml', 'x'), '# x\n');
    assert.equal(contentFor('a.xml', 'x'), '<!-- x -->\n');
    assert.equal(contentFor('a.dat', 'x'), 'x\n');
  });

  it('padding reaches the size asked for and stays valid JSON for json', () => {
    assert.ok(paddedContentFor('a.ts', 10_000).length >= 10_000);
    const json = paddedContentFor('a.json', 10_000);
    assert.ok(json.length >= 10_000);
    assert.equal(typeof (JSON.parse(json) as { conformance: unknown }).conformance, 'string');
  });

  it('extensionOf', () => {
    assert.equal(extensionOf('a/b/C.JSON'), 'json');
    assert.equal(extensionOf('Makefile'), '');
    assert.equal(extensionOf('.gitignore'), '');
  });
});
