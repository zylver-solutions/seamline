/**
 * `pnpm eval label-sheet <repo>`: what a blind reviewer works from.
 *
 * For every finding of one repository the sheet prints the finding id, the
 * detector code, and the two subjects the detector compared, each with the
 * `path:line` where the extractor saw it. It deliberately prints nothing else:
 * not the claim text, not the confidence, not the severity, not the facts. A
 * reviewer who reads Seamline's own explanation tends to agree with it, so the
 * judgement is made from the source at the pinned commit, and the label is
 * recorded with `"blind": true`.
 *
 * The findings come from the baseline a previous `pnpm eval` run stored for
 * the repository, and the locations from the graph snapshot of that run. The
 * sheet refuses a baseline made for a different commit than the pin. For a
 * sealed repository it also refuses one that was not made by the sources and
 * the build being measured now: a baseline left from before the freeze, or from
 * tuned code, must not be shown as the sealed findings.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { baselineMismatch, sealedProblem, type Measured } from './analyse.ts';
import { ConfigError } from './errors.ts';
import { compareFindings } from './findings.ts';
import type { FreezeState } from './freeze.ts';
import { readSifNodes } from './sif.ts';
import type { CorpusEntry, Finding, PipelineResult } from './types.ts';

/** Where an extractor saw a node: a `path:line` reference, or nothing recorded. */
export type Locations = ReadonlyMap<string, string>;

interface StoredBaseline {
  readonly sha?: unknown;
  readonly codeId?: unknown;
  readonly cli?: unknown;
  readonly pipeline?: Partial<PipelineResult>;
}

/**
 * Reads the findings a previous run stored for `entry`, refusing a baseline for another commit.
 * With `current`, it also refuses a baseline that `current` did not make.
 */
export async function readStoredFindings(
  repoOutDir: string,
  entry: CorpusEntry,
  current?: Measured,
): Promise<readonly Finding[]> {
  let stored: StoredBaseline;
  try {
    stored = JSON.parse(
      await readFile(path.join(repoOutDir, 'baseline.json'), 'utf8'),
    ) as StoredBaseline;
  } catch {
    throw new ConfigError(
      `no stored baseline for ${entry.name} in ${repoOutDir}. Run \`pnpm eval --repo ${entry.name} --allow-unlabelled\` first.`,
    );
  }
  if (stored.sha !== entry.sha) {
    throw new ConfigError(
      `the stored baseline for ${entry.name} is for commit ${String(stored.sha)}, not the pinned ${entry.sha}. ` +
        'Run the evaluation again.',
    );
  }
  if (current !== undefined) {
    const mismatch = baselineMismatch(stored, current);
    if (mismatch !== null) {
      throw new ConfigError(
        `the stored baseline for ${entry.name} cannot be used for this sheet: ${mismatch}. ` +
          `Run \`pnpm eval --repo ${entry.name} --allow-unlabelled\` again.`,
      );
    }
  }
  const pipeline = stored.pipeline;
  if (
    pipeline === undefined ||
    pipeline.outcome !== 'complete' ||
    !Array.isArray(pipeline.findings)
  ) {
    throw new ConfigError(
      `the stored baseline for ${entry.name} did not complete (${String(pipeline?.outcome)}), so it has no findings to label.`,
    );
  }
  return (pipeline.findings as readonly Finding[]).slice().sort(compareFindings);
}

/** `path:line` for each wanted node id, from the run snapshot under `storeDir`. */
export async function locateNodes(
  storeDir: string,
  wanted: ReadonlySet<string>,
): Promise<Locations> {
  const runs = path.join(storeDir, 'runs');
  let files: string[];
  try {
    files = (await readdir(runs)).filter((f) => f.endsWith('.sif')).sort();
  } catch {
    return new Map();
  }
  const latest = files[files.length - 1];
  if (latest === undefined) return new Map();
  return readSifNodes(path.join(runs, latest), wanted);
}

/**
 * The sheet text. A pure function of its inputs: findings are listed in the
 * total order used everywhere else, and nothing but id, code, and the two
 * subjects with their locations is printed.
 */
export function renderLabelSheet(
  entry: Pick<CorpusEntry, 'name' | 'sha'>,
  findings: readonly Finding[],
  locations: Locations,
): string {
  const lines: string[] = [
    `# Label sheet: ${entry.name} at ${entry.sha}`,
    `# ${findings.length} finding(s). Judge each from the source at this commit.`,
    '# The detector\'s claim and confidence are withheld. Record labels with "blind": true.',
    '',
  ];
  for (const f of findings.slice().sort(compareFindings)) {
    lines.push(
      `${f.id}  ${f.code}`,
      `  left:  ${f.left}  ${locations.get(f.left) ?? '(no location recorded)'}`,
      `  right: ${f.right}  ${locations.get(f.right) ?? '(no location recorded)'}`,
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The sheet for one repository. A sealed repository's sheet is the one door to
 * its findings, so it opens only once the change set is frozen: before
 * `eval/FREEZE` the sealed partition is not opened (no run output, no labels),
 * and once a detector or extractor has changed since, the partition is burned
 * and its findings no longer describe a frozen product. `current` names the sources
 * and the build being measured; a sealed sheet needs it and shows only a baseline
 * that it made. A dev sheet ignores it.
 */
export async function buildLabelSheet(
  entry: CorpusEntry,
  repoOutDir: string,
  freeze: FreezeState,
  current: Measured | null,
): Promise<string> {
  if (entry.partition === 'sealed' && freeze.state !== 'frozen') {
    throw new ConfigError(
      freeze.state === 'none'
        ? `${entry.name} is in the sealed partition and eval/FREEZE does not exist. The sealed ` +
            'partition is not opened before the detector and extractor change set is frozen; ' +
            'record the freeze commit in eval/FREEZE first.'
        : `${entry.name} is in the sealed partition, which is burned: ${freeze.changed.length} ` +
            'detector or extractor path(s) changed since the freeze. Replace the sealed ' +
            'repositories and record a new freeze before labelling.',
    );
  }
  let measured: Measured | undefined;
  if (entry.partition === 'sealed') {
    if (current === null) {
      throw new ConfigError(
        `${entry.name} is in the sealed partition: its sheet is built only for the sources and the build being measured.`,
      );
    }
    const problem = sealedProblem(current);
    if (problem !== null) throw new ConfigError(problem);
    measured = current;
  }
  const findings = await readStoredFindings(repoOutDir, entry, measured);
  const wanted = new Set(findings.flatMap((f) => [f.left, f.right]));
  const locations = await locateNodes(path.join(repoOutDir, 'store'), wanted);
  return renderLabelSheet(entry, findings, locations);
}
