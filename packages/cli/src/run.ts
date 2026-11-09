/**
 * Command dispatch.
 *
 * `runCli` is total: it never throws and never calls `process.exit`. It
 * returns an exit code, which is what makes every command testable in-process.
 * Only `bin.ts` touches the process.
 */

import { COMMAND_HELP, findCommand, HELP_TEXT, parseCommandArgs, VALUE_OPTIONS, type Command } from './args.ts';
import { styleFor } from './colour.ts';
import { alignCommand } from './commands/align.ts';
import { blastRadiusCommand } from './commands/blast-radius.ts';
import { checkCommand } from './commands/check.ts';
import { conformanceCommand } from './commands/conformance.ts';
import { diffCommand } from './commands/diff.ts';
import { exportCommand } from './commands/export.ts';
import { extractCommand } from './commands/extract.ts';
import { initCommand } from './commands/init.ts';
import { mcpCommand } from './commands/mcp.ts';
import { whyCommand } from './commands/why.ts';
import { CliError, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from './io.ts';
import type { CliDeps } from './ports.ts';
import { printable, printableLines } from '@seamline/security';
import { VERSION } from './version.ts';

export { VERSION };

const HANDLERS: Readonly<Record<Command, (deps: CliDeps, argv: readonly string[]) => Promise<number>>> = {
  init: initCommand,
  extract: extractCommand,
  why: whyCommand,
  check: checkCommand,
  export: exportCommand,
  diff: diffCommand,
  'blast-radius': blastRadiusCommand,
  mcp: mcpCommand,
  align: alignCommand,
  conformance: conformanceCommand,
};

export async function runCli(deps: CliDeps, argv: readonly string[]): Promise<number> {
  try {
    return await dispatch(deps, argv);
  } catch (e) {
    return reportError(deps, argv, e);
  }
}

async function dispatch(deps: CliDeps, argv: readonly string[]): Promise<number> {
  if (argv.includes('--version') || argv.includes('-v')) {
    deps.io.out(`${VERSION}\n`);
    return EXIT_OK;
  }

  // `findCommand` skips option values, so `seamline --repo /srv/app init`
  // finds `init` rather than treating the path as the command.
  const command = findCommand(argv);
  const bareTokens = firstBarePositional(argv);

  if (command === undefined && bareTokens === undefined) {
    // No command. Help on stdout for `--help`, on stderr otherwise, because a
    // bare `seamline` is a usage error and its output should not be piped into
    // something expecting data.
    if (argv.includes('--help') || argv.includes('-h')) {
      deps.io.out(HELP_TEXT);
      return EXIT_OK;
    }
    deps.io.err(HELP_TEXT);
    return EXIT_USAGE;
  }

  if (command === undefined) {
    deps.io.err(`unknown command \`${printable(bareTokens ?? '')}\`.\n\n${HELP_TEXT}`);
    return EXIT_USAGE;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    deps.io.out(COMMAND_HELP[command]);
    return EXIT_OK;
  }

  // Handlers receive the full argv: `parseCommandArgs` recognises the leading
  // command positional and strips it, so there is one parse and one source of
  // truth for what a positional means.
  return HANDLERS[command](deps, argv);
}

/**
 * The first token that is neither an option nor an option's value. Used only
 * to name the offending token in the "unknown command" message.
 */
function firstBarePositional(argv: readonly string[]): string | undefined {
  let optionsEnded = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-')) {
      if (!token.includes('=') && VALUE_OPTIONS.has(token)) i += 1;
      continue;
    }
    return token;
  }
  return undefined;
}

function reportError(deps: CliDeps, argv: readonly string[], e: unknown): number {
  const json = argv.includes('--json');
  const style = styleFor(deps.io, { noColorFlag: argv.includes('--no-color'), json });

  if (e instanceof CliError) {
    if (json) {
      deps.io.err(`${JSON.stringify({ error: e.message, hint: e.hint ?? null, exitCode: e.code }, null, 2)}\n`);
    } else {
      deps.io.err(`${style.red('error')} ${printable(e.message)}\n`);
      if (e.hint !== undefined) deps.io.err(`${printableLines(e.hint)}\n`);
    }
    return e.code;
  }

  const message = e instanceof Error ? e.message : String(e);
  if (json) {
    deps.io.err(`${JSON.stringify({ error: message, exitCode: EXIT_RUNTIME }, null, 2)}\n`);
  } else {
    deps.io.err(`${style.red('error')} ${printable(message)}\n`);
    if (e instanceof Error && e.stack !== undefined && deps.io.env['SEAMLINE_DEBUG'] === '1') {
      deps.io.err(`${printableLines(e.stack)}\n`);
    } else {
      deps.io.err('Re-run with SEAMLINE_DEBUG=1 for a stack trace.\n');
    }
  }
  return EXIT_RUNTIME;
}

/** Re-exported so callers can parse without dispatching (used by tests). */
export { parseCommandArgs };
