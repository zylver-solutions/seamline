/**
 * The export profile format: its type, its closed vocabulary, and the one
 * parser that every consumer loads it through. Design: `docs/design/export-profile.md`.
 *
 * A profile is an allow-list (design v3 section 2.5). This module decides what
 * a profile *is*; `export-policy.ts` decides what a profile *does* to a graph.
 * Nothing else may construct an `ExportProfile` from outside input. The CLI's
 * `export` and `mcp` commands, the MCP server and the built-in profiles all
 * come through `parseExportProfile`, so there is exactly one place where a
 * malformed profile can be read leniently, and that place reads nothing
 * leniently:
 *
 * - `version` is required and must be one this build understands;
 * - an unknown field is an error, never ignored, because a field a reader
 *   skips is a restriction the author believed they had written down;
 * - every list is checked against a closed vocabulary, with no duplicates;
 * - no list that is meant to admit something may be empty, so "admits
 *   nothing" is never confused with "admits everything".
 *
 * The input is copied to plain data before it is read, then validated, then
 * returned as a deep-frozen canonical copy (every set sorted), so a caller's
 * object cannot change what a server admits after the fact, and two files
 * that say the same thing parse to deep-equal values.
 */

import { EDGE_KINDS, NODE_KINDS, PROVENANCE, SENSITIVITY } from '@seamline/ontology';
import type { EdgeKind, NodeKind, Provenance, Sensitivity } from '@seamline/ontology';

/** The only profile format version this build reads. */
export const EXPORT_PROFILE_VERSION = 1;

/** `'*'` admits every prop of that kind. It must be written per kind. */
export type PropAllowance = ReadonlyArray<string> | '*';

/**
 * The record fields a profile selects with `allowFields`. A file written by
 * `applyProfile` carries exactly the fields the profile names, so a field the
 * author did not write down is not released: this is the closed list of what
 * can be written down. A name applies to whichever of nodes and edges has the
 * field (`name` and `untrusted` are node fields, `src`, `dst`, `srcFile` and
 * `dstFile` are edge fields, `kind` is both). Listed in the order the output
 * writes them.
 */
export const RECORD_FIELDS = [
  'id',
  'kind',
  'name',
  'path',
  'sensitivity',
  'provenance',
  'confidence',
  'sourceRef',
  'untrusted',
  'props',
  'firstSeenRun',
  'lastSeenRun',
  'deletedAt',
  'src',
  'dst',
  'srcFile',
  'dstFile',
] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

/**
 * Where a record came from in the source tree. Selection applies to these on
 * every surface, the agent view included.
 */
export const LOCATION_FIELDS: ReadonlyArray<RecordField> = [
  'path',
  'sourceRef',
  'srcFile',
  'dstFile',
];

/**
 * When a record was first and last seen, and whether it is a tombstone. Run
 * ids are `run-<ISO timestamp>-<random>` under the real clock, so releasing
 * these puts extraction wall-clock time into every released record and changes
 * the file on every re-extraction. They are never released unless selected.
 */
export const LIFECYCLE_FIELDS: ReadonlyArray<RecordField> = [
  'firstSeenRun',
  'lastSeenRun',
  'deletedAt',
];

/** Every field a version 1 profile may carry, in canonical order. */
export const EXPORT_PROFILE_FIELDS = [
  'version',
  'name',
  'description',
  'allow',
  'allowEdges',
  'allowProps',
  'allowEdgeProps',
  'allowFields',
  'allowProvenance',
  'includeUntrusted',
  'packets',
] as const;

/**
 * The finding packets a profile can opt in to. A packet is a document `seamline
 * align` writes, not a graph export; it leaves only through a profile that names
 * it in `packets` (alignment design 8.8).
 */
export const PACKET_KINDS = ['alignment'] as const;
export type PacketKind = (typeof PACKET_KINDS)[number];

/**
 * Field names of the format `seamline.config.json` used before profiles were
 * versioned. They are not accepted. They are named here only so the error for
 * an old file can say what it is and where the migration is written down.
 */
export const PRE_VERSION_FIELDS = [
  'maxSensitivity',
  'nodeKinds',
  'edgeKinds',
  'fields',
  'props',
  'provenance',
] as const;

