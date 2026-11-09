// SPDX-License-Identifier: Apache-2.0
/** Reviewed semantics only. These artifacts are neither installed nor executed. */
import type * as TS from 'typescript';
import { dirname, relative } from 'node:path';
import { parseDocument } from './document.ts';
import { record, WriteSource, WriteUnknown } from './write-source.ts';

export const WRITE_LIBRARY_SUMMARIES = {
  // Method dispatch is a reviewed artifact property, not version text alone.
  next: {
    version: '16.2.6',
    integrity: 'sha512-qOVgKJg1+At15NpeUP+eJgCHvTCgXsogweq87Ri/Ix7PkqQHg4sdaXmSFqKlgaIXE4kW0g25LE68W87UANlHtw==',
    license: 'MIT',
    artifact: 'https://registry.npmjs.org/next/-/next-16.2.6.tgz',
    artifactSHA256: 'caeb2bdf78396771d8b0ff12d9343429297c36b9a6251ea002f7397119cdaebe',
    source: 'dist/server/route-modules/app-route/module.js',
    sourceSHA256: '792cf7d10795f076bcdbf24b109ca7dfaa874c4c4bc031374095752481a574c9',
    requestAdapterSource: 'dist/server/web/spec-extension/adapters/next-request.js',
    requestAdapterSourceSHA256: '006db434d9d859733b55761d53e2c47e7f1983cea9709bfbdee97c711d3ac3bd',
    httpMethodsSource: 'dist/server/web/http.js',
    httpMethodsSourceSHA256: '6f0a208536438a9bdcba6d7a6ec199b0b0fc570b174362d69b0a4010db3b3482',
  },
  // Published artifact bytes, not the potentially different repository tag.
  // Ordinary-body and query-copy proofs require this validator artifact;
  // input, effects, caller closure and capability checks remain mandatory.
  zod: {
    version: '4.3.6',
    integrity: 'sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==',
    license: 'MIT',
    artifact: 'https://registry.npmjs.org/zod/-/zod-4.3.6.tgz',
    artifactSHA256: '29ee4d2418c0fb6ddc545c28c03ec80b701e345a3f779e50ae23cda0700b1682',
    sourceCitation: 'https://github.com/colinhacks/zod/tree/v4.3.6/packages/zod/src/v4',
    constructorSource: 'src/v4/core/core.ts',
    constructorSourceSHA256: '85f19689b692c0a16a3ded2253c44f88de40131868d2e704853db9cbbed32460',
    source: 'src/v4/core/schemas.ts',
    sourceSHA256: '465c6b93d2bd9752ef7f8122dcff9cfa645eddbed846316b1121ca067b0d6b67',
    parseSource: 'src/v4/core/parse.ts',
    parseSourceSHA256: 'd57d675f81cc59fb20fbc25305f38379af0600bdfe2779343cc2b4dfc5bc97bf',
    utilSource: 'src/v4/core/util.ts',
    utilSourceSHA256: 'b58f5acb35f492382dd941e6138b19404b3743956a849d5ecc209aef683f0a0d',
    classicSource: 'src/v4/classic/schemas.ts',
    classicSourceSHA256: 'd13a8092711449534e8896259f761c1ed52386cbdea082a39964efe1494070c6',
  },
  '@prisma/extension-read-replicas': {
    version: '0.5.0',
    integrity: 'sha512-t0kLjqFMte4wwGrZFhya4iFoyoOY4kjlyyE60WXZL66PqP6PcBpW/35eKb/3UcxgjJxcDlaJKfmGokFLOyafiQ==',
    commit: '1177e51a014e1bc680ea3de0f811bb7d2427a769',
    source: 'src/extension.ts',
    sourceSHA256: '62454ecdee78cd0e500cb2aa9dc9f4d686fc074f6ae237aa68190987b21e6ecb',
  },
  'next-intl': {
    version: '4.9.2',
    integrity: 'sha512-AZoMRsVGLZczB2hisq1OTWmNAYAKwk/jaWH4+9pfl5TCG8kbILZZptZHux9zw7DyN1yzh6X7jmaQvoykHs9Y7Q==',
    commit: 'e1b18258075017216165735212568c8f795e1660',
    source: 'packages/next-intl/src/plugin/getNextConfig.tsx',
    sourceSHA256: '07c0547cd5a41ad1f3bb7b58de824d69a49bd49582bbb026f798cbdb510c9cc3',
    factorySourceSHA256: '25b19066370406f14cbb2f61b3347aacf236e60584dbacde8ef0b1f43dd01e1b',
  },
} as const;

function parsedYaml(project: WriteSource, path: string): Record<string, unknown> {
  return project.structured(path, text => {
    const parsed = parseDocument(path, text);
    if (!parsed.ok || !record(parsed.value)) throw new WriteUnknown('WRITE_LOCK_METADATA_UNKNOWN');
    return parsed.value;
  });
}

