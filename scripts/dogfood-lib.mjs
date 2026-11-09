/**
 * Pure helpers for scripts/dogfood-gate.mjs.
 *
 * Nothing here touches the filesystem, spawns a process or reads the clock, so
 * every function can be tested against small inline fixtures
 * (scripts/dogfood-gate.test.mjs) instead of a ten-second self-extraction.
 *
 * The gate compares four things against docs/dogfood/baseline/, chosen so that
 * the baseline moves only when what Seamline reports about itself moves, not
 * when someone adds a helper function or renames a test:
 *
 *   why-orders-customer-email.json  the flagship column-to-contract chain
 *   code-ts-coverage.json           tracked TS/JS files no tsconfig project reads
 *   findings.json                   what `seamline check` reports on the repo
 *   examples.sif                    the part of the self-extraction that comes
 *                                   from examples/
 *
 * Seamline's own source symbols are deliberately not part of the baseline.
 */

/** Baseline file names, keyed by the part of the record they hold. */
export const BASELINE_FILES = Object.freeze({
  why: 'why-orders-customer-email.json',
  coverage: 'code-ts-coverage.json',
  findings: 'findings.json',
  examples: 'examples.sif',
});

/** Repo-relative prefix of the bundled example apps. */
export const EXAMPLES_PREFIX = 'examples/';

/**
 * What a run id's value is replaced with before the examples and why surfaces
 * are compared or written.
 *
 * Under SEAMLINE_DETERMINISTIC the run id is a digest of the run's inputs
 * (ADR-0009 section 3a), and the input here is this whole repository, so the id
 * changes with nearly every commit. It is stamped on every node (`firstSeenRun`,
 * `lastSeenRun`) and named in the SIF header (`runId`). Compared byte for byte
 * it would fail the gate on changes with nothing to review. So the value is
 * replaced on both sides, and everything else is still compared byte for byte.
 */
export const RUN_ID_PLACEHOLDER = '<run-id>';

/**
 * A run id: the derived `run-det-` plus 16 hex digits, or the legacy fixed
 * `run-deterministic-0000` that baselines written before ids were derived still
 * carry. Anchored so a longer token (`run-det-` plus 17 hex digits, or the bare
 * prefix `run-det-` in source text) is not one.
 */
const RUN_ID = /(?<![\w-])run-(?:det-[0-9a-f]{16}|deterministic-0000)(?![\w-])/g;

/** The name of a deterministic run's snapshot file, capturing the run id. */
const RUN_FILE = /^(run-det-[0-9a-f]{16})\.sif$/;

/** `text` with every run id's value replaced by `RUN_ID_PLACEHOLDER`. */
export function normalizeRunIds(text) {
  return text.replace(RUN_ID, RUN_ID_PLACEHOLDER);
}

/** The run id a snapshot file name carries, or `null` if it is not a deterministic run's. */
export function runIdOfRunFile(fileName) {
  return RUN_FILE.exec(fileName)?.[1] ?? null;
}

/** Distinct run ids in `text` other than `runId`, sorted. Empty means `text` names only that run. */
export function foreignRunIds(text, runId) {
  return [...new Set(text.match(RUN_ID) ?? [])].filter((id) => id !== runId).sort(cmp);
}

/**
 * The problem to report when a committed baseline names more than one run id, or
 * `null`. The comparison replaces every run id's value, so a baseline that mixes
 * two (a `firstSeenRun` of one run and a `lastSeenRun` of another) would compare
 * equal to a fresh extraction that has one. A baseline is one extraction's output
 * and names one run; a baseline written by `--update` names none (it holds the
 * placeholder), and one written before ids were derived names the legacy id.
 */
export function mixedRunIdProblem(file, baselineText) {
  const ids = [...new Set(baselineText.match(RUN_ID) ?? [])].sort(cmp);
  if (ids.length < 2) return null;
  return {
    file,
    summary: 'the committed baseline names more than one run id',
    details: [
      'a baseline is one extraction and names one run, so these cannot all be the same run:',
      ...ids,
    ],
  };
}

const CODE_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d(\.[^./]+)?\.[cm]?ts$/;
const UNREAD_PREFIX = 'not in any loaded tsconfig project: ';
const TRUNCATION_DIAGNOSTIC = /^\.\.\. \d+ more not listed$/;