export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PROFILE_DESCRIPTION_MAX = 500;
/** C0 and C1 control characters and DEL. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export interface ExportProfile {
  /** Format version. See `EXPORT_PROFILE_VERSION`. */
  readonly version: typeof EXPORT_PROFILE_VERSION;
  /** In `seamline.config.json` this is the key under `exportProfiles`, never a field in the file. */
  readonly name: string;
  readonly description: string;
  /** The allow-list. A pair not present here is denied. */
  readonly allow: ReadonlyArray<readonly [NodeKind, Sensitivity]>;
  readonly allowEdges: ReadonlyArray<EdgeKind>;
  readonly allowProps: Readonly<Partial<Record<NodeKind, PropAllowance>>>;
  readonly allowEdgeProps: Readonly<Partial<Record<EdgeKind, PropAllowance>>>;
  /** The record fields a released node or edge carries. Never released unless named. */
  readonly allowFields: ReadonlyArray<RecordField>;
  /** Provenance levels a node or edge may carry and still be released. Never empty. */
  readonly allowProvenance: ReadonlyArray<Provenance>;
  /** Nodes tagged `untrusted` are withheld unless this is true. */
  readonly includeUntrusted: boolean;
  /**
   * Finding packets that may leave through this profile. Absent means none, and the
   * canonical form leaves the key out when it is absent, so a profile written before
   * this key existed is unchanged. Optional, unlike every other field.
   */
  readonly packets?: ReadonlyArray<PacketKind>;
}

export class ExportPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportPolicyError';
  }
}

/**
 * Where the format is written down. A URL on the public repository, because
 * `docs/` is not in the published packages: an installed user cannot open a path.
 * A test checks that it points at the repository named in the root package.json.
 */
export const FORMAT_DOC_URL =
  'https://github.com/zylver-solutions/seamline/blob/main/docs/design/export-profile.md';
const MIGRATION_DOC_URL = `${FORMAT_DOC_URL}#5-migration`;

/** A value echoed into a message: escaped, so a control character in a profile cannot reach a terminal. */
function quote(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}...` : value);
  }
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The key under `exportProfiles` that names a declared profile. A profile's
 * name is its key, so a bad key is reported as a bad key, naming it (escaped
 * and truncated, so it cannot carry a control character to a terminal), not as
 * a missing `name` field the file is not allowed to contain.
 */
export function assertProfileKey(key: string): void {
  if (!PROFILE_NAME_PATTERN.test(key)) {
    throw new ExportPolicyError(
      `export profile ${quote(key)}: the key under \`exportProfiles\` is the profile's name, and must be 1 to 64 characters from A-Z a-z 0-9 . _ -, starting with a letter or digit`,
    );
  }
}

/** A declared profile's value must be a JSON object; the message names the profile. */
export function assertProfileObject(key: string, value: unknown): asserts value is object {
  if (!isPlainRecord(value)) {
    throw new ExportPolicyError(
      `export profile '${key}': an export profile must be a JSON object, found ${describeKind(value)}`,
    );
  }
}

function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object that is not plain data' : `a ${typeof value}`;
}

/**
 * Read an export profile from untrusted input (parsed JSON, or an object built
 * in code) and return the canonical, deep-frozen profile. Throws
 * `ExportPolicyError` with a message that names the offending field.
 */
