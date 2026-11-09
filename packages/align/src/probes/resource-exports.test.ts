import assert from 'node:assert/strict';
import { test } from 'node:test';
import { caseFiles, factsFor } from '../__fixtures__/build.ts';
import { DEFAULT_LIMITS, type ProbeEnv } from '../env.ts';
import { buildScopeTable } from '../facts.ts';
import { memTree } from '../tree.ts';
import { loadTs } from '../ts.ts';
import { discoverPackages, entryPoints, sourceFilesOf } from '../workspace.ts';
import { probeDetectorLiveness } from './detector-liveness.ts';
import { probeFormatWitness } from './format-witness.ts';
import { probeModuleWiring } from './module-wiring.ts';

function environment(extra: Record<string, string>): ProbeEnv {
  const files = caseFiles({ files: extra });
  const tree = memTree(files);
  const facts = factsFor(files);
  return { tree, facts, discovery: discoverPackages(tree), commit: 'c'.repeat(40), scopes: buildScopeTable(facts.runs), runMismatch: null, ts: loadTs(), limits: DEFAULT_LIMITS, cache: new Map() };
}

const manifest = (entries: Record<string, unknown>) => JSON.stringify({ name: '@fx/cli', bin: { fx: './dist/bin.js' }, ...entries });

test('JSON main/exports resources do not become syntax or manifest-mention input', () => {
  for (const key of ['main', 'exports']) {
    const path = 'packages/cli/corpus/payload.json';
    const env = environment({ 'packages/cli/package.json': manifest({ [key]: './corpus/payload.json' }), [path]: '{"csv":true,"ExtractorManifest":"TestCase"}' });
    const pkg = env.discovery.packages.find((p) => p.name === '@fx/cli')!;
    assert.ok(entryPoints(env.tree, pkg).files.includes(path), 'resource remains a declared entry');
    assert.ok(!sourceFilesOf(env.tree, env.discovery, pkg).includes(path));
    const format = probeFormatWitness(env, 'csv');
    assert.equal(format.result, 'ABSENT', format.detail);
    const detector = probeDetectorLiveness(env, 'X3');
    assert.equal(detector.result, 'ABSENT', detector.detail);
  }
});

test('a format-bearing resource basename remains a positive name witness', () => {
  const env = environment({ 'packages/cli/package.json': manifest({ exports: './corpus/csv-format.json' }), 'packages/cli/corpus/csv-format.json': '{}' });
  const fact = probeFormatWitness(env, 'csv');
  assert.equal(fact.result, 'HOLDS', fact.detail);
  assert.match(fact.detail, /csv-format/);
});

test('output-directory resource names retain the ordinary name-scan exclusion', () => {
  for (const key of ['main', 'exports']) {
    const env = environment({ 'packages/cli/package.json': manifest({ [key]: './dist/csv-format.json' }), 'packages/cli/dist/csv-format.json': '{}' });
    const fact = probeFormatWitness(env, 'csv');
    assert.equal(fact.result, 'ABSENT', fact.detail);
    assert.equal(probeDetectorLiveness(env, 'X3').result, 'ABSENT');
  }
});

test('a manifest-only output-directory JavaScript fallback still supplies witnesses', () => {
  for (const key of ['main', 'exports']) {
    const env = environment({ 'packages/cli/package.json': manifest({ [key]: './dist/private-entry.js' }), 'packages/cli/dist/private-entry.js': 'export const csv = true; export const ExtractorManifest = { kinds: ["TestCase"] };' });
    const pkg = env.discovery.packages.find((p) => p.name === '@fx/cli')!;
    assert.ok(sourceFilesOf(env.tree, env.discovery, pkg).includes('packages/cli/dist/private-entry.js'));
    assert.equal(probeFormatWitness(env, 'csv').result, 'HOLDS');
    const detector = probeDetectorLiveness(env, 'X3');
    assert.equal(detector.result, 'UNKNOWN', detector.detail);
    assert.equal(detector.reason, 'scope-not-pass', 'manifest mention in an output fallback cannot become false dormancy');
  }
});

test('non-JavaScript bins and missing JavaScript entries still withhold absence', () => {
  for (const extra of [
    { 'packages/cli/package.json': manifest({ bin: { fx: './bin/runner.json' } }), 'packages/cli/bin/runner.json': '{}' },
    { 'packages/cli/package.json': manifest({ exports: './dist/missing.js' }) },
    { 'packages/cli/package.json': manifest({ exports: './corpus/missing.json' }) },
    { 'packages/cli/package.json': manifest({ main: './corpus/missing.json' }) },
  ]) {
    const env = environment(extra);
    for (const fact of [probeFormatWitness(env, 'csv'), probeDetectorLiveness(env, 'X3')]) {
      assert.equal(fact.result, 'UNKNOWN', fact.detail);
      assert.equal(fact.reason, 'source-unreadable');
    }
  }
});

test('unknown non-code entries are unreadable even when their bytes parse as TypeScript', () => {
  for (const key of ['main', 'exports']) {
    const env = environment({ 'packages/cli/package.json': manifest({ [key]: './native/renderer.wasm' }), 'packages/cli/native/renderer.wasm': 'export const csv = true; export const ExtractorManifest = { kinds: ["TestCase"] };' });
    for (const fact of [probeFormatWitness(env, 'csv'), probeDetectorLiveness(env, 'X3')]) {
      assert.equal(fact.result, 'UNKNOWN', fact.detail);
      assert.equal(fact.reason, 'source-unreadable');
    }
  }
});

test('omitting a JSON resource from syntax scans does not remove module-wiring entry status', () => {
  const path = 'packages/cli/corpus/payload.json';
  const env = environment({ 'packages/cli/package.json': manifest({ exports: './corpus/payload.json' }), [path]: '{}' });
  const unobserved = probeModuleWiring(env, [path]);
  assert.equal(unobserved.result, 'UNKNOWN', 'a manifest resource cannot manufacture a File fact');
  assert.equal(unobserved.reason, 'non-extracted-anchor');
  const withFile: ProbeEnv = { ...env, facts: { ...env.facts, files: [...env.facts.files, path] }, cache: new Map() };
  const fact = probeModuleWiring(withFile, [path]);
  assert.equal(fact.result, 'HOLDS', fact.detail);
  assert.equal(fact.binding, 'B1');
  assert.match(fact.detail, /entry point/);
});