/** Entries listed per category in a failure report before "... and N more". */
const MAX_LISTED = 10;
/** Leaf differences shown for one changed item before "(+N more)". */
const MAX_LEAVES = 3;
/** Longest rendered JSON value in a failure report. */
const MAX_VALUE_CHARS = 120;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Code-unit order, the same order the SIF writer uses (never locale-dependent). */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

/** Sorted keys at every depth, two-space indent, trailing newline. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function show(value) {
  const text = value === undefined ? '(absent)' : JSON.stringify(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}...` : text;
}

function truncate(text, max = 160) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Elements only in `a`, and only in `b`, each sorted. */
function diffSets(a, b) {
  const inA = new Set(a);
  const inB = new Set(b);
  return {
    onlyA: [...inA].filter((x) => !inB.has(x)).sort(cmp),
    onlyB: [...inB].filter((x) => !inA.has(x)).sort(cmp),
  };
}

/** Parse JSON-Lines, keeping each raw line. Throws naming the 1-based line. */
function parseJsonLines(text, what) {
  const entries = [];
  const lines = text.split('\n');
  const framed = text.startsWith('seamline-sif/2.0.0\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.startsWith('seamline-sif/')) {
      if (i !== 0 || raw !== 'seamline-sif/2.0.0' || lines.length < 2)
        throw new Error(`${what}: line ${i + 1} has unsupported, duplicate or late SIF framing`);
      continue;
    }
    if (raw.length === 0) continue;
    const parsed = tryParseJson(raw);
    if (!parsed.ok || !isPlainObject(parsed.value)) {
      throw new Error(
        `${what}: line ${i + 1} is not a JSON object (${parsed.ok ? 'wrong shape' : parsed.error})`,
      );
    }
    if (framed && !['run', 'status', 'node', 'edge'].includes(parsed.value.t))
      throw new Error(`${what}: line ${i + 1} is not a version-2 SIF record`);
    entries.push({ raw, entry: parsed.value, line: i + 1 });
  }
  return entries;
}

/** First `MAX_LISTED` of `lines`, then a count of the rest. */
function capped(lines) {
  if (lines.length <= MAX_LISTED) return lines;
  return [...lines.slice(0, MAX_LISTED), `... and ${lines.length - MAX_LISTED} more`];
}

// ---------------------------------------------------------------------------
// Structural diffing
// ---------------------------------------------------------------------------

/** Every leaf path at which `a` and `b` differ. */
function leafDiffs(a, b, path = '') {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(cmp);
    return keys.flatMap((k) => leafDiffs(a[k], b[k], path === '' ? k : `${path}.${k}`));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    return Array.from({ length: n }, (_, i) => leafDiffs(a[i], b[i], `${path}[${i}]`)).flat();
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  return [{ path: path === '' ? '(value)' : path, from: a, to: b }];
}

function describeLeaves(diffs, limit = MAX_LEAVES) {
  const shown = diffs.slice(0, limit).map((d) => `${d.path}: ${show(d.from)} -> ${show(d.to)}`);
  const rest = diffs.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; +${rest} more` : shown.join('; ');
}

/**
 * Diff two lists of records matched by `keyOf`. Items present on one side only
 * are reported as disappeared/appeared; items on both sides that differ are
 * reported with the fields that changed. Duplicate keys are matched in order.
 */
function diffKeyed(noun, baseline, current, keyOf, describe) {
  const index = (list) => {
    const map = new Map();
    const seen = new Map();
    for (const item of list) {
      const base = keyOf(item);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      map.set(n === 1 ? base : `${base}#${n}`, item);
    }
    return map;
  };
  const before = index(baseline);
  const after = index(current);
  const gone = [];
  const changed = [];
  const added = [];
  for (const [key, item] of before) {
    if (!after.has(key)) {
      gone.push(`- ${noun} disappeared: ${describe(item)}`);
      continue;
    }
    const diffs = leafDiffs(item, after.get(key));
    if (diffs.length > 0) {
      changed.push(`~ ${noun} changed: ${describe(item)} (${describeLeaves(diffs)})`);
    }
  }
  for (const [key, item] of after) {
    if (!before.has(key)) added.push(`+ ${noun} appeared: ${describe(item)}`);
  }
  return [...capped(gone), ...capped(changed), ...capped(added)];
}

