/**
 * Fixture builders for the alignment tests. Everything is synthesised from
 * scratch (aspirational 6A.7) and held in memory, so a fixture with a syntax
 * error or a merge-conflict marker is a string and never a file the compiler or
 * an extractor reads.
 */

import type { ExtractorResult } from '@seamline/ontology';
import { evaluate, type EvaluateInput } from '../engine.ts';
import type { AlignFacts, FactsRun, ImportEdge } from '../facts.ts';
import type { Baseline } from '../baseline.ts';
import { readBaseline } from '../baseline.ts';
import type { Packet, PacketFinding, PacketBody } from '../packet.ts';
import { redactPacket } from '../redact.ts';
import { memTree } from '../tree.ts';
import type { AlignClass } from '../types.ts';
import { dirname, joinPosix, sha256Tagged } from '../util.ts';

export const REPO = 'fx';
export const COMMIT = 'c'.repeat(40);

const result = (extractor: string, scope: string, kinds: string[], status: ExtractorResult['status'] = 'PASS'): ExtractorResult => ({
  extractor,
  version: '1.0.0',
  status,
  authoritative: [{ scope, kinds: kinds as never }],
  nodeCount: 0,
  edgeCount: 0,
  durationMs: 0,
  diagnostics: [],
});

/** The four non-history extractors, all `PASS`, as the committed baseline SIF records them. */
export const ALL_PASS: readonly ExtractorResult[] = [
  result('extract-code-ts', 'code.ts', ['CodeField', 'File', 'Module', 'Parameter', 'Repo', 'RouteHandler', 'Symbol']),
  result('extract-data', 'data', ['DataSource', 'Schema', 'Table', 'Column', 'Migration']),
  result('extract-contracts', 'contracts', ['Contract', 'Operation', 'SchemaProperty', 'RouteHandler']),
  result('infer-join', 'infer-join', []),
];

export function withResult(
  results: readonly ExtractorResult[],
  extractor: string,
  change: (r: ExtractorResult) => ExtractorResult,
): ExtractorResult[] {
  return results.map((r) => (r.extractor === extractor ? change(r) : r));
}

export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** Static file-level import edges, the way `extract-code-ts` records them: `import` and `export ... from` only. */
export function staticImports(files: Readonly<Record<string, string>>): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const tracked = new Set(Object.keys(files));
  for (const [path, text] of Object.entries(files)) {
    if (!SOURCE_FILE.test(path)) continue;
    for (const m of text.matchAll(/^\s*(import|export)\b[^;'"]*?\bfrom\s+['"](\.[^'"]+)['"]/gm)) {
      const dst = joinPosix(dirname(path), m[2] ?? '');
      if (tracked.has(dst)) edges.push({ src: path, dst, reExport: m[1] === 'export' });
    }
  }
  return edges;
}

export interface FactsOptions {
  readonly results?: readonly ExtractorResult[];
  readonly runs?: readonly FactsRun[];
  readonly source?: 'store' | 'sif';
  /** Paths the run read. Default: every tracked TypeScript or JavaScript file. */
  readonly files?: readonly string[];
  /** Paths carrying a Symbol node. Default: files that declare something. */
  readonly symbolPaths?: readonly string[];
  readonly imports?: readonly ImportEdge[];
  readonly runId?: string;
}

export function factsFor(files: Readonly<Record<string, string>>, options: FactsOptions = {}): AlignFacts {
  const read = options.files ?? Object.keys(files).filter((p) => SOURCE_FILE.test(p) && !/\.d\.[cm]?ts$/.test(p));
  const declares = (text: string): boolean => /^export\s+(?:const|function|class|interface|type|default)\b/m.test(text);
  const runs: readonly FactsRun[] = options.runs ?? [
    { runId: options.runId ?? 'run-fixture', commit: null, ontologyVersion: null, results: options.results ?? ALL_PASS },
  ];
  return {
    source: options.source ?? 'sif',
    digest: sha256Tagged(JSON.stringify(runs)),
    runs,
    files: read,
    symbolPaths: options.symbolPaths ?? read.filter((p) => declares(files[p] ?? '')),
    imports: options.imports ?? staticImports(files),
  };
}

export interface RunOptions extends FactsOptions {
  readonly baseline?: Baseline | null;
  readonly config?: EvaluateInput['config'];
  readonly limits?: EvaluateInput['limits'];
  readonly ts?: EvaluateInput['ts'];
  readonly facts?: AlignFacts;
  readonly commit?: string | null;
}

export interface Ran {
  readonly body: PacketBody;
  readonly packet: Packet;
  readonly bytes: string;
  readonly findings: readonly PacketFinding[];
  readonly find: (suffix: string, cls?: AlignClass) => PacketFinding | undefined;
  readonly ids: () => string[];
}

/** Evaluate an in-memory repository and redact the result. */
export function run(files: Readonly<Record<string, string>>, options: RunOptions = {}): Ran {
  const body = evaluate({
    repo: REPO,
    tree: memTree(files),
    commit: options.commit === undefined ? COMMIT : options.commit,
    worktree: options.commit === null,
    facts: options.facts ?? factsFor(files, options),
    baseline: options.baseline ?? null,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.ts === undefined ? {} : { ts: options.ts }),
    producer: { toolVersion: '0.0.0-test', sifVersion: '1.0.0' },
  });
  const sealed = redactPacket(body);
  return {
    body,
    packet: sealed.packet,
    bytes: sealed.bytes,
    findings: sealed.packet.findings,
    find: (suffix, cls) => sealed.packet.findings.find((f) => f.id.endsWith(suffix) && (cls === undefined || f.class === cls)),
    ids: () => sealed.packet.findings.map((f) => `${f.class}|${f.id.slice(`${REPO}:align:`.length)}`),
  };
}

