/**
 * The four claim kinds (design section 4): anchors and closed sentence
 * templates that turn Markdown units into claims.
 *
 * The set is closed. A template must match a whole prepared sentence from its
 * first token to its last, with subject, verb and object in fixed positions;
 * a sentence that merely contains the right words yields nothing. The one
 * exception is the pair of `DEFERRED` detector markers (4.3), which test a
 * label or a sentence for a detector code and a dormancy cue wherever they
 * sit in it. Every regular expression below is fixed text with no nested
 * quantifiers, so matching is linear.
 */

import {
  collapse,
  deleteParentheticals,
  plainText,
  prepareSentences,
  replaceCodeSpans,
  replaceLinks,
  scanMarkdown,
} from './scan.ts';
import type { ScanOptions, Unit } from './scan.ts';
import {
  DOCS_EXTRACTOR,
  type Claim,
  type ClaimExtras,
  type ClaimKind,
  type ClaimRecord,
  type Polarity,
} from './types.ts';
import { canonicalJson, sha256Tagged, truncate } from './util.ts';

export const EXCERPT_LIMIT = 240;

export interface ClaimContext {
  /** The evaluated commit, recorded on each claim; `null` with `--worktree`. */
  readonly commit: string | null;
  /** Detector codes (`X1`) of the registry; a code outside it yields no claim (4.3). */
  readonly registryCodes: ReadonlySet<string>;
  /** Does this repo-relative path name a tracked file or a directory holding one? (binding B1) */
  readonly pathExists: (path: string) => boolean;
  /** The npm name of the non-root package a document lives under, or `null` (4.1 subject). */
  readonly packageNameOf: (docPath: string) => string | null;
  readonly scan: ScanOptions;
}

// ---------------------------------------------------------------------------
// Output formats (4.2)
// ---------------------------------------------------------------------------

export const OUTPUT_FORMATS = [
  'text',
  'json',
  'csv',
  'tsv',
  'yaml',
  'xml',
  'html',
  'markdown',
  'mermaid',
  'dot',
  'graphml',
  'sarif',
  'pdf',
] as const;

const MEMBER = `(?:${OUTPUT_FORMATS.join('|')})`;
/** `SEP` is exactly this expression; the spaces are part of the strings. */
const SEP = '(?:, and |, or |, | and | or |/)';
const ENUM = `(${MEMBER}(?:${SEP}${MEMBER})+)`;
const CLI_TAIL = '(?: from the cli| from seamline| of the cli)';

const T1_NAMED = new RegExp(
  `^(?:the )?(?:cli |command line |seamline )(?:output|outputs|output formats?) (?:is|are|include|includes) ${ENUM}${CLI_TAIL}?$`,
);
const T1_BARE = new RegExp(
  `^(?:the )?(?:output|outputs|output formats?) (?:is|are|include|includes) ${ENUM}${CLI_TAIL}$`,
);
const T2 = new RegExp(
  `^(?:the )?(?:cli|seamline|command line)(?: command)? (?:emits|prints|renders|writes|exports|produces|outputs) ${ENUM}(?: output)?$`,
);
const M1 = new RegExp(
  `^${ENUM}(?: output| export| support)? (?:is|are) not (?:implemented|supported|available)$`,
);
const M2 = new RegExp(
  `^${ENUM}(?: output| export| support)? (?:is|are) (?:deferred|planned|not yet (?:implemented|supported))$`,
);
const MEMBER_PEEL = new RegExp(`^(${MEMBER})(?:${SEP}|$)`);

/** Split a matched enumeration into its members, left to right. */
function enumMembers(text: string): string[] {
  const members: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const m = MEMBER_PEEL.exec(rest);
    if (m === null) break;
    members.push(m[1] ?? '');
    rest = rest.slice(m[0].length);
  }
  return members;
}

export interface FormatMatch {
  readonly template: 'T1' | 'T2' | 'M1' | 'M2';
  readonly polarity: Polarity;
  readonly members: readonly string[];
}

/** Test one prepared sentence against the closed format templates. At most one template matches. */
export function matchFormatTemplates(sentence: string): FormatMatch | null {
  let m: RegExpExecArray | null;
  if ((m = T1_NAMED.exec(sentence)) !== null || (m = T1_BARE.exec(sentence)) !== null) {
    return { template: 'T1', polarity: 'AFFIRM', members: enumMembers(m[1] ?? '') };
  }
  if ((m = T2.exec(sentence)) !== null)
    return { template: 'T2', polarity: 'AFFIRM', members: enumMembers(m[1] ?? '') };
  if ((m = M1.exec(sentence)) !== null)
    return { template: 'M1', polarity: 'ABSENT', members: enumMembers(m[1] ?? '') };
  if ((m = M2.exec(sentence)) !== null)
    return { template: 'M2', polarity: 'DEFERRED', members: enumMembers(m[1] ?? '') };
  return null;
}

// ---------------------------------------------------------------------------
// Detector markers (4.3)
// ---------------------------------------------------------------------------

