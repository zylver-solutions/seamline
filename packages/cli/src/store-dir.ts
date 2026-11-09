/**
 * Which store directory a command reads (`extract`: writes).
 *
 * Two flags can name it, and they have to be reconciled in exactly one place
 * so that no command can disagree with another about what a flag means:
 *
 * - `--store <dir>` selects the store directory on every command that has one.
 * - `--out <dir>` always did the same on `extract`, `why`, `check`, `diff`,
 *   `blast-radius` and `mcp`, and still does. On `export` it is the
 *   destination *file* and never selects a store; there the store comes from
 *   `--store`, else the config's `outDir`.
 *
 * Giving both spellings is allowed only when they resolve to the same
 * directory. If they differ, one explicit instruction would have to lose
 * silently, and a read that quietly used the other store is exactly the
 * failure this flag exists to prevent (a clean-looking report about the wrong
 * graph). So it is a usage error (exit 2) and nothing is opened.
 *
 * Relative paths resolve against the repository root (`--repo`), the same base
 * `--out` and the config's `outDir` have always used, so
 * `extract --out storeA` followed by `export --store storeA` names one place.
 */

import path from 'node:path';
import type { Command, ParsedInvocation } from './args.ts';
import type { SeamlineConfig } from './config.ts';
import { usageError } from './io.ts';

/** Commands whose `--out` is not a store directory. */
const OUT_IS_NOT_A_STORE: ReadonlySet<Command> = new Set<Command>(['export']);

export function resolveStoreDir(
  command: Command,
  repoRoot: string,
  config: Pick<SeamlineConfig, 'outDir'>,
  parsed: Pick<ParsedInvocation<Record<string, unknown>>, 'globals' | 'values'>,
): string {
  const store = parsed.values['store'];
  const out = parsed.globals.out;

  if (store === '') {
    throw usageError(
      '--store needs a directory path.',
      "Omit --store to use the config's outDir, or pass the directory that holds graph.db.",
    );
  }

  const fromStore = typeof store === 'string' ? path.resolve(repoRoot, store) : undefined;
  const fromOut =
    out !== undefined && !OUT_IS_NOT_A_STORE.has(command) ? path.resolve(repoRoot, out) : undefined;

  if (fromStore !== undefined && fromOut !== undefined && fromStore !== fromOut) {
    throw usageError(
      `--store and --out both select the store directory for \`seamline ${command}\`, and they differ: ` +
        `${fromStore} (--store) and ${fromOut} (--out).`,
      'For this command --out is another spelling of --store. Pass only one of them.',
    );
  }

  return fromStore ?? fromOut ?? path.resolve(repoRoot, config.outDir);
}
