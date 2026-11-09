# Extractor conformance suite

`seamline conformance` runs an extractor you wrote through the same sandbox `seamline extract` uses, against fixture repositories it generates, and prints one `PASS`, `FAIL` or `UNAVAILABLE` line per property with the evidence for it. It is how an outside extractor author finds out, before anyone else does, whether their extractor honours the capability manifest it declares.

```text
npm install @seamline/cli
npx seamline conformance ./my-extractor.mjs
```

It needs Node 22.13 or later (the sandbox is built on `node --permission`), runs offline, and runs your extractor only inside the sandbox, never in the `seamline` process.

Design record: [`docs/design/conformance-suite.md`](design/conformance-suite.md). The controls themselves are described in [`THREATMODEL.md`](../THREATMODEL.md), control C4.

## Running it executes the module

`seamline conformance` imports and runs the module you give it. It does so in a child process under `node --permission`, with guards on file reads, the network and child processes, but **that sandbox is not a security boundary against a hostile extractor** ([`THREATMODEL.md`](../THREATMODEL.md), R5): the guards are JavaScript in the extractor's own realm, and the child runs as your user. Run the suite only on code you would be willing to run.

What the module is given:

- Its own directory, the nearest `package.json` above it (as one file), and the dependencies that file lists, if they are installed under a `node_modules`. Every `node_modules` directory a dependency is found in is granted whole, with everything in it (other packages, a `.cache`), because Node must be able to look inside it to resolve the dependency; the permission model cannot grant less. Nothing else of the package or of the project around it: a module at `proj/tools/ext.mjs` can read `proj/tools/` and `proj/node_modules/`, not `proj/.env`. Put the module in a directory of its own, and do not keep secrets under a `node_modules` it can reach.
- The values, from the environment you run `seamline` in, of the variables its manifest lists in `env` (credential-shaped names are refused). The module can put them in its output, and `--json` prints the first diagnostics of every run, so a value you export for a name the manifest asks for can end up in the report. Do not run the suite with secrets in the environment under names an extractor you do not trust might list.
- The generated fixture repository, under the rules the properties below check.

## What a PASS does not promise

Read this first.

- **It is not a signature, a review or an endorsement.** Nothing about a passing extractor makes it trusted. This project has no signing or trust story for community extractors, and the only trust model is that the operator explicitly enabled one. `seamline extract` runs only the bundled extractors in this version, so there is nothing for a PASS to enable.
- **It shows behaviour on the fixtures, not on every repository.** A property is `PASS` when your extractor, run under the host on the generated fixtures, did not violate it. An extractor that misbehaves only on an input the fixtures do not contain passes. Supply `--seed` with input that is representative of yours to move the fixtures closer to it.
- **The guards are not a security boundary against an extractor written to defeat them.** They stop an extractor that wanders or regresses, and make every attempt visible. They are JavaScript in the same process as the extractor, and the permission model under them is a floor for file reads, not a VM or a container. [`THREATMODEL.md`](../THREATMODEL.md) (R5) says what is and is not defended. A conformance PASS says your extractor behaved, not that it could not have done otherwise.
- **Looking is not reading, and a look is allowed.** The host lets an extractor `stat`, check for, or list any path inside the repository, because it needs only containment to do so. So an extractor can learn the names, sizes, modes and times of files its globs do not admit, and the listing of the directories around them, and put that in its output, under a `PASS` of `reads-confined` (the property is about content). The suite prints the paths the extractor `stat`ed or checked that no declared glob admits, and how many directories it listed, as evidence (`it looked at N in-repo path(s) that no declared glob admits ...`); it does not fail on it. A directory listing on its own is how every walker works, so it is not printed on its own. A look at a path that leads outside the repository is different: that stops the run (see "How a symlink is judged").
- **Not every attempt is recorded.** The guards record the attempts they see, even when the extractor catches the error. Worker threads, native addons, WASI and `process.binding` are refused by the Node permission model itself, before any guard: they are blocked and nothing reaches the network, but the attempt is not in the report.
- **An extractor can tell it is being tested.** The suite runs it with `ctx.repo === 'conformance'`, `ctx.runId === 'conformance-run'` and fixtures named `conformance-*`. A PASS is about those fixtures, as the second item above says; code written to behave on them and nowhere else passes.
- **A child process the host grants is outside its view.** A bundled extractor that runs `git` reads through it; the suite covers the files the extractor opens itself. Your extractor gets no such grant (see below).
- **It does not check that your output is correct.** It checks that the output is within the declared ceiling and scopes, not that the facts are true.
- **It does not check determinism, identity or tombstoning.** Those are the project's own gates on the bundled extractors (`pnpm verify`); an extractor you write should honour them (see [`CONTRIBUTING.md`](../CONTRIBUTING.md), "Determinism rules for contributors"), but this suite does not assert them.

