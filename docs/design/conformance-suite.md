# The extractor conformance suite

- **Status:** Design-spec pass, implemented. The suite is the `seamline conformance` command (`packages/cli/src/conformance/`) and shipped in release 0.1.0 (2026-11-10). [`docs/conformance.md`](../conformance.md) is the description for someone running it; this document records the design. Subordinate to `docs/design/v3.md`.
- **Date:** 2026-10-19
- **Tracking:** the work toward [the aspirational state](aspirational-state.md). The named consumer is the maintainer who owns the project, and the admission test's second leg (a named owner) is recorded in `docs/design/aspirational-state.md` section 5.3.
- **Scope:** the outside-runnable suite that `docs/design/aspirational-state.md` section 2.5 defines, and nothing past it. No new package, node kind, edge kind, extractor, store adapter or lens; no change to `packages/ontology/src/contract.ts`; no new runtime dependency; no subpath export.

## 1. Is it a deferred item

It is not listed in v3 section 9. It is the 1.0 deliverable of aspirational-state section 2.5 ("The conformance suite is the deliverable") and condition 3 of section 0, which sit inside v3's cut. It does not undefer the out-of-tree extractor port that section 9 names under "languages other than TypeScript": `seamline extract` still runs only the bundled extractors, nothing loads a community extractor into a run, and no trust or signing story is added. Section 2.5 is explicit that until the admission test clears one, "explicitly enabled by the operator" is the whole trust model, and `docs/conformance.md` says so.

A design pass is written anyway, because the suite runs third-party code and the properties it asserts are a public promise.

## 2. What is asserted

The five clauses of section 2.5, with the two checks that make them checkable (`exercised`, so that nothing passes by doing nothing, and `manifest`):

