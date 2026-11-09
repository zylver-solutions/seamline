/**
 * `seamline align`: compare what the documents claim with what the code and
 * manifests show (docs/design/alignment.md, ADR-0014).
 *
 * A report family beside the contradiction pipeline, not a stage of it. It
 * **never gates**: it exits 0 whenever it produced a report, whatever the
 * report holds, and there is no flag, environment variable or configuration key
 * that makes drift fail. The only non-zero exits do not depend on what was
 * found: a usage error (2) and a runtime error (3).
 *
 * Export stays default-deny. Without a profile the command prints a summary;
 * the finding packet leaves only through a profile that opts in with
 * `packets: ['alignment']`, and only when that profile's `allow` admits every
 * node kind the packet carries at the level its content has.
 */

import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { AlignError } from '@seamline/align';
import type { NodeKind, Sensitivity } from '@seamline/ontology';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { loadConfig, type ExportProfile } from '../config.ts';
import { CliError, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, notWiredError, usageError } from '../io.ts';
import type { AlignFactsSource, AlignSink, CliDeps, Workspace } from '../ports.ts';
import { terminalText } from '@seamline/security';
import { resolveStoreDir } from '../store-dir.ts';
import { VERSION } from '../version.ts';

/**
 * The graph kinds the alignment packet carries, each at the sensitivity its content has (design
 * 8.1, 8.8). The packet names files by repository-relative path (a proposal's candidate and a
 * finding's source), which is a `File` at `internal`, and it can name symbols (a probe's detail),
 * which is a `Symbol` at `internal`; every other thing in it is text from documents and manifests
 * and is not a graph node. Where it is unclear whether a kind is carried, the stricter reading
 * is taken: the kind is required. A profile releases the packet only if its
 * `allow` lists every pair here, because the format has no single ceiling to compare against.
 */
const PACKET_KINDS_AT_LEVEL: ReadonlyArray<readonly [NodeKind, Sensitivity]> = [
  ['File', 'internal'],
  ['Symbol', 'internal'],
];

export async function alignCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    ...STORE_OPTION_SPEC,
    at: { type: 'string' },
    worktree: { type: 'boolean', default: false },
    facts: { type: 'string' },
    baseline: { type: 'string' },
    profile: { type: 'string' },
    packet: { type: 'string' },
  });
  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);

  const at = parsed.values['at'];
  const worktree = parsed.values['worktree'] === true;
  const factsFile = parsed.values['facts'];
  const baselineFile = parsed.values['baseline'];
  const profileName = parsed.values['profile'];
  const packetFile = parsed.values['packet'];

  // Every refusal comes before anything is read or written: a refused run writes nothing.
  if (at !== undefined && worktree)
    throw usageError('--at and --worktree are alternatives; pass one.');
  if (typeof at === 'string' && at.length === 0) throw usageError('--at needs a revision.');
  if (packetFile !== undefined && profileName === undefined) {
    throw usageError(
      '--packet needs --profile. The finding packet leaves only through an export profile that opts in.',
      'Declare a profile with "packets": ["alignment"] under "exportProfiles" in seamline.config.json.',
    );
  }
  if (typeof packetFile === 'string' && packetFile.length === 0)
    throw usageError('--packet needs a file path.');
  let profile: ExportProfile | undefined;
  if (profileName !== undefined) {
    profile = typeof profileName === 'string' ? config.exportProfiles[profileName] : undefined;
    if (profile === undefined) {
      throw new CliError(
        `no export profile named \`${String(profileName)}\`.`,
        EXIT_USAGE,
        `Declared profiles: ${Object.keys(config.exportProfiles).sort().join(', ') || '(none)'}. Add one to seamline.config.json under "exportProfiles".`,
      );
    }
    if (!(profile.packets ?? []).includes('alignment')) {
      throw usageError(
        `export profile \`${profileName}\` does not allow the alignment packet.`,
        'Add "packets": ["alignment"] to the profile. A profile that does not name a packet allows none.',
      );
    }
    const missing = PACKET_KINDS_AT_LEVEL.filter(
      ([kind, level]) => !profile!.allow.some(([k, l]) => k === kind && l === level),
    );
    if (missing.length > 0) {
      const list = missing.map(([kind, level]) => `(${kind}, ${level})`).join(', ');
      throw usageError(
        `export profile \`${profileName}\` does not admit ${list}, which the alignment packet carries.`,
        `Add ${list} to the profile's "allow", or print the summary without --profile.`,
      );
    }
  }

  if (deps.align === undefined) throw notWiredError('alignment report', 'align');

  let baselineText: string | null = null;
  if (typeof baselineFile === 'string') {
    try {
      baselineText = await readFile(path.resolve(repoRoot, baselineFile), 'utf8');
    } catch {
      throw usageError(
        `cannot read the baseline \`${baselineFile}\`.`,
        'Pass a packet written by `seamline align --profile <name> --packet <file>`.',
      );
    }
  }

  let workspace: Workspace | undefined;
  let facts: AlignFactsSource;
  if (typeof factsFile === 'string') {
    facts = { kind: 'sif', file: path.resolve(repoRoot, factsFile) };
  } else {
    if (deps.store === undefined) throw notWiredError('store', 'align');
    const outDir = resolveStoreDir('align', repoRoot, config, parsed);
    workspace = await deps.store.open({ repoRoot, outDir, repo: config.repo, create: false });
    facts = { kind: 'store', workspace };
  }

  // Stdout carries the human summary unless `--json` or a packet printed there:
  // a summary quotes finding text from the repository, so it is escaped for the
  // terminal; the JSON summary and the packet are machine output and stay as built.
  const humanSummary = !parsed.globals.json && (profile === undefined || typeof packetFile === 'string');
  const sink: AlignSink = {
    stdout: (text) => deps.io.out(humanSummary ? terminalText(text, false) : text),
    file: (file, text) => {
      try {
        writeFileSync(path.resolve(repoRoot, file), text, 'utf8');
      } catch (e) {
        throw new CliError(
          `cannot write the packet to ${file}: ${(e as Error).message}`,
          EXIT_RUNTIME,
        );
      }
    },
  };

  try {
    await deps.align.run(
      {
        repoRoot,
        repo: config.repo,
        at: typeof at === 'string' ? at : null,
        worktree,
        facts,
        baselineText,
        config: config.align ?? {},
        output:
          profile === undefined
            ? { packet: false, json: parsed.globals.json }
            : {
                packet: true,
                file: typeof packetFile === 'string' ? packetFile : null,
                json: parsed.globals.json,
              },
        toolVersion: VERSION,
      },
      sink,
    );
  } catch (e) {
    if (e instanceof AlignError) {
      throw new CliError(e.message, e.kind === 'usage' ? EXIT_USAGE : EXIT_RUNTIME, e.hint);
    }
    throw e;
  } finally {
    if (workspace !== undefined) await workspace.store.close();
  }
  // Drift never changes the exit code.
  return EXIT_OK;
}