// ---------------------------------------------------------------------------
// examples.sif: the part of the self-extraction that comes from examples/
// ---------------------------------------------------------------------------

/**
 * Select the examples/ subset of a self-extraction SIF.
 *
 * Nodes: those whose `path` is under `examples/`. A node is placed by its path
 * alone. The redactor never rewrites a repository path (ADR-0013), so every
 * node of the bundled examples carries its real path; a node whose path is
 * absent or elsewhere is not part of the examples, however it is joined.
 *
 * Edges: those whose source and destination nodes are both in the subset.
 *
 * The input is already in canonical order, so the subset is emitted in the
 * order it appears. Nodes and edges stay byte-for-byte as in the source.
 * A v2 run record retains its real metadata with results=[]: this subset has
 * no full-repository extractor authority or counts. A v1 header is kept raw.
 *
 * @returns {{ text: string, nodes: number, edges: number }}
 */
export function selectExamplesSif(sifText) {
  const entries = parseJsonLines(sifText, 'self-extraction SIF');
  const nodes = entries.filter((e) => e.entry.t === 'node');
  const edges = entries.filter((e) => e.entry.t === 'edge');

  const inSubset = new Set();
  for (const { entry } of nodes) {
    const { id, path } = entry.node;
    if (typeof path === 'string' && path.startsWith(EXAMPLES_PREFIX)) inSubset.add(id);
  }

  const header = entries.find((e) => e.entry.t === 'sif' || e.entry.t === 'run');
  const headerLines = header === undefined ? [] : header.entry.t === 'run'
    ? [JSON.stringify(sortKeys({ t: 'run', run: { ...header.entry.run, results: [] } }))]
    : [header.raw];
  const keptNodes = nodes.filter((e) => inSubset.has(e.entry.node.id));
  const keptEdges = edges.filter(
    (e) => inSubset.has(e.entry.edge.src) && inSubset.has(e.entry.edge.dst),
  );
  const lines = [
    ...(sifText.startsWith('seamline-sif/2.0.0\n') ? ['seamline-sif/2.0.0'] : []),
    ...headerLines,
    ...[...keptNodes, ...keptEdges].map((e) => e.raw),
  ];
  return {
    text: lines.length === 0 ? '' : `${lines.join('\n')}\n`,
    nodes: keptNodes.length,
    edges: keptEdges.length,
  };
}

/**
 * Paths of extracted nodes that live inside the baseline directory.
 *
 * The baseline sits inside the repository it describes, and the gate leaves it
 * there while it extracts. That is only sound while no extractor reads it;
 * otherwise regenerating the baseline changes its own input and the gate never
 * settles. Empty means the invariant holds.
 */
export function baselineSelfReferences(sifText, baselineDir) {
  const prefix = baselineDir.endsWith('/') ? baselineDir : `${baselineDir}/`;
  const paths = new Set();
  for (const { entry } of parseJsonLines(sifText, 'self-extraction SIF')) {
    const path = entry.t === 'node' ? entry.node.path : undefined;
    if (typeof path === 'string' && path.startsWith(prefix)) paths.add(path);
  }
  return [...paths].sort(cmp);
}

function identityOf(raw) {
  const parsed = tryParseJson(raw);
  if (!parsed.ok || !isPlainObject(parsed.value)) return truncate(raw);
  const { t, node, edge } = parsed.value;
  if (t === 'node' && isPlainObject(node)) return `node ${node.id}`;
  if (t === 'edge' && isPlainObject(edge)) return `edge ${edge.kind} ${edge.src} -> ${edge.dst}`;
  return `${t ?? 'unknown'} line`;
}

