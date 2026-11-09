/**
 * The Markdown scanner (design 3.2): a hand-written, line-oriented, linear-time
 * reader. No Markdown library, no dependency.
 *
 * It recognises exactly these units: front matter, ATX headings, GFM pipe
 * tables (each row its own unit), list items (each its own unit, with a lead
 * label), paragraphs, and code spans. Fenced and indented code, HTML blocks
 * and HTML comments are skipped entirely: an example is not a claim. Anything
 * else is a paragraph. A document written in a way no template matches yields
 * no claim. Silence is the failure mode; a guess never is.
 *
 * Preparation `P` (3.2) turns a unit's text into lower-case sentences for the
 * closed templates of `claims.ts`.
 */

/** The placeholder a code span becomes in a sentence (U+00A4). */
export const CODE_PLACEHOLDER = '¤';

export interface ScanTable {
  readonly headingPath: readonly string[];
  readonly header: readonly string[];
  readonly rows: readonly TableRow[];
  readonly lineStart: number;
}

export interface TableRow {
  readonly cells: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  /** The row's source line, for code spans anywhere in the row. */
  readonly raw: string;
}

export interface Unit {
  readonly type: 'paragraph' | 'list-item' | 'table-row';
  /** Paragraph and list-item text with continuation lines joined; for a table row, the cells joined by ` | `. */
  readonly text: string;
  /** List item only: the inner text of a bold span that begins the item. */
  readonly label: string | null;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly headingPath: readonly string[];
  /** Table row only. */
  readonly table: ScanTable | null;
  readonly row: TableRow | null;
}

export interface ScanResult {
  readonly units: readonly Unit[];
  readonly tables: readonly ScanTable[];
  /** Scalars of a leading front-matter block, recognised and kept out of the prose units. */
  readonly frontMatter: Readonly<Record<string, string>>;
  /** Lines (1-based) longer than the per-line bound; only their first characters were considered. */
  readonly truncatedLines: readonly number[];
}

export interface ScanOptions {
  readonly maxLineLength: number;
}

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-{2,})\s*$/;

/** Split a pipe-table row into trimmed cells. A pipe inside a code span or escaped with `\` is not a delimiter. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '`') inCode = !inCode;
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 1;
      continue;
    }
    if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? '';
  const next = lines[i + 1];
  return (
    line.includes('|') && next !== undefined && next.includes('-') && TABLE_DELIMITER.test(next)
  );
}

function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i] ?? '';
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    LIST_ITEM.test(line) ||
    /^\s*<(!--|\/?[A-Za-z])/.test(line) ||
    isTableStart(lines, i)
  );
}

/** Lead label of a list item: the inner text of a bold span that begins the body. */
function leadLabel(body: string): string | null {
  for (const marker of ['**', '__']) {
    if (!body.startsWith(marker)) continue;
    const end = body.indexOf(marker, marker.length);
    if (end > marker.length) return body.slice(marker.length, end);
  }
  return null;
}