function hasOverrides(value: Record<string, unknown>): boolean {
  return ['overrides', 'patchedDependencies', 'packageExtensions', 'pnpmfile'].some(key =>
    value[key] !== undefined && (!record(value[key]) || Object.keys(value[key]).length !== 0));
}

export interface WriteLockedPackage {
  readonly packageName: string;
  readonly version: string;
  readonly snapshot: string;
  readonly lock: Readonly<Record<string, unknown>>;
  readonly lockPath: string;
  readonly rootManifest: Readonly<Record<string, unknown>>;
}

/** Shared declaration, customization and importer checks; no artifact permission. */
export function readLockedPackage(project: WriteSource, file: TS.SourceFile,
  packageName: string): WriteLockedPackage {
  // A lock entry cannot turn a local source or resolver override into the
  // reviewed package merely by repeating its version and integrity fields.
  project.assertExternalImport(file, packageName);
  if (project.inventory.some(path => /(?:^|\/)(?:\.?pnpmfile\.[cm]?js|\.npmrc)$/.test(path)))
    throw new WriteUnknown('WRITE_PACKAGE_HOOK_OR_CONFIG');
  const owner = project.owner(file);
  const declarations = ['dependencies', 'devDependencies', 'optionalDependencies']
    .map(key => owner.manifest[key])
    .filter(record)
    .map(dependencies => dependencies[packageName])
    .filter(value => value !== undefined);
  if (declarations.length !== 1 || typeof declarations[0] !== 'string')
    throw new WriteUnknown('WRITE_PACKAGE_DECLARATION_UNKNOWN');
  const candidates = project.inventory.filter(path => path.endsWith('pnpm-lock.yaml'))
    .filter(path => {
      const directory = dirname(project.path(project.root, path));
      const distance = relative(directory, owner.directory);
      return distance === '' || (!distance.startsWith('..') && !distance.startsWith('/'));
    });
  if (candidates.length !== 1) throw new WriteUnknown('WRITE_LOCK_METADATA_UNKNOWN');
  const lockPath = candidates[0] as string;
  const lockDirectory = dirname(project.path(project.root, lockPath));
  const lock = parsedYaml(project, lockPath);
  const rootManifest = project.json(project.rel(project.path(lockDirectory, 'package.json')));
  if (hasOverrides(lock) || (record(rootManifest['pnpm']) && hasOverrides(rootManifest['pnpm'])))
    throw new WriteUnknown('WRITE_ARTIFACT_CUSTOMIZED');
  const workspacePath = project.rel(project.path(lockDirectory, 'pnpm-workspace.yaml'));
  if (project.inventory.includes(workspacePath) && hasOverrides(parsedYaml(project, workspacePath)))
    throw new WriteUnknown('WRITE_ARTIFACT_CUSTOMIZED');
  const importers = lock['importers'];
  const importerName = relative(lockDirectory, owner.directory).split('\\').join('/') || '.';
  const importer = record(importers) ? importers[importerName] : undefined;
  if (!record(importer)) throw new WriteUnknown('WRITE_LOCK_METADATA_UNKNOWN');
  const entries = ['dependencies', 'devDependencies', 'optionalDependencies']
    .map(key => importer[key]).filter(record)
    .map(dependencies => dependencies[packageName]).filter(value => value !== undefined);
  const entry = entries[0];
  if (entries.length !== 1 || !record(entry) || entry['specifier'] !== declarations[0] ||
      typeof entry['version'] !== 'string') throw new WriteUnknown('WRITE_LOCK_METADATA_UNKNOWN');
  const version = entry['version'].split('(')[0] as string;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new WriteUnknown('WRITE_PACKAGE_VERSION_UNKNOWN');
  return { packageName, version, snapshot: `${packageName}@${entry['version']}`,
    lock, lockPath, rootManifest };
}

/** Exact declared and locked artifact, with no in-repository customization hook. */
export function lockedVersion(project: WriteSource, file: TS.SourceFile, packageName: string): string {
  const { version, lock } = readLockedPackage(project, file, packageName);
  const summaries: Readonly<Record<string, { readonly version: string; readonly integrity: string }>> = WRITE_LIBRARY_SUMMARIES;
  const summary = summaries[packageName];
  if (summary !== undefined) {
    const packages = lock['packages'];
    const artifact = record(packages) ? packages[`${packageName}@${version}`] : undefined;
    const resolution = record(artifact) ? artifact['resolution'] : undefined;
    if (version !== summary.version || !record(resolution) ||
        Object.keys(resolution).some(key => key !== 'integrity') ||
        resolution['integrity'] !== summary.integrity)
      throw new WriteUnknown('WRITE_REVIEWED_ARTIFACT_MISMATCH');
  }
  return version;
}
