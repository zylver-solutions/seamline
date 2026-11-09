// SPDX-License-Identifier: Apache-2.0
/** Exact context graph checking. Hash-shaped data alone is not a semantic proof. */
import type { LibraryEffectCertificate } from './write-effect-catalog.ts';
import type { WriteLockedPackage } from './write-libraries.ts';
import { record, type WriteSource, WriteUnknown } from './write-source.ts';

const HASH = /^[a-f0-9]{64}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
function fail(code: string): never { throw new WriteUnknown(`WRITE_EFFECT_CERTIFICATE_${code}`); }
const object = (value: unknown): Record<string, unknown> => record(value) ? value : fail('METADATA_UNKNOWN');
const own = (value: unknown, key: string): unknown => {
  const map = object(value); return Object.hasOwn(map, key) ? map[key] : undefined;
};
function equalMap(actual: unknown, expected: unknown, depth = 0): boolean {
  if (actual === undefined && depth === 0) actual = {};
  if (actual === expected) return true;
  if (depth > 3 || !record(actual) || !record(expected)) return false;
  const keys = Object.keys(expected).sort();
  if (Object.keys(actual).length !== keys.length) return false;
  return keys.every(key => Object.hasOwn(actual, key) &&
    (record(expected[key]) ? equalMap(actual[key], expected[key], depth + 1) : actual[key] === expected[key]));
}

