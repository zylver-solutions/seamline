/**
 * The corpus for the export profile format, in the declared form (the object
 * under `exportProfiles.<name>` in `seamline.config.json`, which has no
 * `name`). The cases are grouped by the part of the profile they check. Most
 * groups have rejected fixtures, each with the precise message the parser must
 * give; accepted fixtures are fewer, because the `baseline` profile exercises
 * the accepting side of most rules, and a rule whose accepting side is a
 * boundary (an empty list, a wildcard, the longest description in characters
 * and in emoji) has its own. The count is not a promise of one pair per rule:
 * a missing key and a key of the wrong type reach the same check, so they share
 * a fixture.
 *
 * `export-profile.test.ts` runs every entry through the parser and through the
 * JSON Schema file, and checks that they agree, so the two cannot drift. An
 * entry marked `parser-only` is a rule JSON Schema cannot express (a relation
 * between two fields); the schema accepts it and the parser rejects it, and
 * the schema file says so under `x-seamline-rules`.
 */

export type Expect = 'accepted' | 'rejected' | 'parser-only';

export interface ProfileCase {
  readonly rule: string;
  readonly label: string;
  readonly input: unknown;
  readonly expect: Expect;
  /** For a rejected case: the precise message the parser must give. */
  readonly message?: RegExp;
}

export const VALID: Record<string, unknown> = {
  version: 1,
  description: 'fixture',
  allow: [
    ['File', 'internal'],
    ['Column', 'confidential'],
  ],
  allowEdges: ['IMPORTS'],
  allowProps: { File: ['loc'], Column: '*' },
  allowEdgeProps: { IMPORTS: ['via'] },
  allowFields: ['id', 'kind', 'name', 'path', 'props'],
  allowProvenance: ['EXTRACTED', 'DECLARED'],
  includeUntrusted: false,
};

function without(key: string): Record<string, unknown> {
  const copy = { ...VALID };
  delete copy[key];
  return copy;
}

function accepted(rule: string, label: string, input: unknown): ProfileCase {
  return { rule, label, input, expect: 'accepted' };
}

function rejected(
  rule: string,
  label: string,
  input: unknown,
  message: RegExp,
  expect: Expect = 'rejected',
): ProfileCase {
  return { rule, label, input, expect, message };
}