export function scanMarkdown(source: string, options: ScanOptions): ScanResult {
  const truncatedLines: number[] = [];
  const lines = source.split('\n').map((raw, index) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > options.maxLineLength) {
      truncatedLines.push(index + 1);
      return line.slice(0, options.maxLineLength);
    }
    return line;
  });

  const units: Unit[] = [];
  const tables: ScanTable[] = [];
  const headingStack: { level: number; text: string }[] = [];
  const headingPath = (): string[] => headingStack.map((h) => h.text);
  const frontMatter: Record<string, string> = {};

  let i = 0;
  if (lines[0] === '---') {
    let j = 1;
    while (j < lines.length && lines[j] !== '---') j += 1;
    if (j < lines.length) {
      for (let k = 1; k < j; k += 1) {
        const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[k] ?? '');
        if (m !== null) frontMatter[m[1] ?? ''] = (m[2] ?? '').trim();
      }
      i = j + 1;
    }
  }

  let fence: string | null = null;
  let context = 'none' as 'none' | 'list' | 'list-blank' | 'table' | 'paragraph';

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fenceMatch = FENCE.exec(line);
    if (fence !== null) {
      if (fenceMatch !== null) {
        const marker = fenceMatch[1] ?? '';
        if (
          marker[0] === fence[0] &&
          marker.length >= fence.length &&
          line.trim() === marker.trim()
        )
          fence = null;
      }
      i += 1;
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1] ?? null;
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      context = context === 'list' || context === 'list-blank' ? 'list-blank' : 'none';
      i += 1;
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !(lines[i] ?? '').includes('-->')) i += 1;
      i += 1;
      continue;
    }
    if (/^\s*<\/?[A-Za-z]/.test(line)) {
      while (i < lines.length && (lines[i] ?? '').trim() !== '') i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '').length;
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1]?.level ?? 0) >= level
      )
        headingStack.pop();
      headingStack.push({ level, text: heading[2] ?? '' });
      context = 'none';
      i += 1;
      continue;
    }
    if (THEMATIC_BREAK.test(line)) {
      i += 1;
      continue;
    }
    if (/^( {4}|\t)/.test(line) && context !== 'list' && context !== 'list-blank') {
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const rows: TableRow[] = [];
      const table: ScanTable = { headingPath: headingPath(), header, rows, lineStart: i + 1 };
      let j = i + 2;
      while (j < lines.length && (lines[j] ?? '').trim() !== '' && (lines[j] ?? '').includes('|')) {
        const raw = lines[j] ?? '';
        const row: TableRow = { cells: splitRow(raw), lineStart: j + 1, lineEnd: j + 1, raw };
        rows.push(row);
        units.push({
          type: 'table-row',
          text: row.cells.join(' | '),
          label: null,
          lineStart: row.lineStart,
          lineEnd: row.lineEnd,
          headingPath: table.headingPath,
          table,
          row,
        });
        j += 1;
      }
      tables.push(table);
      i = j;
      context = 'table';
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      let body = item[3] ?? '';
      let j = i + 1;
      while (
        j < lines.length &&
        (lines[j] ?? '').trim() !== '' &&
        !LIST_ITEM.test(lines[j] ?? '') &&
        !HEADING.test(lines[j] ?? '') &&
        !FENCE.test(lines[j] ?? '') &&
        !isTableStart(lines, j)
      ) {
        body += ` ${(lines[j] ?? '').trim()}`;
        j += 1;
      }
      units.push({
        type: 'list-item',
        text: body,
        label: leadLabel(body),
        lineStart: i + 1,
        lineEnd: j,
        headingPath: headingPath(),
        table: null,
        row: null,
      });
      i = j;
      context = 'list';
      continue;
    }
    // A paragraph, or a setext heading when its second line is an underline.
    if (SETEXT_UNDERLINE.test(lines[i + 1] ?? '') && !startsBlock(lines, i + 1)) {
      const level = (lines[i + 1] ?? '').trim().startsWith('=') ? 1 : 2;
      while (
        headingStack.length > 0 &&
        (headingStack[headingStack.length - 1]?.level ?? 0) >= level
      )
        headingStack.pop();
      headingStack.push({ level, text: line.trim() });
      i += 2;
      context = 'none';
      continue;
    }
    const start = i;
    const parts: string[] = [];
    let j = i;
    while (
      j < lines.length &&
      (lines[j] ?? '').trim() !== '' &&
      (j === i || !startsBlock(lines, j))
    ) {
      if (j > i && SETEXT_UNDERLINE.test(lines[j] ?? '') && (lines[j] ?? '').trim().startsWith('='))
        break;
      parts.push((lines[j] ?? '').trim());
      j += 1;
    }
    units.push({
      type: 'paragraph',
      text: parts.join(' '),
      label: null,
      lineStart: start + 1,
      lineEnd: j,
      headingPath: headingPath(),
      table: null,
      row: null,
    });
    i = Math.max(j, start + 1);
    context = 'paragraph';
  }
  return { units, tables, frontMatter, truncatedLines };
}

// ---------------------------------------------------------------------------
// Inline helpers (manual scans, so every pass is linear)
// ---------------------------------------------------------------------------

