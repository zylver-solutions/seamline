/**
 * `seamline init` — scaffold configuration in a repository.
 *
 * The load-bearing part of this command is the `.gitignore` write. v3 §2.5:
 * what Seamline builds is, in one queryable file, the complete attack map of
 * an organization. v2 instructed users to commit it. `init` is where that
 * mistake is prevented, so the ignore entry is written even when the config
 * file already exists and `--force` was not passed.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCommandArgs } from '../args.ts';
import { styleFor } from '../colour.ts';
import {
  CONFIG_FILENAME,
  configPath,
  defaultConfig,
  serializeConfig,
  STARTER_PROFILE_NAME,
} from '../config.ts';
import { ensureGitignore, IGNORE_ENTRY } from '../gitignore.ts';
import { CliError, EXIT_OK, EXIT_RUNTIME } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { emitJson, emitText } from '../render.ts';

export interface InitReport {
  readonly repoRoot: string;
  readonly config: { readonly path: string; readonly action: 'created' | 'overwritten' | 'kept' };
  readonly gitignore: { readonly path: string; readonly action: string; readonly entry: string };
}

export async function initCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, { force: { type: 'boolean', default: false } });
  const style = styleFor(deps.io, { noColorFlag: parsed.globals.noColor, json: parsed.globals.json });
  const force = parsed.values['force'] === true;

  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  try {
    await access(repoRoot);
  } catch {
    throw new CliError(`repository root does not exist: ${repoRoot}`, EXIT_RUNTIME);
  }

  const cfgPath = configPath(repoRoot);
  let configAction: 'created' | 'overwritten' | 'kept';
  const exists = await fileExists(cfgPath);
  if (exists && !force) {
    configAction = 'kept';
  } else {
    const cfg = defaultConfig(path.basename(repoRoot));
    await writeFile(cfgPath, serializeConfig(cfg), 'utf8');
    configAction = exists ? 'overwritten' : 'created';
  }

  // Always, regardless of whether the config was rewritten.
  const gitignore = await ensureGitignore(path.join(repoRoot, '.gitignore'), IGNORE_ENTRY);

  const outDir = path.join(repoRoot, defaultConfig(path.basename(repoRoot)).outDir);
  await mkdir(outDir, { recursive: true });

  const report: InitReport = {
    repoRoot,
    config: { path: cfgPath, action: configAction },
    gitignore: { path: gitignore.path, action: gitignore.action, entry: gitignore.entry },
  };

  if (parsed.globals.json) {
    emitJson(deps.io, report);
    return EXIT_OK;
  }

  const rel = (p: string): string => path.relative(repoRoot, p) || p;
  const lines: string[] = [];
  lines.push(
    configAction === 'kept'
      ? `${style.dim('kept')}       ${rel(cfgPath)} ${style.dim('(pass --force to overwrite)')}`
      : `${style.green(configAction)}    ${rel(cfgPath)}`,
  );
  lines.push(
    gitignore.action === 'already-present'
      ? `${style.dim('ignored')}    ${rel(gitignore.path)} already ignores ${IGNORE_ENTRY}`
      : `${style.green(gitignore.action === 'created' ? 'created' : 'updated')}    ${rel(gitignore.path)} now ignores ${IGNORE_ENTRY}`,
  );
  if (configAction !== 'kept') {
    lines.push('');
    lines.push(
      `The starter export profile \`${STARTER_PROFILE_NAME}\` releases internal-level structure: file paths, the module tree and the import graph.\nIt is a template to narrow or widen on purpose, not something to publish.`,
    );
  }
  lines.push('');
  lines.push(
    style.dim(
      'The graph is a concentrated map of this repository\'s attack surface.\nIt is not committed by default, and export is default-deny: see\n`seamline export --list-profiles`.',
    ),
  );
  lines.push('');
  lines.push(`Next: ${style.cyan('seamline extract')}, then ${style.cyan('seamline why <column-or-field>')}.`);
  emitText(deps.io, style, `${lines.join('\n')}\n`);
  return EXIT_OK;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export const INIT_CONFIG_FILENAME = CONFIG_FILENAME;
