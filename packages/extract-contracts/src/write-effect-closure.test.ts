// SPDX-License-Identifier: Apache-2.0
/** Trusted test-owned graph fixtures exercise metadata proof, never grant production permission. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as ts from 'typescript';
import { ANSI_REGEX_EFFECT, type EffectArtifact, type LibraryEffectCertificate } from './write-effect-catalog.ts';
import { verifyEffectClosure } from './write-effect-closure.ts';
import type { WriteLockedPackage } from './write-libraries.ts';
import { DEFAULT_LIMITS } from './types.ts';
import { WriteSource } from './write-source.ts';
import { makeWriteFixture } from './write-test-support.ts';

function setup(certificate: LibraryEffectCertificate = ANSI_REGEX_EFFECT) {
  const fixture = makeWriteFixture();
  const project = new WriteSource(ts, fixture.root, DEFAULT_LIMITS);
  const packages: Record<string, unknown> = {}; const snapshots: Record<string, unknown> = {};
  for (const artifact of certificate.artifacts) {
    packages[`${artifact.packageName}@${artifact.version}`] = { resolution: { integrity: artifact.integrity },
      peerDependencies: { ...artifact.peers }, peerDependenciesMeta: structuredClone(artifact.peerMeta) };
    const dependencies: Record<string, string> = {}; const optionalDependencies: Record<string, string> = {};
    for (const edge of artifact.dependencies) (edge.section === 'dependencies' ? dependencies : optionalDependencies)[edge.name] = edge.version;
    snapshots[artifact.id] = { dependencies, optionalDependencies, transitivePeerDependencies: [...artifact.transitivePeers] };
  }
  const lock: Record<string, unknown> = { lockfileVersion: '9.0', packages, snapshots };
  const context: WriteLockedPackage = { packageName: certificate.packageName, version: certificate.artifacts[0]?.version ?? 'unknown',
    snapshot: certificate.root, lock, lockPath: 'pnpm-lock.yaml', rootManifest: {} };
  return { project, context, packages, snapshots, close: fixture.dispose };
}

function composed(): LibraryEffectCertificate {
  // These are graph-check fixtures, not additional entries in the production catalog.
  const root = structuredClone(ANSI_REGEX_EFFECT.artifacts[0]); assert.ok(root);
  const version = '1.0.0(peer@2.0.0)';
  return { ...ANSI_REGEX_EFFECT, id: 'trusted-graph-fixture', artifacts: [
    { ...root, dependencies: [{ name: 'fixture-helper', section: 'dependencies', version, target: `fixture-helper@${version}` }] },
    { ...root, id: `fixture-helper@${version}`, packageName: 'fixture-helper', version: '1.0.0', peers: { peer: '2.0.0' },
      peerBindings: { peer: 'peer@2.0.0' }, dependencies: [{ name: 'peer', section: 'dependencies', version: '2.0.0', target: 'peer@2.0.0' }] },
    { ...root, id: 'peer@2.0.0', packageName: 'peer', version: '2.0.0' },
  ] };
}

test('published leaf metadata and both default entry modes match the reviewed artifact', () => {
  const sample = setup();
  try {
    assert.equal(ANSI_REGEX_EFFECT.artifacts[0]?.artifactSHA256, '0e0eadcdaada805db5d85b53ad5cdca0760b996ee199ec9658e7b34aa6c8e0d9');
    assert.equal(ANSI_REGEX_EFFECT.artifacts[0]?.members.find(member => member.path === 'index.js')?.sha256,
      'c92312790eb1f246b7c4c1fe9c1247b15441bbca3c6cb64d167beefc45302753');
    verifyEffectClosure(sample.project, sample.context, ANSI_REGEX_EFFECT);
    sample.project.assertBudget();
  } finally { sample.close(); }
});

test('graph proof matches the exact parent edge and complete peer context', () => {
  const certificate = composed(); const sample = setup(certificate);
  try { verifyEffectClosure(sample.project, sample.context, certificate); }
  finally { sample.close(); }
});

for (const name of ['transitive-integrity', 'parent-slot', 'peer-context', 'optional-slot', 'missing-snapshot', 'unresolved-peer', 'missing-peer-provider'] as const) {
  test(`graph proof refuses ${name}`, () => {
    const certificate = composed(); const sample = setup(certificate);
    try {
      const root = sample.snapshots[certificate.root] as { dependencies: Record<string, string>; optionalDependencies: Record<string, string> };
      const helper = sample.packages['fixture-helper@1.0.0'] as { resolution: { integrity: string }; peerDependencies: Record<string, string> };
      if (name === 'transitive-integrity') helper.resolution.integrity = 'sha512-unreviewed';
      if (name === 'parent-slot') root.dependencies = { different: '1.0.0(peer@2.0.0)' };
      if (name === 'peer-context') root.dependencies['fixture-helper'] = '1.0.0(peer@3.0.0)';
      if (name === 'optional-slot') { root.optionalDependencies = root.dependencies; root.dependencies = {}; }
      if (name === 'missing-snapshot') delete sample.snapshots['fixture-helper@1.0.0(peer@2.0.0)'];
      if (name === 'unresolved-peer') helper.peerDependencies = { peer: '3.0.0' };
      if (name === 'missing-peer-provider') (sample.snapshots['fixture-helper@1.0.0(peer@2.0.0)'] as Record<string, unknown>)['dependencies'] = {};
      assert.throws(() => verifyEffectClosure(sample.project, sample.context, certificate), /WRITE_EFFECT_CERTIFICATE_/);
    } finally { sample.close(); }
  });
}

for (const name of ['entry-member', 'loader-coverage', 'initialization-sources', 'entry-not-in-initialization', 'cycle', 'unreachable-node'] as const) {
  test(`incomplete trusted catalog withholds ${name}`, () => {
    const original = composed();
    const root = original.artifacts[0]; const helper = original.artifacts[1]; const peer = original.artifacts[2]; assert.ok(root && helper && peer);
    const certificate = name === 'entry-member' ? { ...original, entry: { ...original.entry, member: 'license' } } :
      name === 'loader-coverage' ? { ...original, entry: { ...original.entry, loaders: ['commonjs', 'unknown'] as unknown as typeof original.entry.loaders } } :
      name === 'initialization-sources' ? { ...original, artifacts: [{ ...root, initialization: { ...root.initialization, sources: [] } }, helper, peer] } :
      name === 'entry-not-in-initialization' ? { ...original, artifacts: [{ ...root, initialization: { ...root.initialization, sources: ['package.json'] } }, helper, peer] } :
      name === 'cycle' ? { ...original, artifacts: [root, { ...helper, dependencies: [{ name: root.packageName, section: 'dependencies' as const,
        version: root.version, target: root.id }, ...helper.dependencies] }, peer] } : { ...original, artifacts: [{ ...root, dependencies: [] }, helper, peer] };
    const sample = setup(certificate);
    try { assert.throws(() => verifyEffectClosure(sample.project, sample.context, certificate), /WRITE_EFFECT_CERTIFICATE_/); }
    finally { sample.close(); }
  });
}

test('cyclic untrusted peer metadata is an ordinary UNKNOWN rather than an incidental exception', () => {
  const certificate = composed(); const sample = setup(certificate);
  try {
    const cyclic: Record<string, unknown> = {}; cyclic['peer'] = cyclic;
    (sample.packages['fixture-helper@1.0.0'] as Record<string, unknown>)['peerDependencies'] = cyclic;
    assert.throws(() => verifyEffectClosure(sample.project, sample.context, certificate), /WRITE_EFFECT_CERTIFICATE_CONTEXT_MISMATCH/);
  } finally { sample.close(); }
});

test('certificate work replays into a fresh proposal and keeps exhausted syntax budget sticky', () => {
  const sample = setup();
  try {
    sample.project.memoize('certificate-control', () => verifyEffectClosure(sample.project, sample.context, ANSI_REGEX_EFFECT));
    const proposal = new WriteSource(ts, sample.project.root, DEFAULT_LIMITS, undefined, sample.project);
    proposal.chargeSyntax('prior-independent-work', 9998);
    assert.throws(() => proposal.memoize('certificate-control', () => assert.fail('cached proof must replay, not rerun')), /WRITE_SYNTAX_CAP/);
    assert.throws(() => proposal.assertBudget(), /WRITE_SYNTAX_CAP/);
    assert.throws(() => proposal.memoize('unrelated', () => true), /WRITE_SYNTAX_CAP/);
  } finally { sample.close(); }
});

for (const name of ['nodes', 'members', 'serialized-bytes'] as const) {
  test(`certificate ${name} cap latches rather than granting a partial closure`, () => {
    const root = ANSI_REGEX_EFFECT.artifacts[0]; assert.ok(root);
    const certificate = name === 'nodes' ? { ...ANSI_REGEX_EFFECT, artifacts: Array.from({ length: 1025 }, () => ({} as EffectArtifact)) } :
      name === 'members' ? { ...ANSI_REGEX_EFFECT, artifacts: [{ ...root,
        members: [...root.members, ...Array.from({ length: 4097 }, (_, index) => ({ path: `member-${index}.js`, sha256: 'a'.repeat(64) }))] }] } :
        { ...ANSI_REGEX_EFFECT, id: 'x'.repeat(512 * 1024 + 1) };
    const sample = setup();
    try {
      assert.throws(() => verifyEffectClosure(sample.project, sample.context, certificate), /WRITE_EFFECT_CERTIFICATE_CAP/);
      assert.throws(() => sample.project.assertBudget(), /WRITE_EFFECT_CERTIFICATE_CAP/);
    } finally { sample.close(); }
  });
}


test('dependency-edge cap is independently reachable and sticky below other caps', () => {
  const root = ANSI_REGEX_EFFECT.artifacts[0]; assert.ok(root);
  const nodes: EffectArtifact[] = Array.from({ length: 100 }, (_, index) => ({ ...root,
    id: `p${index}@1.0.0`, packageName: `p${index}`, version: '1.0.0', artifact: 'https://example.test/a.tgz',
    members: [{ path: 'index.js', sha256: 'a'.repeat(64) }, { path: 'package.json', sha256: 'b'.repeat(64) }],
    initialization: { kind: 'closed-reviewed', sources: ['index.js'], argument: 'test-owned graph' },
  }));
  let left = 4097;
  const artifacts = nodes.map((node, index) => {
    const targets = nodes.slice(index + 1, index + 1 + left); left -= targets.length;
    return { ...node, dependencies: targets.map(target => ({ name: target.packageName,
      section: 'dependencies' as const, version: target.version, target: target.id })) };
  });
  assert.equal(left, 0);
  const certificate = { ...ANSI_REGEX_EFFECT, packageName: 'p0', root: 'p0@1.0.0', artifacts };
  assert.ok(Buffer.byteLength(JSON.stringify(certificate)) < 512 * 1024, 'byte cap must not mask the edge cap');
  const sample = setup(certificate);
  try {
    assert.throws(() => verifyEffectClosure(sample.project, sample.context, certificate), /WRITE_EFFECT_CERTIFICATE_CAP/);
    assert.throws(() => sample.project.assertBudget(), /WRITE_EFFECT_CERTIFICATE_CAP/);
  } finally { sample.close(); }
});

test('same artifact evidence in distinct lock origins consumes distinct proposal work', () => {
  const sample = setup();
  try {
    verifyEffectClosure(sample.project, sample.context, ANSI_REGEX_EFFECT);
    sample.project.chargeSyntax('other-source-work', 9993);
    assert.throws(() => verifyEffectClosure(sample.project, { ...sample.context, lockPath: 'nested/pnpm-lock.yaml' },
      ANSI_REGEX_EFFECT), /WRITE_SYNTAX_CAP/);
    assert.throws(() => sample.project.assertBudget(), /WRITE_SYNTAX_CAP/);
  } finally { sample.close(); }
});
