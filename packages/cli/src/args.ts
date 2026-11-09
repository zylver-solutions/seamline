/**
 * Argument parsing over `node:util.parseArgs`.
 *
 * No CLI framework: v3 §2.7 and §10 make every runtime dependency a
 * supply-chain liability this project has publicly committed to minimizing,
 * and argument parsing is in the standard library.
 */

import { parseArgs, type ParseArgsConfig } from 'node:util';
import { FORMAT_DOC_URL } from '@seamline/core';
import { usageError } from './io.ts';

export const COMMANDS = ['init', 'extract', 'why', 'check', 'export', 'diff', 'blast-radius', 'mcp', 'align', 'conformance'] as const;
export type Command = (typeof COMMANDS)[number];

export function isCommand(v: string): v is Command {
  return (COMMANDS as readonly string[]).includes(v);
}

/** Options every command accepts. */
export interface GlobalOptions {
  readonly json: boolean;
  readonly noColor: boolean;
  readonly help: boolean;
  readonly version: boolean;
  /** Repository root. Relative values resolve against `io.cwd`. */
  readonly repo: string | undefined;
  /**
   * The store directory on every command except `export`, where it is the
   * destination file. Never read directly: `resolveStoreDir` decides what it
   * means for a given command and how it combines with `--store`.
   */
  readonly out: string | undefined;
}

type OptionConfig = NonNullable<ParseArgsConfig['options']>;

export const GLOBAL_OPTION_SPEC: OptionConfig = {
  json: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
  repo: { type: 'string' },
  out: { type: 'string' },
};

/**
 * `--store <dir>`: the store directory a command reads (`extract`: writes).
 *
 * Deliberately not part of {@link GLOBAL_OPTION_SPEC}. `--out` is global and
 * `init` quietly ignores it; a second option that `init` also quietly ignored
 * would be a flag that appears to do something and does not. Each command that
 * touches a store merges this in, and `init` rejects it as unknown. How it
 * combines with `--out` is decided in one place, `resolveStoreDir`.
 */
export const STORE_OPTION_SPEC: OptionConfig = {
  store: { type: 'string' },
};

/**
 * Every option that takes a value, across every command.
 *
 * `findCommand` needs this to avoid mistaking an option's value for the
 * command: in `seamline --repo /srv/app init`, `/srv/app` is a positional as
 * far as a naive scan is concerned. Keep this in sync when adding an option.
 */
export const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--repo',
  '--out',
  '--store',
  '--only',
  '--depth',
  '--limit',
  '--kind',
  '--severity',
  '--code',
  '--profile',
  '--ids',
  '--at',
  '--facts',
  '--baseline',
  '--packet',
  '--seed',
  '--options',
  '--stress-mb',
]);

/**
 * Locates the command in `argv`, skipping option values.
 *
 * `--opt=value` does not consume the next token; `--opt value` does. `--`
 * ends option processing, so anything after it is a positional.
 */
export function findCommand(argv: readonly string[]): Command | undefined {
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
    if (isCommand(token)) return token;
    // The first bare positional that is not a command ends the search: it is
    // either a typo or a `why <target>` with no command, and both are errors
    // the caller should report against this token.
    return undefined;
  }
  return undefined;
}

export interface ParsedInvocation<V> {
  readonly command: Command | undefined;
  readonly globals: GlobalOptions;
  readonly values: V;
  readonly positionals: readonly string[];
}

/**
 * Parses one command's arguments. `extra` is merged over the global spec.
 *
 * `parseArgs` throws a `TypeError` with a machine-ish message on an unknown
 * option; it is translated here into a usage error with an exit code, because
 * an unhandled throw would exit 1 and be indistinguishable from "found
 * contradictions".
 */
export function parseCommandArgs<V extends Record<string, unknown>>(
  argv: readonly string[],
  extra: OptionConfig = {},
): ParsedInvocation<V> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { ...GLOBAL_OPTION_SPEC, ...extra },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw usageError((e as Error).message, 'Run `seamline --help` for the option list.');
  }

  const values = parsed.values as Record<string, unknown>;
  const positionals = parsed.positionals;
  const first = positionals[0];
  const command = first !== undefined && isCommand(first) ? first : undefined;

  return {
    command,
    globals: {
      json: values['json'] === true,
      noColor: values['no-color'] === true,
      help: values['help'] === true,
      version: values['version'] === true,
      repo: typeof values['repo'] === 'string' ? values['repo'] : undefined,
      out: typeof values['out'] === 'string' ? values['out'] : undefined,
    },
    values: values as V,
    positionals: command === undefined ? positionals : positionals.slice(1),
  };
}

