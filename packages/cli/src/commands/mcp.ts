/**
 * `seamline mcp --profile <name>` — serve the extracted store to an agent over
 * the Model Context Protocol, on stdio.
 *
 * This is the release entry point `@seamline/mcp` leaves to its host: it opens
 * the store `seamline extract` wrote (read-only, through the same `StorePort`
 * every other command uses), and hands the MCP server a `GraphSource` over it
 * together with the export profile every tool is evaluated inside.
 *
 * Default-deny, like `export`. There is no mode that serves the whole store:
 * without `--profile` the command refuses before it opens anything, and an
 * unknown name is an error, never a fallback. A profile is the one format of
 * `@seamline/core`: a shipped one (`public`, `team`, `audit`) or one declared
 * under `exportProfiles` in `seamline.config.json`, the same set `seamline
 * export` accepts (`docs/design/export-profile.md`).
 *
 * stdio only (v3 §2.6): stdout carries protocol frames and nothing else, so
 * the optional `--audit` log goes to stderr, one JSON object per line.
 */

import path from 'node:path';
import { createServer, serveStdio, type AuditEvent, type GraphSource } from '@seamline/mcp';
import { parseCommandArgs, STORE_OPTION_SPEC } from '../args.ts';
import { loadConfig } from '../config.ts';
import { availableProfiles, resolveProfile } from './export.ts';
import { CliError, EXIT_OK, EXIT_USAGE, notWiredError } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { printable } from '@seamline/security';
import { resolveStoreDir } from '../store-dir.ts';
import { VERSION } from '../version.ts';

export async function mcpCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    ...STORE_OPTION_SPEC,
    profile: { type: 'string' },
    audit: { type: 'boolean', default: false },
  });

  const profileName = parsed.values['profile'];
  const repoRoot = path.resolve(deps.io.cwd, parsed.globals.repo ?? '.');
  const config = await loadConfig(repoRoot);
  // The same resolution `seamline export` uses: a shipped profile or one the
  // config declares, parsed by the one parser. Nothing is opened before it.
  if (typeof profileName !== 'string' || profileName.length === 0) {
    throw new CliError(
      'mcp requires --profile. The server is default-deny: there is no mode that serves the whole store.',
      EXIT_USAGE,
      `Every tool is evaluated inside the profile you name. Available profiles: ${availableProfiles(config)}.`,
    );
  }
  const profile = resolveProfile(config, profileName);
  const outDir = resolveStoreDir('mcp', repoRoot, config, parsed);
  if (deps.store === undefined) throw notWiredError('store', 'mcp');
  if (deps.input === undefined) throw notWiredError('stdin', 'mcp');

  const workspace = await deps.store.open({ repoRoot, outDir, repo: config.repo, create: false });
  const detectors = deps.detectors;
  const graph: GraphSource = {
    view: () => Promise.resolve(workspace.store),
    latestRun: () => workspace.runs.latest(),
    close: () => workspace.store.close(),
    ...(detectors === undefined ? {} : {
      detect: async (view) => detectors.run(view, await workspace.runs.latest()),
    }),
  };

  const audit =
    parsed.values['audit'] === true
      ? (e: AuditEvent): void => {
          deps.io.err(`${JSON.stringify(e)}\n`);
        }
      : undefined;

  const server = createServer({
    graph,
    profile,
    serverName: 'seamline',
    serverVersion: VERSION,
    ...(audit === undefined ? {} : { audit }),
    // Internal-error detail can name what the profile withholds, so it goes
    // to stderr (never a protocol channel) and the client gets a generic error.
    log: (line) => {
      deps.io.err(`${printable(line)}\n`);
    },
  });

  // Resolves when the client closes stdin; `serveStdio` closes the server,
  // which closes the store.
  await serveStdio(server, {
    input: deps.input(),
    write: (s) => {
      deps.io.out(s);
    },
    writeErr: (s) => {
      deps.io.err(s);
    },
  });
  return EXIT_OK;
}