## Writing an extractor module

An extractor is an ES module. It exports two things, the same two the bundled extractors' program modules export (`packages/cli/src/extractors/`):

```js
// my-extractor.mjs
export const MANIFEST = {
  name: 'todo-notes',
  version: '0.1.0',
  reads: ['**/*.md'], // repo-relative globs; [] means it reads no repository file
  net: false, // must be the literal false; there is no opt-in
  env: [], // environment variables it may see, beyond PATH, LANG, LC_ALL, TZ
  memMb: 128, // memory ceiling
  timeoutS: 30, // wall-clock budget
  provenanceCeiling: 'EXTRACTED',
  produces: [{ scope: 'todo-notes', kinds: ['File'] }],
};

export async function run(ctx) {
  // ctx.repoRoot, ctx.repo, ctx.runId, ctx.options, ...
  // return { result, nodes, edges: [{ scope, edges }] }
}
```

- `MANIFEST` (or `manifest`) is an `ExtractorManifest` (`packages/ontology/src/contract.ts`). The host enforces it; it is not documentation.
- `run(ctx)` receives an `ExtractContext` (`packages/cli/src/ports.ts`) and returns an `ExtractorOutput`: an `ExtractorResult` with `status`, the nodes it found, and its edges grouped by scope. `result.extractor` must equal `MANIFEST.name`.
- An extractor that cannot do its job returns `status: 'UNAVAILABLE'` with a diagnostic. It does not throw for a missing input and it does not return `PASS` with partial output. This is the rule the last property below checks.
- The module's code is read from its own directory, from the nearest `package.json` above it (that one file, not the directory), and from the dependencies that `package.json` lists, with what those depend on, when they are installed under a `node_modules` (a package name only; a dependency that is a link out of `node_modules`, as `npm link` or a workspace makes one, is not opened). It can import Node built-ins, its own files, those dependencies, and `@seamline/ontology` helpers. A relative import of a file outside its own directory (`../shared/x.mjs`) fails the `manifest` property with the refused path named: bundle it, or move the module up. Everything else it touches is the repository it is run against.

The full worked example used by the project's own outside-install test is `GOOD_EXTRACTOR` in [`scripts/outside-install.mjs`](../scripts/outside-install.mjs).

## Running it

```text
seamline conformance <path-to-extractor-module> [--seed <dir>] [--options <file.json>] [--stress-mb <n>] [--json]
```

| Option             | Meaning                                                                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--seed <dir>`     | A directory of representative input, copied into every fixture. Without it the fixtures hold only generic files made from your `reads` globs, which a format-specific extractor will usually find nothing in (and then the suite says so, see `exercised`). |
| `--options <file>` | A JSON object passed as `ctx.options`, verbatim.                                                                                                                                                                                                            |
| `--stress-mb <n>`  | Size of the stress fixture. Default 8.                                                                                                                                                                                                                      |
| `--json`           | The report as JSON on stdout.                                                                                                                                                                                                                               |

Exit codes: `0` every property `PASS` (or `NOT_APPLICABLE`); `1` at least one property `FAIL`; `2` usage error; `3` no `FAIL`, but at least one property `UNAVAILABLE`. `UNAVAILABLE` is never `PASS`: a property the fixtures could not exercise has not been shown to hold, and exits non-zero.

A whole run is five short sandbox runs (clean, links, bait, unreadable, stress) and takes seconds for a small extractor. An extractor that hangs is waited for until its own `timeoutS`, once: the suite stops after the first run the host killed at the budget, `time-budget` is `FAIL`, and the fixtures not run are named in its evidence (the properties that needed them are then not assessed). Reading the manifest has its own bounds: 30 seconds, and, on Linux (where the resident size is read from `/proc`), 512 MiB of resident memory for the child that imports the module. Give a test copy a short `timeoutS` while you iterate.

### From code

`@seamline/cli` exports the suite:

```ts
import { conformanceOfModule, runConformance, PROPERTY_IDS } from '@seamline/cli';

