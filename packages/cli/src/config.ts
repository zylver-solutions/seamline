/**
 * `seamline.config.json` — shape, defaults, load, and validation.
 *
 * The config is plain JSON with no expression language, because it is read by
 * a tool whose whole point is that its inputs are auditable.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ExportPolicyError,
  FORMAT_DOC_URL,
  parseDeclaredProfiles,
  parseExportProfile,
  type ExportProfile,
} from '@seamline/core';
import { CliError, EXIT_USAGE, usageError } from './io.ts';

export const CONFIG_FILENAME = 'seamline.config.json';
export const DEFAULT_OUT_DIR = 'seamline-out';
export const CONFIG_VERSION = 1;

/**
 * The export profile format is defined, parsed and validated in one place,
 * `@seamline/core` (`parseExportProfile`); this file only reads the
 * `exportProfiles` key and hands it over. See `docs/design/export-profile.md`
 * (published at `FORMAT_DOC_URL`).
 */
export type { ExportProfile };
export { PACKET_KINDS, type PacketKind } from '@seamline/core';

/** `seamline.config.json` key `align`: the document set of `seamline align` (design 3.1). */
export interface AlignConfig {
  readonly docs?: readonly string[];
  readonly exclude?: readonly string[];
}

export interface ExtractorConfig {
  readonly name: string;
  readonly enabled: boolean;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface SeamlineConfig {
  readonly version: number;
  readonly repo: string;
  readonly outDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly extractors: readonly ExtractorConfig[];
  readonly limits: { readonly maxDepth: number; readonly maxResults: number };
  readonly exportProfiles: Readonly<Record<string, ExportProfile>>;
  /** Absent means the closed default document set. */
  readonly align?: AlignConfig;
}

/**
 * The profile `seamline init` scaffolds, named for what it releases: the
 * structure of the repository (paths, the module tree and the import graph),
 * not a public artifact.
 *
 * It is intentionally small: the structural kinds only, extracted facts only,
 * no props, no untrusted text, no run ids. It exists to show the shape of an
 * allow-list, not to be a convenient default that people ship. Widening or
 * narrowing it is a decision the adopter makes and reviews. Its kinds default
 * to `internal`, which is the level it names: a node's kind default is a floor,
 * so no node of these kinds is ever `public`, and the name must not say it is.
 */
export const STARTER_PROFILE_NAME = 'structure';

export const STARTER_PROFILE: ExportProfile = parseExportProfile({
  version: 1,
  name: STARTER_PROFILE_NAME,
  description:
    'Internal-level structure: repo, modules and files with their paths, and the import graph, extracted facts only. This reveals the file layout and dependencies of the repository; it is not a public artifact. Narrow or widen deliberately.',
  allow: [
    ['File', 'internal'],
    ['Module', 'internal'],
    ['Repo', 'internal'],
  ],
  allowEdges: ['CONTAINS', 'IMPORTS'],
  allowProps: {},
  allowEdgeProps: {},
  allowFields: ['id', 'kind', 'name', 'path', 'src', 'dst'],
  allowProvenance: ['EXTRACTED'],
  includeUntrusted: false,
});

export function defaultConfig(repo: string): SeamlineConfig {
  return {
    version: CONFIG_VERSION,
    repo,
    outDir: DEFAULT_OUT_DIR,
    include: ['**/*'],
    exclude: ['node_modules/**', 'dist/**', '.git/**', `${DEFAULT_OUT_DIR}/**`],
    extractors: [
      { name: 'extract-code-ts', enabled: true, options: {} },
      { name: 'extract-data', enabled: true, options: {} },
      { name: 'extract-contracts', enabled: true, options: {} },
      { name: 'extract-change', enabled: true, options: {} },
      { name: 'infer-join', enabled: true, options: {} },
    ],
    limits: { maxDepth: 6, maxResults: 500 },
    exportProfiles: { [STARTER_PROFILE_NAME]: STARTER_PROFILE },
  };
}

/** Serialized form. Keys sorted so a scaffolded config is byte-stable. */
export function serializeConfig(c: SeamlineConfig): string {
  // A profile's name is its key under `exportProfiles`, never a field in the file.
  const declared = Object.fromEntries(
    Object.entries(c.exportProfiles).map(([key, profile]) => {
      const { name: _name, ...rest } = profile;
      return [key, rest];
    }),
  );
  const serializable = { ...c, exportProfiles: declared };
  return `${JSON.stringify(sortKeys(serializable as unknown as JsonValue), null, 2)}\n`;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function sortKeys(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k] as JsonValue);
    return out;
  }
  return v;
}

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILENAME);
}

