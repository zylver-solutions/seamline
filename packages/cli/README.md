# @seamline/cli
> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The Seamline command-line interface: `init`, `extract`, `why`, `check`, `export`, `diff`, `blast-radius`, `mcp`, `align` and `conformance`. This is the primary way most users and agents run Seamline.

Use this directly if you are running Seamline from a shell or a script. If you are wiring an AI coding agent to query the graph programmatically, use `@seamline/mcp` instead — it exposes the same underlying graph through parameterized tools rather than a process you shell out to.

`seamline mcp --profile <name>` is the ready-made way to do that: it serves the store `seamline extract` wrote over MCP on stdio, with every tool evaluated inside the named export profile.

`seamline align` is the alignment report (ADR-0014): it compares what the tracked documents claim with the implementation facts and classifies each comparison as Observed drift, Unexplained gap, Planned gap, Unknown or Resolved. It exits 0 whenever it produced a report, whatever the report holds; drift never gates, and `check` is unchanged. Without `--profile` it prints a summary; the finding packet leaves only through an export profile that names `"packets": ["alignment"]`. `seamline align --help` lists the options.

`seamline conformance <path-to-extractor-module>` is for people who write extractors: it runs the module in the sandbox against generated fixtures and prints a PASS, FAIL or UNAVAILABLE line per property (`docs/conformance.md` in the repository). The package also exports `conformanceOfModule`, `runConformance`, `loadExtractorProgram` and the report types for the same suite from code.

When a sandbox child exceeds its wall-clock budget, host stderr includes a bounded `sandbox-timeout-observation` line: the last reported child phase, whether stdin finished, response byte count, and Linux process state, CPU ticks and resident bytes when available. Phase markers travel over a separate advisory pipe and a custom extractor can spoof them. Unavailable observations read `unknown` or `unobserved`. The line contains no raw child stderr and does not enter the graph, canonical run snapshot or extractor result. The timeout still fails closed under the existing budget.

`runCli(deps, argv)` is total (returns an exit code, never exits the process), so the whole command surface is testable in-process and embeddable in another Node program. `bin.ts` (published as the `seamline` binary) is the normal way to run it as a process; `wiring.ts` supplies the real `StorePort`, `ExtractorPort[]`, `DetectorRunnerPort`, and `SnapshotPort` implementations it needs.

It exports:

- `runCli`, `VERSION` — the total command runner and package version.
- `bufferIo`, `CliError`, `EXIT_FINDINGS`, `EXIT_OK`, `EXIT_RUNTIME`, `EXIT_USAGE`, `processIo`, `systemClock` — I/O abstractions and the exit-code contract.
- `COMMANDS`, `HELP_TEXT`, `COMMAND_HELP`, `findCommand`, `parseCommandArgs`, `isCommand`, `VALUE_OPTIONS` and the `Command`, `GlobalOptions`, `ParsedInvocation` types — argument parsing and help text.
- `colourEnabled`, `makeStyle`, `stripAnsi`, `styleFor`, `Style` — terminal styling.
- Config loading and defaults (`CONFIG_FILENAME`, `CONFIG_VERSION`, `DEFAULT_OUT_DIR`, `STARTER_PROFILE`, `defaultConfig`, `loadConfig`, `parseConfig`, and related exports).

## Export profiles

`seamline export --profile <name>` and `seamline mcp --profile <name>` take the same names and read the same format. A name is either a shipped profile (`public`, `team`, `audit`) or one declared under `exportProfiles` in `seamline.config.json`, keyed by name. In a file, a released node or edge carries only the fields `allowFields` names, and the run ids (`firstSeenRun`, `lastSeenRun`) and `deletedAt` only when it names them. Over MCP, `allowFields` governs the location and lifecycle fields only (see [`@seamline/mcp`](https://github.com/zylver-solutions/seamline/blob/main/packages/mcp/README.md)). `seamline init` scaffolds a starter profile called `structure`; it releases internal-level structure (file paths and the import graph), so narrow it before using it for anything shared:

```json
{
  "version": 1,
  "exportProfiles": {
    "structure": {
      "version": 1,
      "description": "Files and modules, extracted facts only.",
      "allow": [["File", "internal"], ["Module", "internal"]],
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

There is no default profile: without `--profile` both commands refuse. A profile without `version`, with a field the format does not have, or with a value outside the closed vocabulary is refused when the config loads, naming the field. `seamline export --list-profiles` shows every available profile. The format is specified in [`docs/design/export-profile.md`](https://github.com/zylver-solutions/seamline/blob/main/docs/design/export-profile.md) and described by [`docs/reference/export-profile.schema.json`](https://github.com/zylver-solutions/seamline/blob/main/docs/reference/export-profile.schema.json).

## Selecting the store

`seamline extract` writes the graph store (`graph.db`, plus `runs/` snapshots) into the config's `outDir`, `seamline-out/` by default, and every other command except `init` reads it from there. To use a store somewhere else, pass `--store <dir>`; the same spelling works on every command that touches a store:

```bash
seamline extract --store ci/graph                       # write the store there
seamline check   --store ci/graph                       # read it
seamline export  --store ci/graph --profile team --out slice.json
```

| Command | `--store <dir>` | `--out` |
|---|---|---|
| `extract` | the directory written | the same thing, another spelling |
| `why`, `check`, `diff`, `blast-radius`, `mcp` | the directory read | the same thing, another spelling |
| `export` | the directory read | the destination **file** only; it never selects the store |
| `init` | not accepted | not used |

- With no `--store` (and no `--out` where it names the store) a command uses the config's `outDir`, exactly as before. Nothing about `--out` changed.
- A relative `--store` resolves against the repository root (`--repo`, default the current directory), the same base `--out` and `outDir` use, so `extract --out storeA` and `export --store storeA` name one directory.
- Where `--out` also names the store, giving both `--store` and `--out` is accepted only if they resolve to the same directory. If they differ the command exits 2 and opens nothing: one of two explicit instructions would otherwise lose silently, and reading the wrong store looks exactly like reading the right one.
- A `--store` that does not exist, or a directory with no `graph.db` in it, exits 2 with `no graph store found at ...`. It is never reported as an empty or clean result. `diff` looks up run ids under `<store>/runs/`.

**Stability tier: Agent and operator surface.** Commands, flags, and exit codes are semver-governed: removing or renaming one, or changing what an exit code means, is a breaking change requiring a major bump and a deprecation window. Adding a command, flag, or output field is not breaking.

Install with `npm install -g @seamline/cli` (or `pnpm add -g @seamline/cli`); the installed shell command is `seamline`.