export function parseExportProfile(input: unknown): ExportProfile {
  let copy: unknown;
  try {
    copy = structuredClone(input);
  } catch {
    throw new ExportPolicyError(
      'an export profile must be plain data (no functions, symbols or class instances)',
    );
  }
  if (!isPlainRecord(copy)) throw new ExportPolicyError('an export profile must be a JSON object');
  const p = copy;

  const nameValue = p['name'];
  if (typeof nameValue !== 'string' || !PROFILE_NAME_PATTERN.test(nameValue)) {
    throw new ExportPolicyError(
      `an export profile needs a \`name\` of 1 to 64 characters from A-Z a-z 0-9 . _ -, starting with a letter or digit (got ${quote(nameValue)})`,
    );
  }
  const name = nameValue;
  const fail = (what: string): never => {
    throw new ExportPolicyError(`export profile '${name}': ${what}`);
  };

  const legacy = PRE_VERSION_FIELDS.filter((f) => Object.hasOwn(p, f));
  const legacyHint =
    legacy.length === 0
      ? ''
      : ` (found ${legacy.join(', ')}, from the pre-version-1 profile format, which is not read; see ${MIGRATION_DOC_URL})`;

  if (!Object.hasOwn(p, 'version')) {
    fail(
      `missing \`version\`; this build reads export profile format version ${EXPORT_PROFILE_VERSION}${legacyHint}`,
    );
  }
  if (p['version'] !== EXPORT_PROFILE_VERSION) {
    fail(
      `\`version\` is ${quote(p['version'])}; this build reads only version ${EXPORT_PROFILE_VERSION}`,
    );
  }

  for (const key of Object.keys(p).sort(byText)) {
    if (!(EXPORT_PROFILE_FIELDS as readonly string[]).includes(key)) {
      fail(
        `unknown field ${quote(key)}; a version ${EXPORT_PROFILE_VERSION} profile has only: ${EXPORT_PROFILE_FIELDS.join(', ')}${legacyHint}`,
      );
    }
  }

  const description = p['description'];
  if (typeof description !== 'string') fail('needs a string `description`');
  const text = description as string;
  // Code points, as JSON Schema's `maxLength` counts them: an emoji is one.
  if ([...text].length > PROFILE_DESCRIPTION_MAX) {
    fail(`\`description\` is longer than ${PROFILE_DESCRIPTION_MAX} characters`);
  }
  if (CONTROL_CHARACTERS.test(text)) fail('`description` must not contain control characters');

  // allow
  const allow = p['allow'];
  if (!Array.isArray(allow)) fail('needs an `allow` array of [kind, sensitivity] pairs');
  if ((allow as unknown[]).length === 0) {
    fail('`allow` admits nothing; refusing to treat an empty allow-list as "everything"');
  }
  const seenPairs = new Set<string>();
  const pairs: Array<readonly [NodeKind, Sensitivity]> = [];
  (allow as unknown[]).forEach((entry, i) => {
    if (!Array.isArray(entry) || entry.length !== 2)
      fail(`\`allow[${i}]\` is not a [kind, sensitivity] pair`);
    const [k, s] = entry as unknown[];
    if (!(NODE_KINDS as readonly unknown[]).includes(k))
      fail(`\`allow[${i}]\` names unknown node kind ${quote(k)}`);
    if (!(SENSITIVITY as readonly unknown[]).includes(s))
      fail(`\`allow[${i}]\` names unknown sensitivity ${quote(s)}`);
    const key = `${String(k)}|${String(s)}`;
    if (seenPairs.has(key))
      fail(`\`allow[${i}]\` lists (${String(k)}, ${String(s)}) more than once`);
    seenPairs.add(key);
    pairs.push([k as NodeKind, s as Sensitivity] as const);
  });
  pairs.sort((a, b) => byText(a[0], b[0]) || SENSITIVITY.indexOf(a[1]) - SENSITIVITY.indexOf(b[1]));
  const admittedKinds = new Set<string>(pairs.map(([k]) => k));

  // allowEdges
  const allowEdges = distinctVocabulary(
    p['allowEdges'],
    EDGE_KINDS,
    'allowEdges',
    'edge kind',
    fail,
    false,
  );

  // allowProps, allowEdgeProps
  const allowProps = allowances(
    p['allowProps'],
    NODE_KINDS,
    admittedKinds,
    'allowProps',
    'node kind',
    '`allow`',
    fail,
  );
  const allowEdgeProps = allowances(
    p['allowEdgeProps'],
    EDGE_KINDS,
    new Set<string>(allowEdges),
    'allowEdgeProps',
    'edge kind',
    '`allowEdges`',
    fail,
  );

  // allowFields
  const allowFields = distinctVocabulary(
    p['allowFields'],
    RECORD_FIELDS,
    'allowFields',
    'record field',
    fail,
    false,
  );

  // allowProvenance
  const allowProvenance = distinctVocabulary(
    p['allowProvenance'],
    PROVENANCE,
    'allowProvenance',
    'provenance',
    fail,
    true,
  );

  const includeUntrusted = p['includeUntrusted'];
  if (typeof includeUntrusted !== 'boolean')
    fail('needs a boolean `includeUntrusted` (true or false, written down)');

  // packets (optional; absent or empty means no packet may leave)
  let packets: PacketKind[] = [];
  if (Object.hasOwn(p, 'packets')) {
    packets = distinctVocabulary(
      p['packets'],
      PACKET_KINDS,
      'packets',
      'packet kind',
      fail,
      false,
    ) as PacketKind[];
  }

  // Relations between fields. Each one refuses a profile whose parts disagree,
  // because a file and the agent surface would then say different things.
  if (includeUntrusted === true && !allowFields.includes('untrusted')) {
    fail(
      `\`includeUntrusted\` is true but \`allowFields\` does not name \`untrusted\`, so untrusted text would be written without its marker; add \`untrusted\` to \`allowFields\` or set \`includeUntrusted\` to false (see ${FORMAT_DOC_URL})`,
    );
  }
  if (!allowFields.includes('props')) {
    for (const [label, entries] of [
      ['allowProps', allowProps],
      ['allowEdgeProps', allowEdgeProps],
    ] as const) {
      // An entry counts only if it can release a prop: `'*'` or a non-empty
      // list. `[]` releases nothing on either surface, so a file and the agent
      // surface cannot disagree about it.
      const releasesProps = Object.values(entries).some(
        (allowance) => allowance === '*' || (allowance !== undefined && allowance.length > 0),
      );
      if (releasesProps) {
        fail(
          `\`${label}\` is not empty but \`allowFields\` does not name \`props\`, so a file would carry none of those props while the agent surface prints them; add \`props\` to \`allowFields\` or empty \`${label}\` (see ${FORMAT_DOC_URL})`,
        );
      }
    }
  }

  return deepFreeze({
    version: EXPORT_PROFILE_VERSION,
    name,
    description: text,
    allow: pairs,
    allowEdges: allowEdges as EdgeKind[],
    allowProps,
    allowEdgeProps,
    allowFields: allowFields as RecordField[],
    allowProvenance: allowProvenance as Provenance[],
    includeUntrusted: includeUntrusted as boolean,
    ...(packets.length === 0 ? {} : { packets }),
  });
}