const report = await conformanceOfModule('./my-extractor.mjs', process.cwd(), {
  seed: './fixtures',
});
if (report.verdict !== 'PASS') process.exitCode = 1;
```

`conformanceOfModule(path, cwd, options)` loads a module and runs the suite. `runConformance(program, options)` takes a `SandboxProgram` (the module path, its manifest, and the grants a manifest cannot ask for) and is how this repository runs the bundled extractors through it. The report is `{ suite, extractor, verdict, properties: [{ id, title, verdict, evidence }], runs }`. The `suite` number changes when a property is added, removed or redefined.

## The properties

Each property has a negative control in the project's own tests: a deliberately misbehaving extractor the suite must `FAIL`, next to the well-behaved one it must `PASS`. The controls are in `packages/cli/src/__fixtures__/conformance/`.

| Property               | `PASS` means                                                                                                                                                                                                                                                                                                                              | `FAIL` means                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`             | The manifest is well formed, `net` is `false`, no `env` entry is credential-shaped, `memMb` and `timeoutS` are within the host limits (2048 MiB, 300 s).                                                                                                                                                                                  | The module could not be imported or has no manifest, or the manifest is invalid. The module is first imported in a confined child, so a module that opens a socket at import time fails here.               |
| `exercised`            | On a clean fixture the extractor reported `PASS`, emitted at least one node or edge, and opened at least one file it declared.                                                                                                                                                                                                            | The host stopped it on a clean fixture, or it crashed. If it merely reported something other than `PASS`, or emitted nothing, this is `UNAVAILABLE`, and so are the properties that needed output to judge. |
| `reads-confined`       | It opened no file outside its declared globs, followed no symlink out of the repository or to an undeclared file, and no output holds the canary content planted in files it may not read.                                                                                                                                                | It opened (or tried to open) an undeclared file, a symlink that leads out of the repository or to an undeclared file, a path with `..` that lands outside, or wrote a file.                                 |
| `no-network`           | No socket, `http`, `https`, `http2`, `dgram`, DNS, `fetch`, or child-process attempt in any run, and a listener the suite runs on loopback, whose URL is in bait files that look like the extractor's inputs, received no connection, and the extractor opened at least one of those files. `UNAVAILABLE` when there was no bait to open. | Any of those. The attempt is recorded even when the extractor catches the error (but see "Not every attempt is recorded" above).                                                                            |
| `provenance-ceiling`   | Everything it emitted is at or below `provenanceCeiling` and in scopes its manifest produces.                                                                                                                                                                                                                                             | It labelled a node or edge above its ceiling, or claimed a scope or node kind it does not produce.                                                                                                          |
| `memory-ceiling`       | It opened padded files of the stress fixture and finished it without the host killing it for memory. `UNAVAILABLE` when there were none to open.                                                                                                                                                                                          | The host killed it: resident memory beyond `memMb` plus 256 MiB for the runtime, or the JavaScript heap cap.                                                                                                |
| `time-budget`          | Every run ended inside `timeoutS`.                                                                                                                                                                                                                                                                                                        | The host killed it at `timeoutS`.                                                                                                                                                                           |
| `unavailable-not-pass` | With every open of a repository file failing (`EACCES`), it reported `UNAVAILABLE` or `FAIL`, or crashed.                                                                                                                                                                                                                                 | It reported `PASS` anyway, having lost its input. `NOT_APPLICABLE` for an extractor that declares no reads.                                                                                                 |

### The fixtures

All of them are built from your `reads` globs, so a file the suite plants is one your declaration says you may read. Everything is synthesized from fixed strings; nothing is derived from a real repository.