| Property                                                                                  | Asserted by                                                                                                                                                                             | Decided from                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest`                                                                                | The module's `MANIFEST` is read in a confined child, then `validateManifest` is applied.                                                                                                | The manifest, against the host limits.                                                                                                                        |
| `exercised`                                                                               | The extractor reports `PASS` on a clean fixture, emits output, and opens a declared file.                                                                                               | The `clean` run.                                                                                                                                              |
| `reads-confined` ("honours its declared read globs")                                      | Undeclared file, symlinks out and to undeclared files, `..`, a link up past the root, a directory link, writes, canary content in the output.                                           | The `links` and `bait` runs: the host's violation codes, the wrapper's tally of opened files, and a search of the serialized output for the planted canaries. |
| `no-network` ("cannot reach the network")                                                 | `net`, `http`, `https`, `http2`, `dgram`, `dns`, `fetch`, `WebSocket` and child-process attempts, and any connection to a loopback listener the suite runs, whose URL is in bait files. | The violation codes `network` and `exec` in every run, and the listener's connection count.                                                                   |
| `provenance-ceiling` ("cannot exceed its declared ceiling")                               | Nothing emitted above `provenanceCeiling`, and no scope or node kind outside `produces`.                                                                                                | The host's `provenance-ceiling` and `scope-undeclared` codes, and an independent `assertWithinCeiling` over the clean output.                                 |
| `memory-ceiling` ("cannot exceed its declared ceiling")                                   | The declared `memMb` holds on a stress fixture.                                                                                                                                         | The host's `memory` code in any run, and the `stress` run completing.                                                                                         |
| `time-budget` ("terminates within its declared budget")                                   | Every run ends inside `timeoutS`.                                                                                                                                                       | The host's `timeout` code in any run.                                                                                                                         |
| `unavailable-not-pass` ("reports UNAVAILABLE rather than PASS when it cannot do its job") | With every open of a repository file failing, or the graph it reads UNAVAILABLE, the extractor does not report `PASS`.                                                                  | The `unreadable` run's status, and the wrapper's count of opens it failed.                                                                                    |

"Ceiling" in section 2.5 is read as both the provenance ceiling and the memory ceiling, because the controls table in section 2.1 of that document has both, and a memory ceiling nobody checks is the failure that section names.

Every property has a negative control (a misbehaving extractor the suite must `FAIL`) and a positive control (one it must `PASS`), in `packages/cli/src/__fixtures__/conformance/` and `packages/cli/src/conformance/suite.test.ts`. The five bundled extractors are run through the suite, with the grants a manifest cannot ask for, in `packages/cli/src/conformance/first-party.test.ts`, with a representative seed and the limits and grants `seamline extract` gives them. `extract-code-ts`, `extract-data` and `extract-contracts` must `PASS` every property. `extract-change` reads history and `infer-join` reads the run's graph, so the stress fixture has nothing to pad and the bait fixture nothing to place: for them `memory-ceiling` and `no-network` must be `UNAVAILABLE` (the test asserts that, rather than allowing it), and the rest `PASS`.

## 3. How it is run

`seamline conformance <path-to-extractor-module> [--seed <dir>] [--options <file>] [--stress-mb <n>] [--json]`, and `conformanceOfModule` / `runConformance` exported from `@seamline/cli`. Output is one verdict line per property with evidence. Exit `0` for all `PASS`, `1` for any `FAIL`, `3` for no `FAIL` and any `UNAVAILABLE`, `2` for usage.

- **The module contract is the first-party one.** `run(ctx, graph?)` and `MANIFEST`, as in `packages/cli/src/extractors/`.
- **No third-party code runs in the `seamline` process.** The manifest is read by `conformance/describe-child.ts`, a `node --permission` child with the in-child guards installed, so a module that opens a socket at import time fails `manifest`. The extractor is then run by the unchanged sandbox host, through `conformance/wrapper.ts`, an ordinary sandbox program that calls the extractor's `run`.
- **The wrapper adds two things the host does not do.** It counts the repository files the extractor opens and which of them no glob admits, and, in the `unreadable` run, makes every open of a repository file fail with `EACCES`, counting how many. Making a file unreadable by mode does not stop root and is skipped by a walker that sees a directory instead; failing the open is the one portable way to hand an extractor input it cannot read. It also tallies how many of those opens were under the stress and bait directories, so `memory-ceiling` and `no-network` can tell that the files meant to exercise them were reached, and the looks the host allows and no glob admits (a `stat`, an existence check or a directory listing of a path inside the repo), which the suite prints as evidence and does not fail on. The wrapper reports through one appended diagnostic line and changes nothing else in the result. A run that ends in an error takes the tally with it, and the evidence says so.
- **The host reports what it concluded, not only text.** `observationOf(output)` returns the violation codes a run was judged on, whether the extractor was ever started, and whether the run failed closed on looks alone (section 4). It is a `WeakMap` beside the existing return value, so `ExtractorOutput`, the ports and the host's behaviour are unchanged.
- **Fixtures are built from the declaration** (`conformance/repos.ts`, `conformance/globs.ts`): a file for each declared glob, checked against the same matcher the guard uses, plus an optional seed the author supplies. A suite that did not look at the manifest could only test extractors that read what it happened to plant.
- **The unit of work is a `SandboxProgram`.** That is what lets the bundled extractors, which need `git` or the run's graph, go through the same code as a module on disk. A module on disk never has either grant, so a third-party extractor that starts a process or reads the graph is an `exec` violation.
- **Entry point.** The suite is exported from the existing `@seamline/cli` entry. A subpath would be a new reviewed entry in `scripts/pack-check.mjs` `PUBLIC_ENTRY_POINTS`; the main entry already exports the sandbox host and its types, and importing it has no side effect. `scripts/pack-check.mjs` `PROCESS_ENTRY_POINTS` gains the two modules the suite starts by path.

## 4. A look is not a read

The guard records a probe (`stat`, `readdir`, `realpath`) of a repository path that leads out of the repository as fatal, so a run fails closed rather than report `PASS` with a file missing. That is the host's decision and the suite keeps it. But the property is "honours its declared read globs", and a directory walker that follows a symlink has not read outside them. Without a distinction, `extract-code-ts`, whose TypeScript file discovery follows links, would fail `reads-confined`, and so would any extractor of the same shape, for a reason unrelated to what the property says.

So the guard now records whether a denial was a content access or a probe (`RecordedDenial.access`), and the host's observation says whether a run was stopped by probes alone (`probeOnly`). The suite treats a probe-only stop on the `links` fixture as `PASS` for `reads-confined` with the cost stated in the evidence ("it cannot finish on a repository that holds such a link"), and any content access, write, socket or process as `FAIL`. The `links` lures are a separate fixture from the `bait`, so a run stopped by a link does not stop the bait from being tested.

This is the one place the suite is more lenient than the strictest reading, and the reason is recorded here: the strict reading fails the project's own flagship extractor for behaviour the host already handles safely, and the lenient one is still a `FAIL` for the thing the property is about.

## 5. What it does not promise

Stated in `docs/conformance.md` and not repeated at length:

- No signing, no trust, no endorsement. Community extractors stay unsigned, and `seamline extract` does not load one at all (section 1).
- Behaviour on generated fixtures, not on every repository.
- The guards are JavaScript in the extractor's process; they do not stop an extractor written to defeat them (`THREATMODEL.md` R5). A pass says the extractor behaved.
- Correctness of the facts, determinism, identity and tombstoning are not asserted.
- Reads made by a granted child process (`git`) are outside the guards' view.
- A look is allowed: names, sizes and times of undeclared files inside the repository, and the listing of their directories, can reach an extractor's output under a `PASS` of `reads-confined`. The property is about content; the evidence names the looks.
- Worker threads, native addons, WASI and `process.binding` are refused by the runtime before a guard sees them, so those attempts are blocked and not recorded.
- The harness is recognisable to the code under test (`ctx.repo`, `ctx.runId`, the fixture names).
- Running the suite executes the module. The sandbox it runs in is not a boundary against a hostile extractor (`THREATMODEL.md` R5), the `env` names its manifest lists are passed through with the operator's values, and what is readable without a glob is the module's directory, its nearest `package.json` as a file and its installed dependencies, chosen by npm package name (`conformance/load.ts`, `sandbox/policy.ts` `closureRoots`).

`UNAVAILABLE` is a first-class result. A property the fixtures could not exercise is never reported `PASS`: an extractor that emits nothing, opens nothing it declares, or was not run on the fixture a property needs gets `UNAVAILABLE`, and the exit code is not `0`.

## 6. Documents amended with the implementation

- `docs/conformance.md`, linked from the README and `CONTRIBUTING.md`; a CHANGELOG entry.
- `docs/design/aspirational-state.md` section 2.5: a pointer to the implemented suite.
- `THREATMODEL.md`: C4 points at the suite as the way an outside author checks an extractor against it, and R5 states that `seamline extract` has no loader for another program while `seamline conformance` runs a module the operator names, with the limits stated there.
- `packages/cli/src/commands/store-selection.test.ts`: `conformance` joins `init` as a command that takes no `--store`, because it reads no store.