/** A list of members of `vocabulary`, each at most once, returned in vocabulary order. */
function distinctVocabulary(
  value: unknown,
  vocabulary: readonly string[],
  label: string,
  noun: string,
  fail: (what: string) => never,
  nonEmpty: boolean,
): string[] {
  if (!Array.isArray(value)) fail(`needs an \`${label}\` array`);
  const list = value as unknown[];
  if (nonEmpty && list.length === 0) {
    fail(
      `\`${label}\` is empty; a profile that releases nothing is refused rather than guessed at`,
    );
  }
  const seen = new Set<string>();
  list.forEach((item, i) => {
    if (typeof item !== 'string' || !vocabulary.includes(item)) {
      fail(
        `\`${label}[${i}]\` names unknown ${noun} ${quote(item)}${label === 'allowFields' ? ` (allowed: ${vocabulary.join(', ')})` : ''}`,
      );
    }
    if (seen.has(item as string))
      fail(`\`${label}[${i}]\` lists ${noun} ${quote(item)} more than once`);
    seen.add(item as string);
  });
  return vocabulary.filter((v) => seen.has(v));
}

/** Per-kind prop allowances, returned with keys and prop lists sorted. */
function allowances<K extends string>(
  value: unknown,
  kinds: readonly K[],
  admitted: ReadonlySet<string>,
  label: string,
  noun: string,
  governedBy: string,
  fail: (what: string) => never,
): Partial<Record<K, PropAllowance>> {
  if (!isPlainRecord(value)) fail(`needs an \`${label}\` object`);
  const entries = value as Record<string, unknown>;
  const out: Partial<Record<K, PropAllowance>> = {};
  for (const kind of Object.keys(entries).sort(byText)) {
    if (!(kinds as readonly string[]).includes(kind))
      fail(`\`${label}\` has an entry for unknown ${noun} ${quote(kind)}`);
    if (!admitted.has(kind))
      fail(`\`${label}.${kind}\` names a kind that ${governedBy} does not admit`);
    const allowance = entries[kind];
    if (allowance === '*') {
      out[kind as K] = '*';
      continue;
    }
    if (!Array.isArray(allowance) || allowance.some((x) => typeof x !== 'string')) {
      fail(`\`${label}.${kind}\` is neither '*' nor a list of prop names`);
    }
    const names = allowance as string[];
    const seen = new Set<string>();
    for (const n of names) {
      if (n.length === 0) fail(`\`${label}.${kind}\` contains an empty prop name`);
      if (seen.has(n)) fail(`\`${label}.${kind}\` lists prop ${quote(n)} more than once`);
      seen.add(n);
    }
    out[kind as K] = [...names].sort(byText);
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