- **clean**: your seed, and a few files for each glob (for `**/*.md`, `sample.md` at the root and under `conformance-samples/`).
- **links**: clean plus symlinks named like your declared files that lead to a file outside the repository by an absolute path and by a `..` path, to an undeclared file inside it, to a directory outside it, and up past the repository root. These are under `conformance-lures/`.
- **bait**: clean plus an undeclared file inside the repository (`conformance-lures/undeclared.conformance-canary`) holding a canary string, and files named like your declared inputs that hold the loopback listener's URL (a `$ref`, a `servers` entry, a module specifier, depending on the file type).
- **unreadable**: clean, run with every open of a repository file failing with `EACCES`. This is done inside the run (a file mode would not stop root, and a directory in a file's place is skipped by any walker), and the suite counts how many opens it failed. For an extractor that reads the run's graph, the graph reports every scope `UNAVAILABLE` instead.
- **stress**: clean plus padded files for each glob, 512 KiB each, about `--stress-mb` in all.

If the `reads` globs admit every path (`**`), no undeclared name exists, and that lure is skipped; the suite says so in the evidence.

### How a symlink is judged

The host does not let an extractor look at a repository path that leads out of the repository: `stat`, `readdir` or `realpath` of such a symlink is answered "not found", and the run fails closed, so that an extractor never reports `PASS` with a file silently missing. Opening one for content is a violation.

The suite tells the two apart. An extractor that reads through a link out fails `reads-confined`. An extractor that only looks (a directory walker that follows symlinks) is stopped by the host, read nothing, and `reads-confined` is `PASS` with the evidence saying so, because the property asks whether it read outside its globs. The consequence is yours to weigh: such an extractor cannot finish on a repository that contains a symlink leading out. The suite's own run of `extract-code-ts` is the example. Walk with `lstat` or `readdir` entry types and skip symlinks, and the note goes away.

### What the suite can and cannot reach

- The lures and stress files are at the repository root, under `conformance-lures/` and `conformance-stress/`. An extractor whose discovery starts from its own configuration (a `tsconfig.json` `include`) does not walk there unless the seed's configuration points it there. To stress such an extractor, put large input in the seed.
- An extractor that never opens a file its fixtures contain (it ignores everything the generic samples hold) is `UNAVAILABLE` for the properties that need it, not `PASS`. Fix that with `--seed`.
- `memory-ceiling` needs padded files, and `no-network` needs bait files, and each is `UNAVAILABLE` when there are none or the extractor opened none. There are none when the declared globs name fixed files only (`Makefile`, `go.mod`, `package.json`: the suite cannot make a second file the glob admits), when the extractor declares no reads (`reads: []`), or when its reads are inside `.git`. There is no stress or bait file to open either when the extractor finds its input from its own configuration and the seed's configuration does not include `conformance-stress/` and `conformance-lures/bait/`. A glob with a wildcard in the file name (`**/*.json`, `config/*.yaml`) always works.
- Your extractor is never granted a child process or the run's graph. A manifest cannot ask for either; they are grants the host makes to the bundled extractors (`packages/cli/src/sandbox/first-party.ts`). Spawning a process is therefore always an `exec` violation under `no-network`.

## When the suite says UNAVAILABLE

`UNAVAILABLE` means the suite could not tell. The evidence line names why:

- "it emitted nothing" or "it reported UNAVAILABLE on a clean fixture": give it `--seed` input it extracts from, and `--options` if it needs configuration.
- "it opened no repository file": nothing in the fixtures was a file it reads.
- "no stress file could be generated", "no bait file could be generated", "it opened none of the N padded file(s)", "it opened none of the N bait file(s)": the stress or bait fixture did not reach the extractor, so `memory-ceiling` or `no-network` has not been shown to hold. See "What the suite can and cannot reach".
- "the fixture directory overlaps the extractor's code": the extractor module sits in a directory that contains the temporary fixtures (a module directly in `/tmp`). Move it into its own directory, or set `TMPDIR`.
- "symlinks could not be built here": the machine will not create symlinks (some Windows set-ups), so the symlink lures could not be planted.
- "was not run": you narrowed the run with the programmatic `fixtures` option.

## CI

```yaml
- run: npx seamline conformance ./my-extractor.mjs --seed ./test/seed --json > conformance.json
```

A non-zero exit fails the job, for `FAIL` (1) and for `UNAVAILABLE` (3) alike. Do not treat 3 as a skip.