export function compareExamples(rawBaselineText, rawCurrentText) {
  const mixed = mixedRunIdProblem(BASELINE_FILES.examples, rawBaselineText);
  if (mixed !== null) return [mixed];
  const baselineText = normalizeRunIds(rawBaselineText);
  const currentText = normalizeRunIds(rawCurrentText);
  if (baselineText === currentText) return [];
  const split = (text) =>
    text
      .split('\n')
      .map((raw, i) => ({ raw, line: i + 1 }))
      .filter((l) => l.raw.length > 0);
  const before = split(baselineText);
  const after = split(currentText);
  const beforeSet = new Set(before.map((l) => l.raw));
  const afterSet = new Set(after.map((l) => l.raw));
  const removed = before.filter((l) => !afterSet.has(l.raw));
  const added = after.filter((l) => !beforeSet.has(l.raw));

  const addedById = new Map();
  for (const l of added) if (!addedById.has(identityOf(l.raw))) addedById.set(identityOf(l.raw), l);
  const removedById = new Map();
  for (const l of removed) {
    if (!removedById.has(identityOf(l.raw))) removedById.set(identityOf(l.raw), l);
  }

  const gone = [];
  const changed = [];
  const appeared = [];
  for (const [id, l] of removedById) {
    const counterpart = addedById.get(id);
    if (counterpart === undefined) {
      gone.push(`- line ${l.line} removed: ${id}`);
      continue;
    }
    const was = tryParseJson(l.raw);
    const now = tryParseJson(counterpart.raw);
    const diffs =
      was.ok && now.ok
        ? leafDiffs(was.value, now.value)
        : [{ path: '(line)', from: truncate(l.raw, 60), to: truncate(counterpart.raw, 60) }];
    changed.push(`~ line ${counterpart.line} changed: ${id} (${describeLeaves(diffs)})`);
  }
  for (const [id, l] of addedById) {
    if (!removedById.has(id)) appeared.push(`+ line ${l.line} added: ${id}`);
  }

  const details = [
    `${before.length} line(s) in the baseline, ${after.length} in the current extraction`,
    ...capped(gone),
    ...capped(changed),
    ...capped(appeared),
  ];
  if (gone.length + changed.length + appeared.length === 0) {
    const i = before.findIndex((l, k) => after[k]?.raw !== l.raw);
    details.push(
      `same lines in a different order or multiplicity; first difference at line ${
        (before[i] ?? after[i])?.line ?? 1
      }`,
    );
  }
  return [
    {
      file: BASELINE_FILES.examples,
      summary: 'the self-extraction of examples/ no longer matches the reviewed baseline',
      details,
    },
  ];
}

// ---------------------------------------------------------------------------
// code-ts-coverage.json: tracked TS/JS files no tsconfig project reads
// ---------------------------------------------------------------------------

/** A tracked file the coverage measurement considers: TS/JS, not a declaration file. */
export function isTrackedCodeFile(path) {
  return CODE_EXTENSION.test(path) && !DECLARATION_FILE.test(path);
}

/**
 * Which tracked TS/JS files did extract-code-ts not read?
 *
 * The comparison is against `git ls-files` (the published tree), not the
 * extractor's own count, and every unread file must be named in its
 * diagnostics: an unread file it stays silent about is exactly the false
 * "no code here" this record exists to catch. `unreported` lists those.
 *
 * @param {readonly string[]} trackedFiles already filtered with `isTrackedCodeFile`
 * @returns {{ tracked: number, read: number, ratio: number, unread: string[], unreported: string[] }}
 */
export function measureCodeCoverage(trackedFiles, sifText) {
  const tracked = [...new Set(trackedFiles)].sort(cmp);
  const read = new Set();
  let diagnostics = null;
  for (const { entry } of parseJsonLines(sifText, 'self-extraction SIF')) {
    if (entry.t === 'node' && entry.node.kind === 'File' && typeof entry.node.path === 'string') {
      read.add(entry.node.path);
    } else if (entry.t === 'status' && entry.result.extractor === 'extract-code-ts') {
      diagnostics = entry.result.diagnostics;
    }
  }
  if (!Array.isArray(diagnostics)) {
    throw new Error(
      'the extraction has no extract-code-ts status line, so code.ts coverage cannot be measured',
    );
  }
  const unread = tracked.filter((p) => !read.has(p));
  const named = new Set(
    diagnostics
      .filter((d) => d.startsWith(UNREAD_PREFIX))
      .map((d) => d.slice(UNREAD_PREFIX.length)),
  );
  const truncated = diagnostics.some((d) => TRUNCATION_DIAGNOSTIC.test(d));
  return {
    tracked: tracked.length,
    read: tracked.length - unread.length,
    ratio:
      tracked.length === 0
        ? 1
        : Number(((tracked.length - unread.length) / tracked.length).toFixed(4)),
    unread,
    unreported: truncated ? [] : unread.filter((p) => !named.has(p)),
  };
}

