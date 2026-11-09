// SPDX-License-Identifier: Apache-2.0
/** Engine-owned, reviewed artifact semantics. Never supplied by the inspected repository. */
export interface EffectDependency {
  readonly name: string;
  readonly section: 'dependencies' | 'optionalDependencies';
  readonly version: string;
  readonly target: string;
}
export interface EffectArtifact {
  readonly id: string;
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly artifact: string;
  readonly artifactSHA256: string;
  readonly license: string;
  readonly members: readonly { readonly path: string; readonly sha256: string }[];
  readonly initialization: {
    readonly kind: 'closed-reviewed';
    readonly sources: readonly string[];
    readonly argument: string;
  };
  readonly dependencies: readonly EffectDependency[];
  readonly peers: Readonly<Record<string, string>>;
  readonly peerBindings: Readonly<Record<string, string>>;
  readonly peerMeta: Readonly<Record<string, { readonly optional: boolean }>>;
  readonly transitivePeers: readonly string[];
}
export interface LibraryEffectCertificate {
  readonly id: string;
  readonly packageName: string;
  readonly root: string;
  readonly entry: {
    readonly subpath: '.';
    readonly member: string;
    readonly loaders: readonly ['commonjs', 'esm-commonjs-interop'];
  };
  readonly api: 'zero-argument-regexp-factory';
  readonly artifacts: readonly EffectArtifact[];
}

// Published default index.js has no import/require, top-level call or getter.
// Both ordinary CommonJS and ESM interop load the same CommonJS entry. The
// zero-argument call creates only an ordinary object/array and a fresh RegExp
// from artifact-owned literals. It has no input callbacks or ambient effects.
// The proof and restrictions are recorded in docs/evaluation/ansi-regex-effects.md.
export const ANSI_REGEX_EFFECT: LibraryEffectCertificate = {
  id: 'ansi-regex-5.0.1-cjs-regexp-factory-v1',
  packageName: 'ansi-regex', root: 'ansi-regex@5.0.1',
  entry: { subpath: '.', member: 'index.js', loaders: ['commonjs', 'esm-commonjs-interop'] },
  api: 'zero-argument-regexp-factory',
  artifacts: [{
    id: 'ansi-regex@5.0.1', packageName: 'ansi-regex', version: '5.0.1',
    integrity: 'sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==',
    artifact: 'https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz',
    artifactSHA256: '0e0eadcdaada805db5d85b53ad5cdca0760b996ee199ec9658e7b34aa6c8e0d9',
    license: 'MIT',
    members: [
      { path: 'package.json', sha256: '8b2dc166f2b74d5098bad38bdd3dd2f4d4775c626199872f5e36dbb48c40931d' },
      { path: 'index.js', sha256: 'c92312790eb1f246b7c4c1fe9c1247b15441bbca3c6cb64d167beefc45302753' },
      { path: 'license', sha256: '48da2f39e100d4085767e94966b43f4fa95ff6a0698fba57ed460914e35f94a0' },
    ],
    initialization: { kind: 'closed-reviewed', sources: ['package.json', 'index.js'],
      argument: 'docs/evaluation/ansi-regex-effects.md#initialization-and-calls' },
    dependencies: [], peers: {}, peerBindings: {}, peerMeta: {}, transitivePeers: [],
  }],
};

export const LIBRARY_EFFECT_CERTIFICATES: ReadonlyMap<string, LibraryEffectCertificate> =
  new Map([[ANSI_REGEX_EFFECT.packageName, ANSI_REGEX_EFFECT]]);
