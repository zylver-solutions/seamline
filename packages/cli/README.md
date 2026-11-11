# @seamline/cli

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The Seamline command-line interface: `init`, `extract`, `why`, `check`, `export`, `diff`, `blast-radius`, `mcp`, `align` and `conformance`. This is the primary way most users and agents run Seamline.

## Install

```bash
npm install -g @seamline/cli     # or: pnpm add -g @seamline/cli
seamline --version
```

Requires Node.js 22.13 or later. The installed shell command is `seamline`. The package depends on the other eleven `@seamline/*` packages, so this one install brings the extractors, the detectors and the MCP server with it. Without a global install, run `npm install @seamline/cli` in a project and use `npx seamline`, or run it once with `npx --package @seamline/cli seamline --version`. There is no unscoped `seamline` package on npm, so a bare `npx seamline` works only where this package is already installed.

Every command prints an `ExperimentalWarning: SQLite is an experimental feature` line on stderr, because the graph store uses Node's built-in `node:sqlite`. It does not mean anything failed.

## Usage

```bash
cd your-repo
seamline init                    # writes seamline.config.json, adds seamline-out/ to .gitignore
seamline extract                 # runs the extractors, writes the graph store to seamline-out/
seamline check                   # reports contradictions; UNKNOWN detectors are listed, never read as clean
seamline why <column-or-field>   # the lineage chain of a column, field or schema property
```