/**
 * Compare the committed `unread` list with the current one. Only `unread` is
 * compared: `read`, `tracked` and `ratio` move whenever a normally-read file is
 * added, and that is not a regression.
 */
export function compareCoverage(baselineText, current) {
  const file = BASELINE_FILES.coverage;
  const parsed = tryParseJson(baselineText);
  const unread = parsed.ok && isPlainObject(parsed.value) ? parsed.value.unread : undefined;
  if (!Array.isArray(unread) || !unread.every((p) => typeof p === 'string')) {
    return [
      {
        file,
        summary: 'the committed baseline is malformed',
        details: ['expected a JSON object with an `unread` array of repo-relative paths'],
      },
    ];
  }
  const { onlyA: nowRead, onlyB: nowUnread } = diffSets(unread, current.unread);
  const details = [];
  if (nowUnread.length > 0) {
    details.push(
      `+ ${nowUnread.length} tracked TS/JS file(s) that no loaded tsconfig project reads, and the ` +
        'baseline does not list (invisible to code.ts; add them to a tsconfig project, or record ' +
        'them with a reviewed baseline update if that is intended):',
      ...capped(nowUnread).map((p) => `    ${p}`),
    );
  }
  if (nowRead.length > 0) {
    details.push(
      `- ${nowRead.length} file(s) the baseline lists as unread that are now read (or no longer ` +
        'tracked); record the improvement with a reviewed baseline update:',
      ...capped(nowRead).map((p) => `    ${p}`),
    );
  }
  return details.length === 0
    ? []
    : [{ file, summary: 'the set of unread TS/JS files changed', details }];
}

// ---------------------------------------------------------------------------
// findings.json: what `seamline check` reports about this repository
// ---------------------------------------------------------------------------

/**
 * Interpret the result of `seamline check --json` run on the self-extraction.
 *
 * `check` exits 1 when it finds a critical or high contradiction. That is an
 * expected outcome here, not a failure; only a crash is. A crash is any other
 * exit status, output that is not a check report, or an exit status that
 * disagrees with the report's own `exitCode`.
 *
 * @throws {Error} describing why the run cannot be trusted
 */
export function parseCheckRun(status, stdout) {
  if (status !== 0 && status !== 1) {
    throw new Error(
      `\`seamline check\` exited ${status === null ? 'abnormally' : status}. Exit 1 means ` +
        'contradictions were found and is expected here; any other status is a crash.',
    );
  }
  const parsed = tryParseJson(stdout);
  if (!parsed.ok) {
    throw new Error(`\`seamline check --json\` did not print JSON (${parsed.error})`);
  }
  const report = parsed.value;
  if (!isPlainObject(report) || typeof report.outcome !== 'string') {
    throw new Error('`seamline check --json` printed JSON that is not a check report');
  }
  if (report.exitCode !== status) {
    throw new Error(
      `\`seamline check\` exited ${status} but its report says exitCode ${show(report.exitCode)}`,
    );
  }
  return report;
}

function requireString(obj, key, where) {
  if (typeof obj?.[key] !== 'string') {
    throw new Error(`check report: ${where}.${key} is not a string`);
  }
  return obj[key];
}

function requireStrings(obj, key, where) {
  const value = obj?.[key];
  if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) {
    throw new Error(`check report: ${where}.${key} is not an array of strings`);
  }
  return [...value];
}

function requireList(obj, key) {
  if (!Array.isArray(obj[key])) throw new Error(`check report: ${key} is not an array`);
  return obj[key];
}