/** Replace each link `[text](url)`, image `![alt](url)` and reference link `[text][ref]` with its text. */
export function replaceLinks(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? '';
    const imageBang = ch === '!' && text[i + 1] === '[';
    if (ch === '[' || imageBang) {
      const open = imageBang ? i + 1 : i;
      const close = text.indexOf(']', open + 1);
      if (close > open) {
        const after = text[close + 1];
        if (after === '(') {
          const end = text.indexOf(')', close + 2);
          if (end > close) {
            out += text.slice(open + 1, close);
            i = end + 1;
            continue;
          }
        } else if (after === '[') {
          const end = text.indexOf(']', close + 2);
          if (end > close) {
            out += text.slice(open + 1, close);
            i = end + 1;
            continue;
          }
        }
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Replace each backticked code span with `replace(content)`. An unmatched run of backticks stays as it is. */
export function replaceCodeSpans(text: string, replace: (content: string) => string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') {
      out += text[i];
      i += 1;
      continue;
    }
    let run = 0;
    while (text[i + run] === '`') run += 1;
    const fence = '`'.repeat(run);
    let search = i + run;
    let close = -1;
    while (search < text.length) {
      const at = text.indexOf(fence, search);
      if (at < 0) break;
      let end = at + run;
      if (text[end] === '`' || text[at - 1] === '`') {
        // A longer run of backticks is not this span's closing fence.
        while (text[end] === '`') end += 1;
        search = end;
        continue;
      }
      close = at;
      break;
    }
    if (close < 0) {
      out += fence;
      i += run;
      continue;
    }
    out += replace(text.slice(i + run, close).trim());
    i = close + run;
  }
  return out;
}

/** Remove emphasis markers: `**`, `__`, `*`, and `_` at a word edge. */
export function stripEmphasis(text: string): string {
  return text.replace(/\*\*|__|\*/g, '').replace(/(^|\s)_+|_+(?=\s|$|[.,;:!?])/g, '$1');
}

/** Collapse whitespace runs to one space and trim. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Remove HTML comments written on one line. */
function stripInlineComments(text: string): string {
  let out = text;
  for (;;) {
    const start = out.indexOf('<!--');
    if (start < 0) return out;
    const end = out.indexOf('-->', start + 4);
    if (end < 0) return out;
    out = `${out.slice(0, start)}${out.slice(end + 3)}`;
  }
}

/** Delete every parenthetical group, innermost first. `null` when parentheses remain unbalanced. */
export function deleteParentheticals(text: string): string | null {
  let current = text;
  for (;;) {
    const next = current.replace(/\([^()]*\)/g, '');
    if (next === current) break;
    current = next;
  }
  return /[()]/.test(current) ? null : current;
}

/**
 * Preparation `P` (3.2): the lower-case sentences of a unit's text, in order.
 * Links become their text, each code span becomes `¤`, emphasis is stripped;
 * the text is split into sentences (before code spans are deleted and before
 * lower-casing, so capital letters still mark sentence starts); then for each
 * sentence parentheticals and `¤` are deleted, trailing `.`, `!` and `?` removed,
 * whitespace collapsed and the text lower-cased.
 */
export function prepareSentences(raw: string): string[] {
  let text = stripInlineComments(raw);
  text = replaceLinks(text);
  text = replaceCodeSpans(text, () => CODE_PLACEHOLDER);
  text = stripEmphasis(text);

  const sentences: string[] = [];
  let current = '';
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k] ?? '';
    if (ch === ';') {
      sentences.push(current);
      current = '';
      continue;
    }
    current += ch;
    if (ch === '.' || ch === '!' || ch === '?') {
      let w = k + 1;
      while (w < text.length && /\s/.test(text[w] ?? '')) w += 1;
      const atEnd = w >= text.length;
      const next = text[w] ?? '';
      if (atEnd || (w > k + 1 && (/[A-Z0-9]/.test(next) || next === CODE_PLACEHOLDER))) {
        sentences.push(current);
        current = '';
        k = w - 1;
      }
    }
  }
  if (current.trim() !== '') sentences.push(current);

  const out: string[] = [];
  for (const sentence of sentences) {
    const without = deleteParentheticals(sentence);
    if (without === null) continue;
    const prepared = collapse(
      without
        .split(CODE_PLACEHOLDER)
        .join('')
        .replace(/[.!?]+\s*$/, ''),
    ).toLowerCase();
    if (prepared !== '') out.push(prepared);
  }
  return out;
}

/** Inline markup removed, code spans kept as their text: the form used for excerpts, labels and cells. */
export function plainText(raw: string): string {
  return collapse(
    stripEmphasis(replaceCodeSpans(replaceLinks(stripInlineComments(raw)), (content) => content)),
  );
}