/** Internal trusted-catalog boundary; production never passes repository-authored certificates. */
export function verifyEffectClosure(project: WriteSource, context: WriteLockedPackage,
  certificate: LibraryEffectCertificate): void {
  project.assertBudget();
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(certificate), 'utf8'); }
  catch { return fail('CATALOG_UNKNOWN'); }
  if (bytes > 512 * 1024 || certificate.artifacts.length > 1024) project.exhaustCertificateBudget();
  if (context.lock['lockfileVersion'] !== '9.0') fail('LOCK_FORMAT_UNKNOWN');
  if (certificate.packageName !== context.packageName || certificate.root !== context.snapshot ||
      certificate.api !== 'zero-argument-regexp-factory' || certificate.entry.subpath !== '.' || certificate.entry.member !== 'index.js' ||
      JSON.stringify(certificate.entry.loaders) !== '["commonjs","esm-commonjs-interop"]') fail('ENTRY_UNKNOWN');
  const label = JSON.stringify(['effect', certificate.id, context.lockPath, context.snapshot]);
  const artifacts = new Map(certificate.artifacts.map(artifact => [artifact.id, artifact]));
  if (artifacts.size !== certificate.artifacts.length || !artifacts.has(certificate.root)) fail('CATALOG_UNKNOWN');
  const packages = object(context.lock['packages']);
  const snapshots = object(context.lock['snapshots']);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const pending: { id: string; finish: boolean }[] = [{ id: certificate.root, finish: false }];
  let edges = 0; let members = 0;
  while (pending.length > 0) {
    const task = pending.pop() as { id: string; finish: boolean };
    if (task.finish) { visiting.delete(task.id); visited.add(task.id); continue; }
    if (visiting.has(task.id)) fail('CYCLE');
    if (visited.has(task.id)) continue;
    const artifact = artifacts.get(task.id);
    if (artifact === undefined) fail('DEPENDENCY_UNKNOWN');
    project.chargeSyntax(`${label}:artifact:${task.id}`, 1);
    if (!INTEGRITY.test(artifact.integrity) || !HASH.test(artifact.artifactSHA256) || !artifact.license ||
        !/^\d+\.\d+\.\d+$/.test(artifact.version) ||
        !(artifact.id === `${artifact.packageName}@${artifact.version}` ||
          artifact.id.startsWith(`${artifact.packageName}@${artifact.version}(`))) fail('CATALOG_UNKNOWN');
    const recordKey = `${artifact.packageName}@${artifact.version}`;
    const metadata = object(own(packages, recordKey));
    const resolution = object(own(metadata, 'resolution'));
    if (Object.keys(resolution).length !== 1 || !Object.hasOwn(resolution, 'integrity') || resolution['integrity'] !== artifact.integrity) fail('ARTIFACT_MISMATCH');
    if (!equalMap(metadata['peerDependencies'], artifact.peers) ||
        !equalMap(metadata['peerDependenciesMeta'], artifact.peerMeta)) fail('CONTEXT_MISMATCH');
    const snapshot = object(own(snapshots, artifact.id));
    if (Object.keys(snapshot).some(key => !['dependencies', 'optionalDependencies', 'transitivePeerDependencies'].includes(key)))
      fail('CONTEXT_MISMATCH');
    const actualPeers = snapshot['transitivePeerDependencies'] ?? [];
    if (!Array.isArray(actualPeers) || actualPeers.length !== artifact.transitivePeers.length ||
        actualPeers.some(peer => typeof peer !== 'string') ||
        JSON.stringify([...actualPeers].sort()) !== JSON.stringify([...artifact.transitivePeers].sort())) fail('CONTEXT_MISMATCH');
    const memberNames = new Set<string>();
    for (const [index, member] of artifact.members.entries()) {
      if (++members > 4096) project.exhaustCertificateBudget();
      project.chargeSyntax(`${label}:member:${task.id}:${index}`, 1);
      if (memberNames.has(member.path) || !HASH.test(member.sha256) || !member.path ||
          member.path.startsWith('/') || member.path.includes('\\') ||
          member.path.split('/').some(part => ['', '.', '..'].includes(part))) fail('CATALOG_UNKNOWN');
      memberNames.add(member.path);
    }
    if (artifact.initialization.kind !== 'closed-reviewed' || !artifact.initialization.argument ||
        artifact.initialization.sources.length === 0 ||
        artifact.initialization.sources.some(source => !memberNames.has(source))) fail('INITIALIZATION_UNKNOWN');
    if (!memberNames.has('package.json')) fail('INITIALIZATION_UNKNOWN');
    if (task.id === certificate.root && (!memberNames.has(certificate.entry.member) ||
        !artifact.initialization.sources.includes(certificate.entry.member))) fail('ENTRY_UNKNOWN');
    if (Object.keys(artifact.peerBindings).length !== Object.keys(artifact.peers).length ||
        Object.keys(artifact.peers).some(name => !Object.hasOwn(artifact.peerBindings, name) ||
          !artifact.dependencies.some(edge => edge.name === name && edge.target === artifact.peerBindings[name])))
      fail('CONTEXT_MISMATCH');
    const expected = new Map<string, string>();
    for (const [index, edge] of artifact.dependencies.entries()) {
      if (++edges > 4096) project.exhaustCertificateBudget();
      const key = `${edge.section}:${edge.name}`;
      project.chargeSyntax(`${label}:edge:${task.id}:${index}`, 1);
      if (!['dependencies', 'optionalDependencies'].includes(edge.section) || expected.has(key) ||
          edge.target !== `${edge.name}@${edge.version}` || !artifacts.has(edge.target)) fail('DEPENDENCY_UNKNOWN');
      expected.set(key, edge.version);
    }
    const observed = new Map<string, string>();
    for (const section of ['dependencies', 'optionalDependencies']) {
      const dependencies = snapshot[section] === undefined ? {} : object(snapshot[section]);
      for (const [name, version] of Object.entries(dependencies)) {
        if (typeof version !== 'string') fail('DEPENDENCY_UNKNOWN');
        observed.set(`${section}:${name}`, version);
      }
    }
    if (observed.size !== expected.size || [...expected].some(([key, version]) => observed.get(key) !== version))
      fail('DEPENDENCY_MISMATCH');
    visiting.add(task.id); pending.push({ id: task.id, finish: true });
    for (const edge of [...artifact.dependencies].reverse()) pending.push({ id: edge.target, finish: false });
  }
  if (visited.size !== artifacts.size) fail('CATALOG_UNKNOWN');
  project.assertBudget();
}