/** Each extractor's status and authoritative scope names. No counts, no timings. */
function extractorStatuses(sifText) {
  const out = [];
  for (const { entry } of parseJsonLines(sifText, 'self-extraction SIF')) {
    if (entry.t !== 'status') continue;
    const r = entry.result;
    if (!isPlainObject(r) || typeof r.extractor !== 'string' || typeof r.status !== 'string') {
      throw new Error('self-extraction SIF: a status line has no extractor or status');
    }
    out.push({
      extractor: r.extractor,
      scopes: asArray(r.authoritative)
        .map((a) => a.scope)
        .filter((s) => typeof s === 'string')
        .sort(cmp),
      status: r.status,
    });
  }
  if (out.length === 0) {
    throw new Error(
      'the self-extraction has no extractor status lines, so scope status is unknown',
    );
  }
  return out.sort((a, b) => cmp(a.extractor, b.extractor));
}

/**
 * The canonical, deterministic record of what `seamline check` reports.
 *
 * Kept: each contradiction's code, severity, both subject ids, claim and
 * via-path; every UNKNOWN detector; each non-PASS scope; each extractor's
 * status and scope names; the overall outcome.
 *
 * Dropped, because it moves with unrelated edits or is not a finding: the
 * evidence strings (`leftFact`, `rightFact`, which embed source line numbers),
 * the inference confidence, the severity counts (derivable), the exit code,
 * extractor diagnostics, and every node/edge count and duration.
 */
export function canonicalizeFindings(report, sifText) {
  if (!isPlainObject(report)) throw new Error('check report is not a JSON object');
  const contradictions = requireList(report, 'contradictions')
    .map((c, i) => ({
      claim: requireString(c, 'claim', `contradictions[${i}]`),
      code: requireString(c, 'code', `contradictions[${i}]`),
      left: requireString(c, 'left', `contradictions[${i}]`),
      right: requireString(c, 'right', `contradictions[${i}]`),
      severity: requireString(c, 'severity', `contradictions[${i}]`),
      viaPath: requireStrings(c, 'viaPath', `contradictions[${i}]`),
    }))
    .sort(
      (a, b) =>
        cmp(a.code, b.code) ||
        cmp(a.left, b.left) ||
        cmp(a.right, b.right) ||
        cmp(a.severity, b.severity) ||
        cmp(a.claim, b.claim),
    );
  const unknownDetectors = requireList(report, 'unknownDetectors')
    .map((u, i) => {
      const where = `unknownDetectors[${i}]`;
      const scopeStatus = isPlainObject(u?.scopeStatus) ? u.scopeStatus : {};
      return {
        code: requireString(u, 'code', where),
        reason: requireString(u, 'reason', where),
        scopeStatus: Object.fromEntries(
          Object.keys(scopeStatus)
            .sort(cmp)
            .map((k) => [k, scopeStatus[k]]),
        ),
        scopes: requireStrings(u, 'scopes', where).sort(cmp),
        severity: requireString(u, 'severity', where),
      };
    })
    .sort((a, b) => cmp(a.code, b.code) || cmp(a.reason, b.reason));
  const degradedScopes = requireList(report, 'degradedScopes')
    .map((s, i) => ({
      extractor: requireString(s, 'extractor', `degradedScopes[${i}]`),
      scope: requireString(s, 'scope', `degradedScopes[${i}]`),
      status: requireString(s, 'status', `degradedScopes[${i}]`),
    }))
    .sort((a, b) => cmp(a.scope, b.scope) || cmp(a.extractor, b.extractor));
  return {
    contradictions,
    degradedScopes,
    extractors: extractorStatuses(sifText),
    outcome: requireString(report, 'outcome', 'report'),
    unknownDetectors,
  };
}