/** The closed dormancy cues, tested wherever they sit in a label or a sentence. */
export const DORMANCY_CUES = [
  'does not fire',
  'do not fire',
  'cannot fire',
  'can not fire',
  'none of them can fire',
  'never fires',
  'dormant',
  'not yet',
  'yet',
] as const;

const CUE = new RegExp(`(?<![a-z])(?:${DORMANCY_CUES.join('|')})(?![a-z])`);
const RANGE_PHRASE = /(?<![a-z0-9_])x\d+(?:\s+(?:to|through)\s+|-)x\d+(?![a-z0-9_])/g;
const DETECTOR_CODE = /(?<![a-z0-9_])x(\d+)(?![a-z0-9_])/g;

/** The detector codes a lower-case label or sentence marks, or `[]` when it carries no cue. */
export function dormancyMarkers(lowerText: string): string[] {
  if (!CUE.test(lowerText)) return [];
  const withoutRanges = lowerText.replace(RANGE_PHRASE, ' ');
  const codes = new Set<string>();
  for (const m of withoutRanges.matchAll(DETECTOR_CODE)) codes.add(`X${m[1] ?? ''}`);
  return [...codes];
}

/** A list item's lead label with code spans kept as text, parentheticals deleted and lower-cased (4.3). */
export function prepareLabel(label: string): string | null {
  const kept = collapse(
    replaceCodeSpans(replaceLinks(label), (content) => content).replace(/\*\*|__|\*/g, ''),
  );
  const without = deleteParentheticals(kept);
  return without === null ? null : collapse(without).toLowerCase();
}

// ---------------------------------------------------------------------------
// Runtime floor (4.1)
// ---------------------------------------------------------------------------

const FLOOR = /^(Node|Node\.js|pnpm)\s*(>=|≥)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

function floorOf(text: string): { runtime: 'node' | 'pnpm'; value: string } | null {
  const m = FLOOR.exec(text);
  if (m === null) return null;
  return {
    runtime: (m[1] ?? '').toLowerCase() === 'pnpm' ? 'pnpm' : 'node',
    value: `${m[3] ?? '0'}.${m[4] ?? '0'}.${m[5] ?? '0'}`,
  };
}

// ---------------------------------------------------------------------------
// Controls (4.4)
// ---------------------------------------------------------------------------

const ENFORCEMENT_CUE = /(?<![A-Za-z0-9_])(?:enforces|enforced|enforce|wired)(?![A-Za-z0-9_])/i;
const CODE_PATH_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

function headingText(path: readonly string[]): string {
  const last = path[path.length - 1] ?? '';
  return plainText(last).replace(/^[\d.\s)\-:]+/, '');
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function buildClaim(
  docPath: string,
  unit: { lineStart: number; lineEnd: number },
  excerpt: string,
  ctx: ClaimContext,
  fields: {
    kind: ClaimKind;
    subject: string;
    member?: string | null;
    polarity: Polarity;
    value?: string | boolean | null;
  },
  extras: ClaimExtras = {},
): ClaimRecord {
  const member = fields.member ?? null;
  const value = fields.value ?? null;
  const claim: Claim = {
    kind: fields.kind,
    subject: fields.subject,
    member,
    polarity: fields.polarity,
    value,
    provenance: 'DECLARED',
    source: {
      path: docPath,
      lineStart: unit.lineStart,
      lineEnd: unit.lineEnd,
      commit: ctx.commit,
      extractor: { name: DOCS_EXTRACTOR.name, version: DOCS_EXTRACTOR.version },
    },
    excerpt: truncate(excerpt, EXCERPT_LIMIT),
    digest: claimDigest({
      kind: fields.kind,
      subject: fields.subject,
      member,
      polarity: fields.polarity,
      value,
    }),
  };
  return { ...claim, extras };
}

/** The digest of a claim's meaning: kind, subject, member, polarity and value, and nothing else (3.3). */
export function claimDigest(meaning: {
  kind: ClaimKind;
  subject: string;
  member: string | null;
  polarity: Polarity;
  value: string | boolean | null;
}): string {
  return sha256Tagged(
    canonicalJson({
      kind: meaning.kind,
      subject: meaning.subject,
      member: meaning.member,
      polarity: meaning.polarity,
      value: meaning.value,
    }),
  );
}

export interface DocumentClaims {
  readonly claims: readonly ClaimRecord[];
  /** Lines longer than the per-line bound, only partly considered. */
  readonly truncatedLines: readonly number[];
}