export const HELP_TEXT = `seamline — a zero-declaration cross-domain join over your codebase.

USAGE
  seamline <command> [options]

COMMANDS
  init                  Scaffold ${'`seamline.config.json`'} and add seamline-out/ to .gitignore.
  extract               Run the configured extractors, merge, and persist.
  why <target>          Print the field-lineage chain for a column, field, or
                        schema property, with per-hop provenance and confidence.
  check                 Report contradictions. Exits non-zero on critical/high.
  export --profile <p>  Export through a named allow-list profile. No profile,
                        no output — there is no "export everything".
  diff <a> <b>          Compare two runs or two snapshot files.
  blast-radius          Blast radius of the working diff (or --ids): what a
                        change to these node(s) can reach, over dependency
                        and join edges.
  mcp --profile <p>     Serve the graph to an AI agent over MCP (stdio), inside
                        a named export profile. No profile, no server.
  align                 Compare what the documents claim with what the code and
                        manifests show. Reports drift; never fails a build.
  conformance <module>  Run the extractor conformance suite on an extractor
                        module: reads, network, ceiling, budget, UNAVAILABLE.

GLOBAL OPTIONS
  --json                Machine-readable output on stdout. Never coloured.
  --no-color            Disable colour. Colour is also off when stdout is not a
                        TTY, or when NO_COLOR is set to a non-empty value.
  --repo <path>         Repository root. Default: the current directory.
  --out <path>          extract, why, check, diff, blast-radius, mcp: the store
                        directory, same as --store. export: the destination
                        file instead (it never selects the store).
  -h, --help            Show this help.
  -v, --version         Show the version.

STORE OPTION (every command except init)
  --store <dir>         The store directory: where extract writes and every
                        other command reads. Default: the config's outDir.
                        Relative paths resolve against --repo, like --out.
                        With --out, both must name the same directory; a
                        mismatch is a usage error (exit 2). A directory with
                        no store in it is an error, never an empty result.

EXIT CODES
  0  success, or contradictions of severity medium/low only
  1  contradictions of severity critical or high were found
  2  usage error
  3  runtime error
  (align exits 0 whenever it produced a report, whatever the report holds.)

UNKNOWN is never reported as clean and never fails a build on its own.
`;