export const CASES: ReadonlyArray<ProfileCase> = [
  accepted('baseline', 'a complete version 1 profile', VALID),

  // version
  rejected('version is required', 'no version', without('version'), /missing `version`/),
  rejected(
    'version is supported',
    'version 2',
    { ...VALID, version: 2 },
    /`version` is 2; this build reads only version 1/,
  ),
  rejected(
    'version is a number',
    'version "1"',
    { ...VALID, version: '1' },
    /`version` is "1"; this build reads only version 1/,
  ),
  rejected(
    'the pre-version-1 format is named, not read',
    'the old config shape',
    {
      description: 'old',
      maxSensitivity: 'public',
      nodeKinds: ['Repo'],
      edgeKinds: ['CONTAINS'],
      fields: ['id'],
      provenance: ['EXTRACTED'],
      includeUntrusted: false,
      props: [],
    },
    /missing `version`.*found maxSensitivity, nodeKinds, edgeKinds, fields, props, provenance, from the pre-version-1 profile format.*see https:\/\/github\.com\/zylver-solutions\/seamline\/blob\/main\/docs\/design\/export-profile\.md#5-migration\)/,
  ),

  // unknown fields
  rejected(
    'unknown fields are rejected',
    'an extra top-level field',
    { ...VALID, allowAll: true },
    /unknown field "allowAll"/,
  ),
  rejected(
    'unknown fields are rejected',
    'a pre-version-1 field next to version 1',
    { ...VALID, maxSensitivity: 'public' },
    /unknown field "maxSensitivity".*found maxSensitivity, from the pre-version-1/,
  ),
  rejected(
    'unknown fields are rejected',
    'a name inside the file',
    { ...VALID, name: 'x' },
    /remove `name`/,
  ),

  // description
  accepted('description is text', 'an empty description', { ...VALID, description: '' }),
  rejected(
    'description is required',
    'no description',
    without('description'),
    /needs a string `description`/,
  ),
  rejected(
    'description is text',
    'a number',
    { ...VALID, description: 7 },
    /needs a string `description`/,
  ),
  accepted('description is bounded', 'exactly 500 characters', {
    ...VALID,
    description: 'x'.repeat(500),
  }),
  // JSON Schema's `maxLength` counts code points. An emoji is two UTF-16 units
  // and one code point, so 300 of them is 600 units, which the parser once refused
  // while a conforming schema validator accepted.
  accepted('description is bounded', '300 emoji (600 UTF-16 units, 300 characters)', {
    ...VALID,
    description: '\u{1F600}'.repeat(300),
  }),
  accepted('description is bounded', '500 emoji (1000 UTF-16 units, 500 characters)', {
    ...VALID,
    description: '\u{1F600}'.repeat(500),
  }),
  rejected(
    'description is bounded',
    'over 500 characters',
    { ...VALID, description: 'x'.repeat(501) },
    /`description` is longer than 500 characters/,
  ),
  rejected(
    'description is bounded',
    '501 emoji (501 characters)',
    { ...VALID, description: '\u{1F600}'.repeat(501) },
    /`description` is longer than 500 characters/,
  ),
  rejected(
    'description has no control characters',
    'an escape sequence',
    { ...VALID, description: 'a\u001b[2Jb' },
    /`description` must not contain control characters/,
  ),

  // allow
  accepted('allow lists pairs', 'one kind at two levels', {
    ...VALID,
    allow: [
      ['Table', 'confidential'],
      ['Table', 'restricted'],
    ],
    allowProps: {},
  }),
  rejected('allow is required', 'no allow', without('allow'), /needs an `allow` array/),
  rejected(
    'allow is never empty',
    'an empty allow-list',
    { ...VALID, allow: [], allowProps: {} },
    /`allow` admits nothing/,
  ),
  rejected(
    'allow entries are pairs',
    'a one-element entry',
    { ...VALID, allow: [['File']] },
    /`allow\[0\]` is not a \[kind, sensitivity\] pair/,
  ),
  rejected(
    'allow kinds are closed',
    'an unknown kind',
    { ...VALID, allow: [['Widget', 'internal']] },
    /`allow\[0\]` names unknown node kind "Widget"/,
  ),
  rejected(
    'allow sensitivities are closed',
    'an unknown level',
    { ...VALID, allow: [['File', 'secret']] },
    /`allow\[0\]` names unknown sensitivity "secret"/,
  ),
  rejected(
    'allow has no duplicates',
    'a repeated pair',
    {
      ...VALID,
      allow: [
        ['File', 'internal'],
        ['File', 'internal'],
      ],
    },
    /`allow\[1\]` lists \(File, internal\) more than once/,
  ),

  // allowEdges
  accepted('allowEdges may be empty', 'no edges', { ...VALID, allowEdges: [], allowEdgeProps: {} }),
  rejected(
    'allowEdges is required',
    'no allowEdges',
    without('allowEdges'),
    /needs an `allowEdges` array/,
  ),
  rejected(
    'allowEdges kinds are closed',
    'an unknown edge kind',
    { ...VALID, allowEdges: ['LINKS'] },
    /`allowEdges\[0\]` names unknown edge kind "LINKS"/,
  ),
  rejected(
    'allowEdges has no duplicates',
    'a repeated edge kind',
    { ...VALID, allowEdges: ['IMPORTS', 'IMPORTS'] },
    /`allowEdges\[1\]` lists edge kind "IMPORTS" more than once/,
  ),

  // allowProps
  accepted('allowProps takes "*" or names', 'an empty list for a kind', {
    ...VALID,
    allowProps: { File: [] },
  }),
  rejected(
    'allowProps is required',
    'no allowProps',
    without('allowProps'),
    /needs an `allowProps` object/,
  ),
  rejected(
    'allowProps is an object',
    'a list',
    { ...VALID, allowProps: ['File'] },
    /needs an `allowProps` object/,
  ),
  rejected(
    'allowProps kinds are closed',
    'an unknown kind',
    { ...VALID, allowProps: { Widget: '*' } },
    /`allowProps` has an entry for unknown node kind "Widget"/,
  ),
  rejected(
    'allowProps kinds are admitted by allow',
    'a kind that allow does not list',
    { ...VALID, allowProps: { Symbol: '*' } },
    /`allowProps.Symbol` names a kind that `allow` does not admit/,
    'parser-only',
  ),
  rejected(
    'allowProps values are "*" or names',
    'the word all',
    { ...VALID, allowProps: { File: 'all' } },
    /`allowProps.File` is neither '\*' nor a list of prop names/,
  ),
  rejected(
    'allowProps names are strings',
    'a number in the list',
    { ...VALID, allowProps: { File: [1] } },
    /`allowProps.File` is neither '\*' nor a list of prop names/,
  ),
  rejected(
    'allowProps names are not empty',
    'an empty prop name',
    { ...VALID, allowProps: { File: [''] } },
    /`allowProps.File` contains an empty prop name/,
  ),
  rejected(
    'allowProps names have no duplicates',
    'a repeated prop',
    { ...VALID, allowProps: { File: ['a', 'a'] } },
    /`allowProps.File` lists prop "a" more than once/,
  ),

  // allowEdgeProps
  accepted('allowEdgeProps takes "*" or names', 'a wildcard', {
    ...VALID,
    allowEdgeProps: { IMPORTS: '*' },
  }),
  rejected(
    'allowEdgeProps is required',
    'no allowEdgeProps',
    without('allowEdgeProps'),
    /needs an `allowEdgeProps` object/,
  ),
  rejected(
    'allowEdgeProps kinds are closed',
    'an unknown edge kind',
    { ...VALID, allowEdgeProps: { LINKS: '*' } },
    /`allowEdgeProps` has an entry for unknown edge kind "LINKS"/,
  ),
  rejected(
    'allowEdgeProps kinds are listed in allowEdges',
    'an edge kind that allowEdges does not list',
    { ...VALID, allowEdgeProps: { CONTAINS: '*' } },
    /`allowEdgeProps.CONTAINS` names a kind that `allowEdges` does not admit/,
    'parser-only',
  ),

  // allowFields
  accepted('allowFields select record fields', 'identity, a location and the lifecycle', {
    ...VALID,
    allowProps: {},
    allowEdgeProps: {},
    allowFields: ['id', 'kind', 'path', 'firstSeenRun', 'lastSeenRun', 'deletedAt', 'src', 'dst'],
  }),
  accepted('allowFields may be empty', 'no fields (each record is written as {})', {
    ...VALID,
    allowProps: {},
    allowEdgeProps: {},
    allowFields: [],
  }),
  rejected(
    'allowFields is required',
    'no allowFields',
    without('allowFields'),
    /needs an `allowFields` array/,
  ),
  rejected(
    'allowFields are closed',
    'a field a record does not have',
    { ...VALID, allowFields: ['author'] },
    /`allowFields\[0\]` names unknown record field "author" \(allowed: id, kind, name, path, sensitivity, provenance, confidence, sourceRef, untrusted, props, firstSeenRun, lastSeenRun, deletedAt, src, dst, srcFile, dstFile\)/,
  ),
  rejected(
    'allowFields are closed',
    'the wildcard',
    { ...VALID, allowFields: ['*'] },
    /`allowFields\[0\]` names unknown record field "\*"/,
  ),
  rejected(
    'allowFields have no duplicates',
    'a repeated field',
    { ...VALID, allowFields: ['path', 'path'] },
    /`allowFields\[1\]` lists record field "path" more than once/,
  ),

  // allowProvenance
  accepted('allowProvenance lists levels', 'every level', {
    ...VALID,
    allowProvenance: ['EXTRACTED', 'DECLARED', 'INFERRED', 'LLM_SUGGESTED'],
  }),
  rejected(
    'allowProvenance is required',
    'no allowProvenance',
    without('allowProvenance'),
    /needs an `allowProvenance` array/,
  ),
  rejected(
    'allowProvenance is never empty',
    'an empty list',
    { ...VALID, allowProvenance: [] },
    /`allowProvenance` is empty/,
  ),
  rejected(
    'allowProvenance is closed',
    'an unknown level',
    { ...VALID, allowProvenance: ['GUESSED'] },
    /`allowProvenance\[0\]` names unknown provenance "GUESSED"/,
  ),
  rejected(
    'allowProvenance has no duplicates',
    'a repeated level',
    { ...VALID, allowProvenance: ['EXTRACTED', 'EXTRACTED'] },
    /`allowProvenance\[1\]` lists provenance "EXTRACTED" more than once/,
  ),

  // relations between allowFields and the rest
  accepted(
    'props are selected when props are allowed',
    'props named, allowProps and allowEdgeProps set',
    VALID,
  ),
  rejected(
    'allowProps needs props in allowFields',
    'props are allowed for a kind but the file would not carry them',
    { ...VALID, allowFields: ['id', 'kind', 'name', 'path'] },
    /`allowProps` is not empty but `allowFields` does not name `props`.*add `props` to `allowFields` or empty `allowProps` \(see https:\/\/github\.com\/zylver-solutions\/seamline\/blob\/main\/docs\/design\/export-profile\.md\)/,
    'parser-only',
  ),
  rejected(
    'allowEdgeProps needs props in allowFields',
    'props are allowed for an edge kind but the file would not carry them',
    { ...VALID, allowProps: {}, allowFields: ['id', 'kind', 'name', 'path'] },
    /`allowEdgeProps` is not empty but `allowFields` does not name `props`.*empty `allowEdgeProps`/,
    'parser-only',
  ),
  rejected(
    'allowProps needs props in allowFields',
    'one named prop for a kind, props not selected',
    {
      ...VALID,
      allowProps: { File: ['x'] },
      allowEdgeProps: {},
      allowFields: ['id', 'kind', 'name', 'path'],
    },
    /`allowProps` is not empty but `allowFields` does not name `props`/,
    'parser-only',
  ),
  rejected(
    'allowProps needs props in allowFields',
    'a wildcard alone, props not selected',
    {
      ...VALID,
      allowProps: { Column: '*' },
      allowEdgeProps: {},
      allowFields: ['id', 'kind', 'name', 'path'],
    },
    /`allowProps` is not empty but `allowFields` does not name `props`/,
    'parser-only',
  ),
  accepted(
    'allowFields may omit props when no props are allowed',
    'no allowProps, no allowEdgeProps',
    {
      ...VALID,
      allowProps: {},
      allowEdgeProps: {},
      allowFields: ['id', 'kind', 'name', 'path'],
    },
  ),
  accepted(
    'allowProps needs props in allowFields',
    'an empty prop list releases no prop, so props need not be selected',
    {
      ...VALID,
      allowProps: { File: [] },
      allowEdgeProps: {},
      allowFields: ['id', 'kind', 'name', 'path'],
    },
  ),
  accepted(
    'allowEdgeProps needs props in allowFields',
    'an empty prop list for an edge kind, props not selected',
    {
      ...VALID,
      allowProps: {},
      allowEdgeProps: { IMPORTS: [] },
      allowFields: ['id', 'kind', 'name', 'path'],
    },
  ),

  // includeUntrusted
  accepted('includeUntrusted is written down', 'true, with untrusted selected', {
    ...VALID,
    includeUntrusted: true,
    allowFields: [...(VALID['allowFields'] as string[]), 'untrusted'],
  }),
  rejected(
    'includeUntrusted true needs untrusted in allowFields',
    'untrusted text would be written without its marker',
    { ...VALID, includeUntrusted: true },
    /`includeUntrusted` is true but `allowFields` does not name `untrusted`.*add `untrusted` to `allowFields` or set `includeUntrusted` to false \(see https:\/\/github\.com\/zylver-solutions\/seamline\/blob\/main\/docs\/design\/export-profile\.md\)/,
    'parser-only',
  ),
  accepted(
    'includeUntrusted false does not need untrusted in allowFields',
    'false, untrusted not selected',
    {
      ...VALID,
      includeUntrusted: false,
      allowFields: ['id'],
      allowProps: {},
      allowEdgeProps: {},
    },
  ),
  rejected(
    'includeUntrusted is required',
    'no includeUntrusted',
    without('includeUntrusted'),
    /needs a boolean `includeUntrusted`/,
  ),
  rejected(
    'includeUntrusted is a boolean',
    'the string "false"',
    { ...VALID, includeUntrusted: 'false' },
    /needs a boolean `includeUntrusted`/,
  ),

  // packets
  accepted('packets is optional and names known packet kinds', 'the alignment packet', {
    ...VALID,
    packets: ['alignment'],
  }),
  accepted('packets is optional and names known packet kinds', 'an empty list, which allows none', {
    ...VALID,
    packets: [],
  }),
  rejected(
    'packets is optional and names known packet kinds',
    'an unknown packet kind',
    { ...VALID, packets: ['telemetry'] },
    /`packets\[0\]` names unknown packet kind "telemetry"/,
  ),
  rejected(
    'packets is optional and names known packet kinds',
    'a packet kind listed twice',
    { ...VALID, packets: ['alignment', 'alignment'] },
    /`packets\[1\]` lists packet kind "alignment" more than once/,
  ),
  rejected(
    'packets is optional and names known packet kinds',
    'a string instead of a list',
    { ...VALID, packets: 'alignment' },
    /needs an `packets` array/,
  ),
];