/** A packet read back as a baseline, exactly as `--baseline` would read the written file. */
export function asBaseline(ran: Ran): Baseline {
  return readBaseline(ran.bytes);
}

// ---------------------------------------------------------------------------
// The 12.2 cases
// ---------------------------------------------------------------------------

export interface CaseOptions {
  /** The format sentence of the README, or `null` for none. */
  readonly formats?: string | null;
  /** The floor written in `docs/toolchain.md`, for example `20.1`. */
  readonly floor?: string;
  /** `engines.node` of the root manifest. */
  readonly engines?: string;
  /** Is the guarded module imported by a non-test, non-barrel file? */
  readonly wired?: boolean;
  /** The kind detector X3 reads. */
  readonly x3Kind?: string;
  /** Extra README text, for example a marker sentence. */
  readonly extraReadme?: string;
  /** Break the root manifest (a merge-conflict marker). */
  readonly rootBroken?: boolean;
  /** Replace or add files. */
  readonly files?: Readonly<Record<string, string>>;
}

const DETECTOR = (code: string, kind: string, scopes: string): string =>
  `import { defineDetector } from '../define.ts';\nimport { factNodes } from '../facts.ts';\nimport { SCOPE_CODE, SCOPE_DATA } from '../scopes.ts';\n\nexport const detector = defineDetector({\n  code: '${code}',\n  requiredScopes: [${scopes}],\n  find(g: unknown) {\n    return factNodes(g, '${kind}');\n  },\n});\n`;

/** The small repository of 12.2: root manifest, workspace file, a CLI with an option spec, docs, a guarded module. */
export function caseFiles(options: CaseOptions = {}): Record<string, string> {
  const formats = options.formats === undefined ? 'Output is JSON, CSV, and Mermaid from the CLI.' : options.formats;
  const wired = options.wired ?? false;
  const files: Record<string, string> = {
    'package.json': options.rootBroken
      ? '<<<<<<< ours\n{ "name": "fx" }\n=======\n{ "name": "fx2" }\n>>>>>>> theirs\n'
      : JSON.stringify({ name: 'fx', private: true, engines: { node: options.engines ?? '>=20.3.0' } }, null, 2),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'packages/cli/package.json': JSON.stringify({ name: '@fx/cli', bin: { fx: './dist/bin.js' } }),
    'packages/cli/src/bin.ts': "import { OPTIONS } from './args.ts';\n\nexport const main = (): unknown => OPTIONS;\n",
    'packages/cli/src/args.ts': "export const OPTIONS = {\n  json: { type: 'boolean' },\n  text: { type: 'boolean' },\n};\n",
    'packages/contradictions/package.json': JSON.stringify({ name: '@fx/contradictions' }),
    'packages/contradictions/src/scopes.ts': "export const SCOPE_CODE = 'code.ts';\nexport const SCOPE_DATA = 'data';\n",
    'packages/contradictions/src/define.ts': 'export const defineDetector = <T>(d: T): T => d;\n',
    'packages/contradictions/src/facts.ts': 'export const factNodes = (g: unknown, kind: string): unknown[] => [g, kind];\n',
    'packages/contradictions/src/detectors/x1.ts': DETECTOR('X1_NULLABILITY', 'Column', 'SCOPE_CODE, SCOPE_DATA'),
    'packages/contradictions/src/detectors/x2.ts': DETECTOR('X2_TYPE', 'Symbol', 'SCOPE_CODE'),
    'packages/contradictions/src/detectors/x3.ts': DETECTOR('X3_CONSTRAINT', options.x3Kind ?? 'TestCase', 'SCOPE_CODE, SCOPE_DATA'),
    'packages/contradictions/src/detectors/index.ts':
      "import { detector as x1 } from './x1.ts';\nimport { detector as x2 } from './x2.ts';\nimport { detector as x3 } from './x3.ts';\n\nexport const ALL_DETECTORS = [x1, x2, x3];\n",
    'packages/guard/package.json': JSON.stringify({ name: '@fx/guard' }),
    'packages/guard/src/guard.ts': 'export function guard(): boolean {\n  return true;\n}\n',
    'packages/guard/src/guard.test.ts': "import { guard } from './guard.ts';\n\nguard();\n",
    'packages/guard/src/index.ts': "export * from './guard.ts';\n",
    'docs/toolchain.md': `# Toolchain\n\n- **Node >= ${options.floor ?? '20.1'}** is required.\n`,
    'README.md': [
      '# Fixture',
      '',
      ...(formats === null ? [] : [formats, '']),
      ...(options.extraReadme === undefined ? [] : [options.extraReadme, '']),
      '| Code | Meaning |',
      '| --- | --- |',
      '| X1 | nullability |',
      '| X2 | type |',
      '| X3 | constraint |',
      '',
      '## Controls',
      '',
      '| # | Control | Where |',
      '| --- | --- | --- |',
      '| C1 | The guard is wired into the cli. | `packages/guard/src/guard.ts` |',
      '',
    ].join('\n'),
  };
  if (wired) files['packages/guard/src/use.ts'] = "import { guard } from './guard.ts';\n\nexport const used = guard();\n";
  return { ...files, ...options.files };
}

export function runCase(options: CaseOptions & Omit<RunOptions, 'files'> = {}): Ran {
  const { formats: _f, floor: _fl, engines: _e, wired: _w, x3Kind: _x, extraReadme: _r, rootBroken: _b, files: _fs, ...rest } = options;
  const files = caseFiles(options);
  return run(files, rest);
}
