/**
 * The bundled extractors, as sandbox programs.
 *
 * This is the one place that says what each bundled extractor is allowed to
 * be. The capability manifests come from the extractor packages themselves
 * (`reads`, `env`, `memMb`, `timeoutS`, `provenanceCeiling`, `produces`);
 * what is added here is only what a manifest cannot express:
 *
 *  - which module is the program and which packages it loads, so the host
 *    knows what code the child must be able to read;
 *  - `exec`, the binaries a program may start. The `ExtractorManifest` type in
 *    the shared contract has no such field, and a manifest must not be able to
 *    ask for it: a manifest arrives with the extractor, a grant is the host's
 *    decision. Only `extract-change` gets one, for `git`, because reading
 *    history is its whole job and the project takes no git library dependency
 *    (v3 section 2.7). The host finds each granted binary on a `PATH` outside
 *    the repository and the child runs exactly that path (`resolveExecGrants`);
 *  - `graphScopes`, for `infer-join`, which reads the run's graph.
 */

import { join } from 'node:path';
import type { AuthoritativeScope } from '@seamline/ontology';
import { CHANGE_MANIFEST } from '@seamline/extract-change';
import { manifest as CODE_TS_MANIFEST } from '@seamline/extract-code-ts';
import { MANIFEST as CONTRACTS_MANIFEST } from '@seamline/extract-contracts';
import { MANIFEST as DATA_MANIFEST } from '@seamline/extract-data';
import { INFER_JOIN_MANIFEST } from '@seamline/infer-join';
import type { ExtractorPort } from '../ports.ts';
import { SNAPSHOT_SCOPES } from '../extractors/infer-join.ts';
import {
  BUILD_ROOT,
  RUNS_FROM_SOURCE,
  createSandboxHost,
  sandboxedPort,
  type SandboxHost,
  type SandboxHostOptions,
  type SandboxProgram,
} from './host.ts';

/**
 * The ceiling on what a manifest may ask for. The bundled extractors declare at
 * most 2 GiB and 10 minutes (`extract-code-ts`, on a large repository); a
 * manifest that asks for more than the most demanding bundled one is refused.
 */
export const FIRST_PARTY_LIMITS = { maxMemMb: 2048, maxTimeoutS: 600 } as const;

function programModule(name: string): string {
  return join(BUILD_ROOT, 'extractors', `${name}${RUNS_FROM_SOURCE ? '.ts' : '.js'}`);
}

export const FIRST_PARTY_PROGRAMS: ReadonlyArray<SandboxProgram> = [
  {
    manifest: CODE_TS_MANIFEST,
    module: programModule('code-ts'),
    packages: ['@seamline/extract-code-ts'],
  },
  { manifest: DATA_MANIFEST, module: programModule('data'), packages: ['@seamline/extract-data'] },
  {
    manifest: CONTRACTS_MANIFEST,
    module: programModule('contracts'),
    packages: ['@seamline/extract-contracts'],
  },
  {
    manifest: CHANGE_MANIFEST,
    module: programModule('change'),
    packages: ['@seamline/extract-change', '@seamline/core'],
    exec: ['git'],
  },
  {
    manifest: INFER_JOIN_MANIFEST,
    module: programModule('infer-join'),
    packages: ['@seamline/infer-join'],
    graphScopes: SNAPSHOT_SCOPES,
  },
];

/**
 * The scopes the bundled extractor called `name` is authoritative for, or none
 * for a name that is not a bundled extractor. `extractCommand` uses it to
 * degrade the scope of a bundled extractor that is configured but not wired in,
 * which has no port to ask.
 */
export function firstPartyScopes(name: string): ReadonlyArray<AuthoritativeScope> {
  return FIRST_PARTY_PROGRAMS.find((p) => p.manifest.name === name)?.manifest.produces ?? [];
}

/** A host for the bundled extractors, reading its environment from `env`. */
export function firstPartyHost(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<SandboxHostOptions> = {},
): SandboxHost {
  return createSandboxHost({ limits: FIRST_PARTY_LIMITS, ...overrides, env });
}

/** Every bundled extractor, each running in the sandbox `host` provides. */
export function sandboxedExtractorPorts(host: SandboxHost): ExtractorPort[] {
  return FIRST_PARTY_PROGRAMS.map((program) => sandboxedPort(host, program));
}