export async function loadConfig(repoRoot: string): Promise<SeamlineConfig> {
  const file = configPath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new CliError(
      `no ${CONFIG_FILENAME} found in ${repoRoot}`,
      EXIT_USAGE,
      'Run `seamline init` in the repository root first.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      `${CONFIG_FILENAME} is not valid JSON: ${(e as Error).message}`,
      EXIT_USAGE,
      'Fix the syntax error, or delete the file and re-run `seamline init`.',
    );
  }
  return parseConfig(parsed, repoRoot);
}

export function parseConfig(input: unknown, repoRoot: string): SeamlineConfig {
  if (!isRecord(input)) throw usageError(`${CONFIG_FILENAME} must contain a JSON object.`);
  const fallback = defaultConfig(path.basename(repoRoot));

  const version = typeof input['version'] === 'number' ? input['version'] : CONFIG_VERSION;
  if (version !== CONFIG_VERSION) {
    throw usageError(
      `${CONFIG_FILENAME} declares version ${version}; this build understands version ${CONFIG_VERSION}.`,
      'Upgrade seamline, or re-scaffold with `seamline init --force`.',
    );
  }

  const exportProfiles = parseExportProfiles(input['exportProfiles']);

  const extractorsRaw = input['extractors'];
  const extractors: ExtractorConfig[] = [];
  if (extractorsRaw !== undefined) {
    if (!Array.isArray(extractorsRaw)) throw usageError('`extractors` must be an array.');
    for (const e of extractorsRaw) {
      if (!isRecord(e) || typeof e['name'] !== 'string') {
        throw usageError('every entry in `extractors` needs a string `name`.');
      }
      extractors.push({
        name: e['name'],
        enabled: e['enabled'] !== false,
        options: isRecord(e['options']) ? e['options'] : {},
      });
    }
  }

  const limitsRaw = isRecord(input['limits']) ? input['limits'] : {};
  const align = parseAlign(input['align']);
  return {
    version,
    repo:
      typeof input['repo'] === 'string' && input['repo'].length > 0 ? input['repo'] : fallback.repo,
    outDir:
      typeof input['outDir'] === 'string' && input['outDir'].length > 0
        ? input['outDir']
        : DEFAULT_OUT_DIR,
    include: stringArray(input['include']) ?? fallback.include,
    exclude: stringArray(input['exclude']) ?? fallback.exclude,
    extractors: extractorsRaw === undefined ? fallback.extractors : extractors,
    limits: {
      maxDepth: positiveInt(limitsRaw['maxDepth']) ?? fallback.limits.maxDepth,
      maxResults: positiveInt(limitsRaw['maxResults']) ?? fallback.limits.maxResults,
    },
    exportProfiles,
    ...(align === undefined ? {} : { align }),
  };
}

function parseAlign(value: unknown): AlignConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw usageError('`align` must be an object.');
  const docs = value['docs'];
  const exclude = value['exclude'];
  for (const [key, list] of [
    ['docs', docs],
    ['exclude', exclude],
  ] as const) {
    if (list !== undefined && (!Array.isArray(list) || list.some((x) => typeof x !== 'string'))) {
      throw usageError(`\`align.${key}\` must be an array of glob strings.`);
    }
  }
  return {
    ...(docs === undefined ? {} : { docs: docs as string[] }),
    ...(exclude === undefined ? {} : { exclude: exclude as string[] }),
  };
}

/**
 * Absent means none declared: the shipped profiles (`public`, `team`, `audit`)
 * are always available, and nothing is added behind the author's back. Any
 * problem in any declared profile is a usage error naming the profile, because
 * a profile read leniently is how "deny" quietly turns into "allow".
 */
function parseExportProfiles(raw: unknown): Readonly<Record<string, ExportProfile>> {
  if (raw === undefined) return {};
  try {
    return parseDeclaredProfiles(raw);
  } catch (e) {
    if (e instanceof ExportPolicyError) {
      // Many of the messages already end with the format URL; point at it
      // once, never twice.
      throw usageError(
        `${CONFIG_FILENAME}: ${e.message}`,
        e.message.includes(FORMAT_DOC_URL)
          ? undefined
          : `The profile format is described at ${FORMAT_DOC_URL}`,
      );
    }
    throw e;
  }
}

function stringArray(v: unknown): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return undefined;
  return v as string[];
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