export const COMMAND_HELP: Readonly<Record<Command, string>> = {
  init: `seamline init — scaffold configuration in a repository.

USAGE
  seamline init [--repo <path>] [--force] [--json]

Writes ${'`seamline.config.json`'} and adds \`seamline-out/\` to \`.gitignore\`.
The graph is a concentrated map of your attack surface: it is never committed
by default. Running init twice is a no-op.

OPTIONS
  --force   Overwrite an existing seamline.config.json.
`,
  extract: `seamline extract — run the configured extractors, merge, and persist.

USAGE
  seamline extract [--repo <path>] [--store <dir>] [--only <name>...] [--json]

Prints one status line per extractor. UNAVAILABLE is shown distinctly from
PASS so a missing scope is visible rather than silently narrowing the graph.

OPTIONS
  --store <dir>   Directory to write the store into. Default: the config's
                  outDir. --out <dir> is another spelling of the same option.
  --only <name>   Run only the named extractor. Repeatable.
`,
  why: `seamline why — print the field-lineage chain for a target.

USAGE
  seamline why <target> [--store <dir>] [--depth <n>] [--limit <n>] [--json]

<target> is a NodeId (\`repo:kind:canonicalName\`), a qualified name
(\`users.email\`), or a bare name (\`email\`). Ambiguous names list candidates.

OPTIONS
  --store <dir> The store to read. Default: the config's outDir.
  --depth <n>   Maximum hops from the target. Default: the config's maxDepth.
  --limit <n>   Maximum nodes to visit. Default: the config's maxResults.
  --kind <k>    Restrict target resolution to one node kind.
`,
  check: `seamline check — report contradictions.

USAGE
  seamline check [--store <dir>] [--severity <level>] [--code <code>...] [--json]

Exits 1 when any contradiction is critical or high. UNKNOWN detectors are
reported in their own section and never fail the build: a detector whose
required scope did not PASS has not found that you are clean.

OPTIONS
  --store <dir>       The store to read. Default: the config's outDir.
  --severity <level>  Minimum severity to display. Default: low.
  --code <code>       Restrict to a contradiction code. Repeatable.
`,
  export: `seamline export — export through a named allow-list profile.

USAGE
  seamline export --profile <name> [--store <dir>] [--out <file>] [--json]

Export is default-deny (v3 §2.5). Without --profile this command refuses.
A profile is an allow-list: the (node kind, sensitivity) pairs, edge kinds,
props, location fields and provenance levels that may leave the store, and
whether untrusted text may. Anything unnamed is dropped. There is one profile
format, the same for \`seamline mcp\` (${FORMAT_DOC_URL}).

OPTIONS
  --profile <name>  Required. A shipped profile (public, team, audit) or one
                    declared under "exportProfiles" in seamline.config.json.
  --store <dir>     The store to read. Default: the config's outDir.
  --out <file>      Write the export to this file instead of stdout. This is
                    a destination only: it never selects the store.
  --list-profiles   List the available profiles and exit.
`,
  diff: `seamline diff — compare two runs.

USAGE
  seamline diff <a> <b> [--store <dir>] [--json]

<a> and <b> are run ids or paths to SIF snapshot files. Output is the added,
removed, and changed nodes and edges between them.

OPTIONS
  --store <dir>  The store whose runs/ directory run ids are looked up in.
                 Default: the config's outDir.
`,
  'blast-radius': `seamline blast-radius — what a change can reach.

USAGE
  seamline blast-radius [--store <dir>] [--ids <id>,<id>,...] [--depth <n>]
                        [--limit <n>] [--json]

With no --ids, roots are the files changed in the working tree (staged,
unstaged, and untracked), matched against the graph's node paths. With
--ids, roots are the given NodeIds directly — the same shape the MCP
\`impact\` tool takes, for parity.

Walks dependency and join edges outward from the roots (both directions),
bounded by depth and result count, and reports what is reachable grouped by
node kind. A changed file that matches no node is reported, not dropped.

OPTIONS
  --store <dir>        The store to read. Default: the config's outDir.
  --ids <id>,<id>,...  Comma-separated NodeIds. Skips the git-diff step.
  --depth <n>          Maximum hops from the roots. Default: the config's maxDepth.
  --limit <n>          Maximum nodes to visit. Default: the config's maxResults.

EXAMPLE
  seamline blast-radius --depth 3
  seamline blast-radius --ids myrepo:Table:public.users,myrepo:Column:public.users.email
`,
  align: `seamline align: compare documents with the implementation.

USAGE
  seamline align [--at <rev> | --worktree] [--facts <file.sif>] [--baseline <packet>]
                 [--profile <name> [--packet <file>]] [--store <dir>] [--json]

Reads the Markdown the repository tracks, takes a closed set of claims out of
it (a runtime floor, the output formats of the CLI, which detectors work, which
controls are enforced), and compares each with a fact from Seamline's own
extraction of the same commit or from a manifest. Each comparison ends in one
class: Observed drift, Unexplained gap, Planned gap, Unknown or Resolved.

It never gates. It exits 0 whenever a report was produced, whatever the report
holds; there is no flag, environment variable or configuration key that makes
drift fail. The only non-zero exits are usage errors (2) and runtime errors (3).
Unknown means the comparison could not be made, and is never read as absence.

Without --profile it prints a summary (class counts, and per finding the id,
class, claim kind, member and reason). The finding packet leaves only through an
export profile that opts in with "packets": ["alignment"]; with --packet <file>
it is written there, otherwise to stdout.

OPTIONS
  --at <rev>         The commit to evaluate. Default: HEAD. Files are read from
                     the git object database at that commit.
  --worktree         Evaluate the working tree instead (records worktree: true).
  --facts <file>     A SIF snapshot made at the evaluated commit. The caller
                     asserts the pairing; the packet says so. Default: the store.
  --baseline <file>  An earlier packet; Resolved records are computed against it.
  --profile <name>   An export profile with "packets": ["alignment"].
  --packet <file>    Write the packet here (requires --profile).
  --store <dir>      The store to read when --facts is not given.
`,
  mcp: `seamline mcp — serve the graph to an AI agent over MCP.

USAGE
  seamline mcp --profile <name> [--repo <path>] [--store <dir>] [--audit]

Speaks the Model Context Protocol on stdin/stdout, over the store
\`seamline extract\` wrote. Every tool is evaluated inside the named export
profile: a node the profile withholds is never returned, never counted, and
never used as a hop. Without --profile this command refuses; there is no
mode that serves the whole store.

OPTIONS
  --profile <name>  Required. A shipped profile (public, team, audit) or one
                    declared under "exportProfiles" in seamline.config.json.
  --store <dir>     The store to serve. Default: the config's outDir.
  --audit           Log one JSON line per tool call to stderr.

Point an MCP client at: seamline mcp --repo /path/to/repo --profile team
`,
  conformance: `seamline conformance: run the extractor conformance suite.

USAGE
  seamline conformance <path-to-extractor-module> [--seed <dir>]
                       [--options <file.json>] [--stress-mb <n>] [--json]

Loads an extractor module (it exports run() and MANIFEST), runs it in the
sandbox against generated fixture repositories, and prints one PASS, FAIL or
UNAVAILABLE line per property with the evidence for it:

  reads-confined        reads only what its declared globs admit
  no-network            no network, DNS, fetch or child-process attempt
  provenance-ceiling    emits nothing above its declared ceiling
  memory-ceiling        stays under its declared memory ceiling
  time-budget           terminates within its declared budget
  unavailable-not-pass  UNAVAILABLE or FAIL, never PASS, on unreadable input

A property the fixtures could not exercise is UNAVAILABLE, never PASS. The
suite is offline and runs no extractor outside the sandbox, but it does run the
module you name, and that sandbox is not a boundary against a hostile
extractor: run it only on code you would run. It does not sign, vouch for, or
enable an extractor; docs/conformance.md says what a PASS does not promise.

OPTIONS
  --seed <dir>       Representative input for the extractor, copied into every
                     fixture. Without it, only generic files are generated.
  --options <file>   A JSON object passed as the extractor's ctx.options.
  --stress-mb <n>    Size of the stress fixture in MiB. Default 8.

EXIT CODES
  0  every property PASS (or NOT_APPLICABLE)
  1  at least one property FAIL
  2  usage error
  3  no FAIL, but at least one property UNAVAILABLE
`,
};