export function compareFindings(baselineText, current) {
  const file = BASELINE_FILES.findings;
  const summary = 'what `seamline check` reports about this repository changed';
  const parsed = tryParseJson(baselineText);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return [
      { file, summary: 'the committed baseline is malformed', details: ['expected a JSON object'] },
    ];
  }
  const base = parsed.value;
  if (canonicalJson(base) === canonicalJson(current)) return [];

  const details = [];
  if (base.outcome !== current.outcome) {
    details.push(`~ outcome changed: ${show(base.outcome)} -> ${show(current.outcome)}`);
  }
  details.push(
    ...diffKeyed(
      'contradiction',
      asArray(base.contradictions),
      current.contradictions,
      (c) => `${c.code}|${c.left}|${c.right}`,
      (c) => `[${c.severity}] ${c.code} ${c.left} <-> ${c.right}`,
    ),
    ...diffKeyed(
      'UNKNOWN detector',
      asArray(base.unknownDetectors),
      current.unknownDetectors,
      (u) => u.code,
      (u) => u.code,
    ),
    ...diffKeyed(
      'extractor scope status',
      asArray(base.extractors),
      current.extractors,
      (e) => e.extractor,
      (e) => `${e.extractor} (${asArray(e.scopes).join(', ')})`,
    ),
    ...diffKeyed(
      'degraded scope',
      asArray(base.degradedScopes),
      current.degradedScopes,
      (s) => s.scope,
      (s) => `${s.scope} (${s.extractor})`,
    ),
  );
  if (details.length === 0) {
    details.push('~ the file differs from the current report in a way this summary cannot name');
  }
  return [{ file, summary, details }];
}

// ---------------------------------------------------------------------------
// why-orders-customer-email.json
// ---------------------------------------------------------------------------

export function compareWhy(baselineText, rawCurrentText) {
  const file = BASELINE_FILES.why;
  const parsed = tryParseJson(baselineText);
  if (!parsed.ok) {
    return [
      {
        file,
        summary: 'the committed baseline is malformed',
        details: [`not valid JSON (${parsed.error})`],
      },
    ];
  }
  const baselineCanonical = canonicalJson(parsed.value);
  const mixed = mixedRunIdProblem(file, baselineCanonical);
  if (mixed !== null) return [mixed];
  const baselineNormalized = normalizeRunIds(baselineCanonical);
  const currentNormalized = normalizeRunIds(rawCurrentText);
  if (baselineNormalized === currentNormalized) return [];
  const diffs = leafDiffs(JSON.parse(baselineNormalized), JSON.parse(currentNormalized));
  return [
    {
      file,
      summary: '`seamline why` for the flagship column no longer matches the reviewed baseline',
      details: capped(diffs.map((d) => `~ ${d.path}: ${show(d.from)} -> ${show(d.to)}`)),
    },
  ];
}

// ---------------------------------------------------------------------------
// The whole baseline
// ---------------------------------------------------------------------------

/**
 * The files `--update` writes, as `{ fileName: text }`. The examples and why
 * texts are written with run ids replaced by `RUN_ID_PLACEHOLDER`, so
 * regenerating the baseline does not churn every line.
 *
 * @param {{ why: string, coverage: { unread: string[] }, findings: object, examples: string }} current
 */
export function renderBaselineFiles(current) {
  return {
    [BASELINE_FILES.why]: normalizeRunIds(current.why),
    [BASELINE_FILES.coverage]: canonicalJson({ unread: current.coverage.unread }),
    [BASELINE_FILES.findings]: canonicalJson(current.findings),
    [BASELINE_FILES.examples]: normalizeRunIds(current.examples),
  };
}

/**
 * Compare the committed baseline texts, `{ why, coverage, findings, examples }`,
 * with the current record. Returns one entry per differing file, each with a
 * headline and the lines that explain it. Empty means no regression. A missing
 * baseline text is itself a problem: the gate never passes without a baseline.
 * The examples and why texts are compared modulo the run id's value (see
 * `RUN_ID_PLACEHOLDER`); nothing else is.
 */
export function compareBaselines(baseline, current) {
  const parts = [
    ['why', () => compareWhy(baseline.why, current.why)],
    ['coverage', () => compareCoverage(baseline.coverage, current.coverage)],
    ['findings', () => compareFindings(baseline.findings, current.findings)],
    ['examples', () => compareExamples(baseline.examples, current.examples)],
  ];
  return parts.flatMap(([key, compare]) =>
    typeof baseline[key] === 'string'
      ? compare()
      : [
          {
            file: BASELINE_FILES[key],
            summary: 'no committed baseline',
            details: ['the file is missing, and this gate does not pass without a baseline'],
          },
        ],
  );
}

/** Render `compareBaselines` output for a terminal. `dir` prefixes each file name. */
export function formatProblems(problems, dir) {
  return problems
    .map((p) => [`${dir}/${p.file}: ${p.summary}`, ...p.details.map((d) => `  ${d}`)].join('\n'))
    .join('\n\n');
}