export function extractClaims(docPath: string, text: string, ctx: ClaimContext): DocumentClaims {
  const scan = scanMarkdown(text, ctx.scan);
  const claims: ClaimRecord[] = [];
  const packageName = ctx.packageNameOf(docPath);
  const floorSubject = (runtime: 'node' | 'pnpm'): string =>
    `runtime:${runtime}${packageName === null ? '' : `@${packageName}`}`;

  // Catalog and controls tables are read by header-independent anchors on the first column.
  const catalogRows = new Set<object>();
  const controlRows = new Set<object>();
  for (const table of scan.tables) {
    if (
      table.rows.length >= 3 &&
      table.rows.every((row) => /^X\d+$/.test(replaceLinks(row.cells[0] ?? '').trim()))
    ) {
      for (const row of table.rows) catalogRows.add(row);
    }
    if (
      table.rows.length > 0 &&
      headingText(table.headingPath).startsWith('Controls') &&
      table.rows.every((row) => /^C\d+$/.test((row.cells[0] ?? '').trim()))
    ) {
      for (const row of table.rows) controlRows.add(row);
    }
  }

  // A list item whose lead label and whose sentence both carry a dormancy marker yields both claims (4.3 names the two
  // forms separately and the counts of 12.1 include both); the two are identical in meaning and in classification.
  for (const unit of scan.units) {
    extractFromUnit(docPath, unit, ctx, floorSubject, catalogRows, controlRows, claims);
  }
  return { claims, truncatedLines: scan.truncatedLines };
}

function extractFromUnit(
  docPath: string,
  unit: Unit,
  ctx: ClaimContext,
  floorSubject: (runtime: 'node' | 'pnpm') => string,
  catalogRows: ReadonlySet<object>,
  controlRows: ReadonlySet<object>,
  out: ClaimRecord[],
): void {
  if (unit.type === 'table-row') {
    const row = unit.row;
    if (row === null) return;
    const excerpt = unit.text === '' ? '' : plainText(row.cells.join(' | '));
    const first = plainText(row.cells[0] ?? '');
    const floor = floorOf(first);
    if (floor !== null) {
      out.push(
        buildClaim(
          docPath,
          unit,
          excerpt,
          ctx,
          {
            kind: 'RUNTIME_FLOOR',
            subject: floorSubject(floor.runtime),
            polarity: 'AFFIRM',
            value: floor.value,
          },
          { runtime: floor.runtime },
        ),
      );
    }
    if (catalogRows.has(row)) {
      const code = replaceLinks(row.cells[0] ?? '').trim();
      if (ctx.registryCodes.has(code)) {
        out.push(
          buildClaim(docPath, unit, excerpt, ctx, {
            kind: 'DETECTOR_LIVENESS',
            subject: `detector:${code}`,
            polarity: 'AFFIRM',
          }),
        );
      }
    }
    if (controlRows.has(row)) {
      const id = (row.cells[0] ?? '').trim();
      const second = row.cells[1] ?? '';
      if (ENFORCEMENT_CUE.test(second)) {
        const bound: string[] = [];
        replaceCodeSpans(row.raw, (content) => {
          if (content.includes('/') || CODE_PATH_EXTENSION.test(content)) {
            const path = content.replace(/\/$/, '');
            if (path !== '' && ctx.pathExists(path) && !bound.includes(path)) bound.push(path);
          }
          return '';
        });
        out.push(
          buildClaim(
            docPath,
            unit,
            excerpt,
            ctx,
            { kind: 'CONTROL_ENFORCEMENT', subject: `control:${id}`, polarity: 'AFFIRM' },
            {
              boundPaths: bound.sort(),
              secondCell: second,
            },
          ),
        );
      }
    }
    return;
  }

  const excerpt = plainText(unit.text);

  if (unit.type === 'list-item' && unit.label !== null) {
    const floor = floorOf(plainText(unit.label));
    if (floor !== null) {
      out.push(
        buildClaim(
          docPath,
          unit,
          excerpt,
          ctx,
          {
            kind: 'RUNTIME_FLOOR',
            subject: floorSubject(floor.runtime),
            polarity: 'AFFIRM',
            value: floor.value,
          },
          { runtime: floor.runtime },
        ),
      );
    }
    const label = prepareLabel(unit.label);
    if (label !== null) {
      for (const code of dormancyMarkers(label)) {
        if (ctx.registryCodes.has(code)) {
          out.push(
            buildClaim(docPath, unit, excerpt, ctx, {
              kind: 'DETECTOR_LIVENESS',
              subject: `detector:${code}`,
              polarity: 'DEFERRED',
            }),
          );
        }
      }
    }
  }

  for (const sentence of prepareSentences(unit.text)) {
    const match = matchFormatTemplates(sentence);
    if (match !== null) {
      for (const member of match.members) {
        out.push(
          buildClaim(docPath, unit, excerpt, ctx, {
            kind: 'OUTPUT_FORMAT_SET',
            subject: `cli:output-format:${member}`,
            member,
            polarity: match.polarity,
          }),
        );
      }
    }
    for (const code of dormancyMarkers(sentence)) {
      if (ctx.registryCodes.has(code)) {
        out.push(
          buildClaim(docPath, unit, excerpt, ctx, {
            kind: 'DETECTOR_LIVENESS',
            subject: `detector:${code}`,
            polarity: 'DEFERRED',
          }),
        );
      }
    }
  }
}