The [repository README](https://github.com/zylver-solutions/seamline#the-ten-minute-path) walks through these on the bundled example app, with real output.

## Commands

| Command                | What it does                                                                                                   | Options of its own                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `init`                 | Scaffolds `seamline.config.json` and adds `seamline-out/` to `.gitignore`. Keeps an existing config.           | `--force`                                                                                             |
| `extract`              | Runs the configured extractors, merges, and writes the store. One status line per extractor.                   | `--only <name>` (repeatable)                                                                          |
| `why <target>`         | Prints the field-lineage chain for a column, field or schema property, with provenance and confidence per hop. | `--depth <n>`, `--limit <n>`, `--kind <k>`                                                            |
| `check`                | Reports contradictions. Exits 1 on a critical or high finding.                                                 | `--severity <level>`, `--code <code>` (repeatable)                                                    |
| `export --profile <p>` | Writes the part of the graph a named allow-list profile releases, as JSON. Refuses without a profile.          | `--out <file>`, `--list-profiles`                                                                     |
| `diff <a> <b>`         | Compares two runs (run ids, or paths to snapshot files under `<store>/runs/`).                                 |                                                                                                       |
| `blast-radius`         | What a change can reach: from the files changed in the working tree, or from `--ids`.                          | `--ids <id>,<id>`, `--depth <n>`, `--limit <n>`                                                       |
| `mcp --profile <p>`    | Serves the store to an AI agent over MCP on stdio, inside a named profile. Refuses without a profile.          | `--audit`                                                                                             |
| `align`                | Compares what the tracked Markdown claims with the code and manifests. Never fails a build.                    | `--at <rev>`, `--worktree`, `--facts <file>`, `--baseline <file>`, `--profile <p>`, `--packet <file>` |
| `conformance <module>` | Runs the extractor conformance suite on an extractor module you wrote.                                         | `--seed <dir>`, `--options <file>`, `--stress-mb <n>`                                                 |

Global options: `--json` (machine-readable output on stdout, on every command except `mcp`, which speaks the MCP protocol there), `--no-color`, `--repo <path>` (default: the current directory), `--store <dir>` (see [Selecting the store](#selecting-the-store)), `-h`/`--help`, `-v`/`--version`. `seamline <command> --help` prints the full text for one command.

| Exit code | Meaning                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------- |
| 0         | Success, or contradictions of severity medium or low only. `align` exits 0 whenever it produced a report. |
| 1         | `check` found a critical or high contradiction. `conformance`: at least one property FAIL.                |
| 2         | Usage error.                                                                                              |
| 3         | Runtime error. `conformance`: no FAIL, but at least one property UNAVAILABLE.                             |

UNKNOWN is never reported as clean and never changes the exit code on its own.

Notes on four of the commands:

- `seamline mcp --profile <name>` is the ready-made MCP server: it serves the store `seamline extract` wrote, with every tool evaluated inside the named export profile. It prints nothing on start, waits for MCP messages on stdin and exits when stdin closes. If you are embedding the server in your own program instead, see [`@seamline/mcp`](https://github.com/zylver-solutions/seamline/blob/main/packages/mcp/README.md).
- `seamline align` is the alignment report (ADR-0014): it classifies each comparison that finds something as Observed drift, Unexplained gap, Planned gap, Unknown or Resolved, and counts the aligned subjects. It needs a git repository. Drift never gates, and `check` is unchanged. Without `--profile` it prints a summary; the finding packet leaves only through an export profile that names `"packets": ["alignment"]`, and no shipped or scaffolded profile does, so you declare one (the [repository README](https://github.com/zylver-solutions/seamline#documents-against-code-seamline-align) shows it). Three of its four probes need the optional `typescript` package (`typescript@^6.0.3`; TypeScript 7 makes `align` fail in 0.1.0), which this package does not install.
- `seamline conformance <path-to-extractor-module>` is for people who write extractors: it runs the module in the sandbox against generated fixtures and prints a PASS, FAIL or UNAVAILABLE line per property ([`docs/conformance.md`](https://github.com/zylver-solutions/seamline/blob/main/docs/conformance.md)). The package also exports `conformanceOfModule`, `runConformance`, `loadExtractorProgram` and the report types for the same suite from code.
- `seamline diff` of two plain runs over an unchanged tree lists the `DataSource` and `Migration` nodes as changed in 0.1.0, because a `replayEpoch` property holds the run id. Runs made with `SEAMLINE_DETERMINISTIC=1` over the same tree are byte-identical.

When a sandbox child exceeds its wall-clock budget, host stderr includes a bounded `sandbox-timeout-observation` line: the last reported child phase, whether stdin finished, response byte count, and Linux process state, CPU ticks and resident bytes when available. Phase markers travel over a separate advisory pipe and a custom extractor can spoof them. Unavailable observations read `unknown` or `unobserved`. The line contains no raw child stderr and does not enter the graph, canonical run snapshot or extractor result. The timeout still fails closed under the existing budget.

## Configuration

`seamline init` writes `seamline.config.json` in the repository root. Its keys and scaffolded values:

| Key                  | Scaffolded value                                                       | Meaning                                                |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `version`            | `1`                                                                    | The config format version.                             |
| `repo`               | the directory name                                                     | The logical repository name every node id starts with. |
| `outDir`             | `"seamline-out"`                                                       | Where the store is written and read.                   |
| `include`, `exclude` | `["**/*"]`; `node_modules/**`, `dist/**`, `.git/**`, `seamline-out/**` | Which files the extractors may read.                   |
| `extractors`         | the five extractors, each `{ "name", "enabled": true, "options": {} }` | Which extractors run, and their options.               |
| `limits`             | `{ "maxDepth": 6, "maxResults": 500 }`                                 | Defaults for `--depth` and `--limit`.                  |
| `exportProfiles`     | the starter profile `structure`                                        | Profiles you declare, keyed by name (next section).    |

Extractor `options` the CLI reads: `extract-code-ts`: `tsConfigFilePath`. `extract-data`: `dataSource`, `defaultSchema`, `dialect`, `skipDirs`, `maxFileBytes`. `extract-contracts`: `files`. `extract-change`: `depth`, `since`, `until`, `renameThreshold`, `detectCopies`, `gitBin`, `maxBufferBytes`. `infer-join`: `weights`, `thresholds`. Each extractor's README says what its options mean.

Setting the environment variable `SEAMLINE_DETERMINISTIC=1` freezes the clock and derives the run id from the run's inputs (`run-det-<digest>`), so two extractions of the same tree write the same bytes.

## Export profiles

`seamline export --profile <name>` and `seamline mcp --profile <name>` take the same names and read the same format. A name is either a shipped profile or one declared under `exportProfiles` in `seamline.config.json`, keyed by name. `seamline export --list-profiles` prints every available profile in full.

| Profile                            | Releases                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public` (shipped)                 | System shape only: `Repo`, `Module`, `Contract` and `Operation` nodes, `CONTAINS` edges, and an operation's `method`. No paths, no data model.                                                |
| `team` (shipped)                   | Engineering-internal: code, contracts, change history and the data model (columns with a short list of props). Excludes the restricted tier, so `Owner` and `ThreatModel` nodes never appear. |
| `audit` (shipped)                  | The full graph, restricted tier included. For an internal auditor only; never a shareable artifact.                                                                                           |
| `structure` (scaffolded by `init`) | `Repo`, `Module` and `File` nodes with their paths, and `CONTAINS` and `IMPORTS` edges, extracted facts only. Internal-level: it reveals the file layout.                                     |

In a file, a released node or edge carries only the fields `allowFields` names, and the run ids (`firstSeenRun`, `lastSeenRun`) and `deletedAt` only when it names them. Over MCP, `allowFields` governs the location and lifecycle fields only (see [`@seamline/mcp`](https://github.com/zylver-solutions/seamline/blob/main/packages/mcp/README.md)). This is the starter profile `seamline init` scaffolds; narrow it before using it for anything shared:

```json
{
  "version": 1,
  "exportProfiles": {
    "structure": {
      "version": 1,
      "description": "Internal-level structure: repo, modules and files with their paths, and the import graph, extracted facts only. This reveals the file layout and dependencies of the repository; it is not a public artifact. Narrow or widen deliberately.",
      "allow": [
        ["File", "internal"],
        ["Module", "internal"],
        ["Repo", "internal"]
      ],
      "allowEdges": ["CONTAINS", "IMPORTS"],
      "allowProps": {},
      "allowEdgeProps": {},
      "allowFields": ["id", "kind", "name", "path", "src", "dst"],
      "allowProvenance": ["EXTRACTED"],
      "includeUntrusted": false
    }
  }
}
```

There is no default profile: without `--profile` both commands refuse. A profile without `version`, with a field the format does not have, or with a value outside the closed vocabulary is refused when the config loads, naming the field. The format is specified in [`docs/design/export-profile.md`](https://github.com/zylver-solutions/seamline/blob/main/docs/design/export-profile.md) and described by [`docs/reference/export-profile.schema.json`](https://github.com/zylver-solutions/seamline/blob/main/docs/reference/export-profile.schema.json).

## Selecting the store

`seamline extract` writes the graph store (`graph.db`, plus `runs/` snapshots) into the config's `outDir`, `seamline-out/` by default, and the commands that read a store read it from there. To use a store somewhere else, pass `--store <dir>`; the same spelling works on every command that touches a store:

```bash
seamline extract --store ci/graph                       # write the store there
seamline check   --store ci/graph                       # read it
seamline export  --store ci/graph --profile team --out slice.json
```

| Command                                       | `--store <dir>`                                | `--out`                                                   |
| --------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| `extract`                                     | the directory written                          | the same thing, another spelling                          |
| `why`, `check`, `diff`, `blast-radius`, `mcp` | the directory read                             | the same thing, another spelling                          |
| `align`                                       | the directory read when `--facts` is not given | not documented in its help; use `--store`                 |
| `export`                                      | the directory read                             | the destination **file** only; it never selects the store |
| `init`, `conformance`                         | not accepted                                   | not used                                                  |

- With no `--store` (and no `--out` where it names the store) a command uses the config's `outDir`, exactly as before. Nothing about `--out` changed.
- A relative `--store` resolves against the repository root (`--repo`, default the current directory), the same base `--out` and `outDir` use, so `extract --out storeA` and `export --store storeA` name one directory.
- Where `--out` also names the store, giving both `--store` and `--out` is accepted only if they resolve to the same directory. If they differ the command exits 2 and opens nothing: one of two explicit instructions would otherwise lose silently, and reading the wrong store looks exactly like reading the right one.
- A `--store` that does not exist, or a directory with no `graph.db` in it, exits 2 with `no graph store found at ...`. It is never reported as an empty or clean result. `diff` looks up run ids under `<store>/runs/`.

## Use from code

`runCli(deps, argv)` is total (it returns an exit code and never exits the process), so the whole command surface is testable in-process and embeddable in another Node program. `bin.ts` (published as the `seamline` binary) is the normal way to run it as a process; `buildCliDeps` supplies the real store, extractors, detector runner and snapshot ports it needs.

```js
import { runCli, buildCliDeps, bufferIo } from '@seamline/cli';

const io = bufferIo({ cwd: '/path/to/repo' });
const exitCode = await runCli(buildCliDeps(io), ['check', '--json']);
console.log(exitCode, JSON.parse(io.stdout()));
```

Main exports:

- `runCli`, `VERSION`: the total command runner and package version.
- `buildCliDeps`: the production wiring of `CliDeps`.
- `bufferIo`, `CliError`, `EXIT_FINDINGS`, `EXIT_OK`, `EXIT_RUNTIME`, `EXIT_USAGE`, `processIo`, `systemClock`: I/O abstractions and the exit-code contract.
- `COMMANDS`, `HELP_TEXT`, `COMMAND_HELP`, `findCommand`, `parseCommandArgs`, `isCommand`, `VALUE_OPTIONS` and the `Command`, `GlobalOptions`, `ParsedInvocation` types: argument parsing and help text.
- `colourEnabled`, `makeStyle`, `stripAnsi`, `styleFor`, `Style`: terminal styling.
- Config loading and defaults (`CONFIG_FILENAME`, `CONFIG_VERSION`, `DEFAULT_OUT_DIR`, `STARTER_PROFILE`, `defaultConfig`, `loadConfig`, `parseConfig`, and related exports).

**Stability tier: Agent and operator surface.** Commands, flags, and exit codes are semver-governed: removing or renaming one, or changing what an exit code means, is a breaking change requiring a major bump and a deprecation window. Adding a command, flag, or output field is not breaking.

See the [repository README](https://github.com/zylver-solutions/seamline#readme) for what works today and what does not. License: Apache-2.0 ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)).
