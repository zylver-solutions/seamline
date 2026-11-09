# Contributing to Seamline

Thanks for your interest. This document is the short version of everything you need to land a change.

Before touching the ontology, the CLI's flags or exit codes, or a package's public exports, read [`docs/design/v3.md`](docs/design/v3.md). It is the authoritative design and the code is wrong when it contradicts it, until the design is intentionally changed.

Before proposing a large feature, read [`docs/audit/2026-08-29-council-review-v2.md`](docs/audit/2026-08-29-council-review-v2.md). It is the record of a nine-lens adversarial review that blocked the previous design. A great deal of scope has already been argued and cut on the record; that document is where you find out whether your idea is new or whether it lost an argument in August 2026.

---

## Developer Certificate of Origin

**Seamline uses the [DCO](https://developercertificate.org/). There is no CLA.** You keep your copyright; you certify that you have the right to submit the work.

Sign every commit:

```bash
git commit -s -m "fix: nullability detector no longer fires on generated columns"
```

`-s` appends a line to your commit message:

```
Signed-off-by: Jane Contributor <jane@example.com>
```

The name and email must be real and must match your commit author. A DCO check runs on every pull request and blocks the merge until every commit in the branch is signed off. If you forgot, `git rebase --signoff main` fixes the whole branch.

By signing off you certify the four clauses of the Developer Certificate of Origin 1.1 (reproduced in full at <https://developercertificate.org/>): in short, that you wrote the contribution or have the right to submit it under Apache-2.0, and that you understand it is public and will be redistributed.

**Employer note.** If you contribute on company time or using company resources, make sure your employer permits it before you sign off. The DCO's point is that you are asserting you have that right.

---

## Setup

Node >= 22.13 (this repo develops on 24) and pnpm >= 10.

```bash
pnpm install
./node_modules/.bin/tsc --build
node --test 'packages/*/src/**/*.test.ts'
```

Full conventions are in [`docs/toolchain.md`](docs/toolchain.md), which is binding on every package. Four of them bite immediately, so they are repeated here:

1. **Relative imports carry the `.ts` extension.** `import { nodeId } from './contract.ts'`. Node strips types without rewriting specifiers, so `./contract.js` resolves to a file that does not exist in `src/`. TypeScript rewrites the extension on emit, so both the source and `dist/` are valid.
2. **Erasable syntax only.** No `enum` (use an `as const` array plus a derived union), no `namespace`, no constructor parameter properties. Node can strip types, not transform them.
3. **`node:test` and `node:assert/strict`.** No vitest, no jest, no ts-node, no tsx. vitest pulls esbuild, whose postinstall needs a `chmod` that some development mounts do not support, and the failure mode is a hang rather than an error. There is also a design reason: every build dependency is supply-chain surface this project has publicly committed to minimising.
4. **The contract is frozen.** `packages/ontology/src/contract.ts` is the seam every package compiles against. Do not edit it in a feature PR. If it is wrong, say so in the PR description and work around it locally; changing it is coordinated separately because every other package depends on it.

---

## Verification is local first, CI second

Enforcement happens in four layers, and the first three run on your machine. CI is the backstop that catches what you skipped, not the first place your change gets checked.

1. **`pnpm typecheck`** builds every package. Most mistakes in this codebase are type errors by construction; `erasableSyntaxOnly` and the branded `NodeId` type are there to make them so.
2. **`pnpm test`** runs the unit, property, and conformance suites.
3. **`pnpm verify`** runs everything, in the order CI runs it:

   ```bash
   pnpm verify   # typecheck + lint + test + gate:license + gate:ontology + gate:ontology-ref + gate:determinism + gate:pack + gate:dogfood
   ```

4. **CI** runs the same commands on every pull request, plus the release gates.

**If `pnpm verify` exits non-zero, the change does not merge and the release does not get tagged. No exceptions.** A gate is either enforced or it is decoration.

### The gates, and what each one actually asserts

| Gate | Command | Asserts |
|---|---|---|
| License | `pnpm gate:license` | Every installed package resolves to a permissive SPDX identifier on the allow-list. A missing, `UNLICENSED`, or unrecognised license field **fails**: absent a grant, the default is "all rights reserved", which is not permissive. |
| Ontology | `pnpm gate:ontology` | Every kind participates in at least one edge; no edge is used outside its declared domain and range; no breaking schema change without a major bump. |
| Ontology reference | `pnpm gate:ontology-ref` | `docs/reference/ontology.md` is exactly what `scripts/gen-ontology-ref.mjs` renders from `ontology/seamline.yaml` and the extractor manifests. After an ontology or manifest change, run `pnpm gen:ontology-ref` and commit the result. |
| Determinism | `pnpm gate:determinism` | Extraction run twice over the same tree produces byte-identical output. |
| Pack | `pnpm gate:pack` | Each publishable package, packed with `pnpm pack` (offline, nothing is published), has no tests, fixtures, source maps, TypeScript source or test-support modules; every `main`, `types`, `bin` and `exports` target is in the tarball; `exports` lists only the reviewed entry points in `scripts/pack-check.mjs`; `engines.node` matches the root; the license is Apache-2.0; `LICENSE`, `README.md` and a `NOTICE` that is byte-equal to the root file ship; `repository`, `description`, `homepage` and `bugs` are set; every import in shipped code is a declared dependency and every shipped module is reachable from an entry point; and `@seamline/integration` stays private. Run `pnpm build` first. |
| Dogfood | `pnpm gate:dogfood` | What Seamline finds about its own repository (its `check` findings, the `examples/` extraction, the unread TS/JS files) still matches the last reviewed baseline in `docs/dogfood/baseline/`. |

Three notes on gates, because they are the part contributors most often get wrong:

- **A gate that cannot check must fail, not pass.** `scripts/determinism-gate.mjs` exits non-zero when the CLI is not built, rather than reporting success on an empty comparison. Do not "fix" a gate by making its unavailable path green.
- **Assert the outcome, not the presence.** `assert.ok(typeof detect === 'function')` is not a test. This project's entire thesis is that presence-checking is not verification; the test suite is held to its own standard.
- **Every detector needs a fixture pair.** One fixture that makes it fire, one that does not, and a meta-test asserting both. A detector that always fires and a detector that never fires are equally useless and equally invisible.

### Dogfood baseline changes

The dogfood gate compares what Seamline reports about itself with the files in `docs/dogfood/baseline/`: `findings.json` (the `seamline check` contradictions, UNKNOWNs and each extractor's PASS/FAIL/UNAVAILABLE status), `examples.sif` (the part of the self-extraction that comes from `examples/`), `code-ts-coverage.json` (tracked TS/JS files no tsconfig project reads) and `why-orders-customer-email.json`. Seamline's own source symbols are not in the baseline, so an ordinary code change leaves the gate green. When it goes red, the failure prints what appeared, disappeared or changed.

- **Read the diff before touching the baseline.** A new contradiction, a changed severity, an extractor going `UNAVAILABLE`, or a changed `examples.sif` line is usually a regression to fix in the code.
- **A baseline change lands in its own pull request, with the reason.** It never rides inside a change that alters extraction behaviour.
- **When a behaviour change moves the baseline,** open the baseline update as a separate pull request stacked on the behaviour branch, and review it on its own: `node scripts/dogfood-gate.mjs --update`, then `git diff -- docs/dogfood/baseline`. Stage any new files first, because coverage is measured against `git ls-files`.
- **Never run `--update` just to clear a red build.** Regenerating the baseline until the gate is green turns the regression detector into a formality.
- A newly added TS/JS file that no tsconfig project reads (any new `scripts/*.mjs`, for instance) appears in `code-ts-coverage.json`'s `unread` list. That is a baseline change too; adding a file the extractor does read is not.
- **The run id's value is not part of the comparison.** Under `SEAMLINE_DETERMINISTIC` the run id (`run-det-` and 16 hex digits) is a digest of the repository, so it changes with nearly every commit, and it is stamped on every node and named in the SIF header. The gate replaces it with `<run-id>` on both sides of `examples.sif` and the `why` output, and `--update` writes that form, so a changed run id alone is never a baseline change. Everything else is still compared byte for byte, and a run id other than the one just extracted is a failure.

### Determinism rules for contributors

Extraction output is a CI gate, so when you write an extractor or a serializer:

- No wall-clock time in a node or edge body. Time belongs to the `Run` record.
- Sort before you serialize: object keys sorted, arrays sorted by stable id.
- Repo-relative POSIX paths only. Never an absolute path, never a backslash.
- No `Math.random()`, and no unseeded iteration over a `Set` or `Map` whose insertion order came from filesystem traversal order.

---

## Adding a dependency

Every runtime dependency is supply-chain surface, and this project has publicly committed to keeping it small. Prefer the standard library.

If you do add one, the pull request description must name the package, its exact SPDX license, and why the standard library will not do. The license gate enforces the allow-list mechanically (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0, Unlicense, 0BSD, Zlib, PostgreSQL, and MPL-2.0 as an unmodified dependency with notice), but the gate cannot judge whether the dependency is worth having. That is the review's job.

**Copied code is not a dependency, and the gate cannot see it.** Implementing a published format or reusing a published vocabulary is fine. Pasting source from another project is not: Apache-2.0 code stays Apache-2.0 and carries its NOTICE with it, and no allow-list detects a copy-paste. If any part of your contribution is adapted from another codebase, say so explicitly in the pull request, name the upstream and its license, and expect that to be reviewed before anything else in the change.

---

## Commit messages

Conventional Commits, because the changelog is generated from them.

| Prefix | For |
|---|---|
| `feat:` | new behaviour |
| `fix:` | a bug fix |
| `perf:` | performance, no behaviour change |
| `refactor:` | no behaviour change |
| `docs:` | documentation only |
| `test:` | tests only |
| `build:` / `ci:` | toolchain, dependencies, workflows |
| `security:` | security-relevant; gets called out in the changelog |
| `ontology:` | a change to `ontology/seamline.yaml` or the generated vocabulary |

A breaking change gets a `!` (`feat!:`) and a `BREAKING CHANGE:` footer explaining the migration. Breaking the ontology simultaneously invalidates persisted graphs, third-party extractors, and every stored query, so an ontology break needs a major version and a migration note, not a footnote.

---

## Pull requests and review expectations

- **One concern per pull request.** A refactor bundled with a behaviour change is two reviews wearing one hat, and it gets sent back.
- **A bug fix comes with a regression test** that fails before your change and passes after. Say which test that is in the description.
- **State what you ran.** "I ran `pnpm verify` locally" plus anything you could not run and why. If a gate is failing for a reason unrelated to your change, say so rather than leaving the reviewer to work it out.
- **Explain the why, not the what.** The diff already says what changed.
- **Design-contradicting changes need the design changed first.** If your change conflicts with `docs/design/v3.md`, open an issue proposing the design change before writing the code. Code that quietly diverges from the spec is the failure mode this project is specifically built to detect.

What a reviewer will check, in order: does it match the design; does the test assert an outcome rather than a presence; is extraction still deterministic; does it widen the export, query, or dependency surface; is untrusted third-party text still tagged and delimited.

Maintainers aim to respond to a pull request within a week. This is a small project; if it goes quiet, a polite bump on the thread is welcome and is not considered nagging.

---

## What is welcome

- Bug fixes with regression tests.
- New cases for the public injection and secrets corpus (`packages/security/corpus/`). A case is a JSON entry and needs no TypeScript; see [Adding a case](packages/security/README.md#adding-a-case). A payload that gets past a renderer is a security finding: report it under [SECURITY.md](SECURITY.md) rather than weakening the entry.
- New contradiction detectors, with a fixture pair and a false-positive analysis.
- Improvements to join inference quality, especially calibration: a confidence score that does not track real precision is worse than no score.
- Extractors for additional TypeScript-adjacent schema formats (more ORMs, more validator libraries).
- Documentation, error-message, and diagnostic improvements. A confusing `UNKNOWN` is a bug.
- Real-world reports: "I ran this on my repository and chain 3 is nonsense" is a genuinely valuable issue, provided you can share a redacted reproduction.

## What is unlikely to be accepted

- **A new language extractor** built on regexes or an untyped parser. Confident nonsense is worse than an honest `UNAVAILABLE`.
- **A raw query interface** on the MCP server or the store, in any form. It was removed deliberately; it is arbitrary code execution with a friendly name.
- **Anything that widens export by default.** Export is default-deny and stays that way.
- **Network calls from an extractor.** Extractors run with networking off under their capability manifest, and that is not a configuration detail. If you are writing an extractor, run it through `npx seamline conformance ./your-extractor.mjs` ([`docs/conformance.md`](docs/conformance.md)) before opening a pull request; a `contrib/` extractor is unsigned and refused unless the operator explicitly enables it, and a passing run changes neither.
- **Gap-style findings that fire on the absence of an annotation.** See the design; this is the one thing v0.1 is explicitly not.
- **A web viewer, a hosted service, or telemetry.**

Deferred features are listed in `docs/design/v3.md` section 9, each gated on a named consumer. "Someone might want it" is not a named consumer. If you are that consumer, say so in an issue: that is exactly how the gate is meant to open.

---

## Reporting problems

- **Bugs and features:** GitHub Issues, using the templates. The bug template asks for environment output; please include it, because "it does not work" and "your Node build does not support type stripping" look identical from the outside.
- **Security vulnerabilities:** do **not** open an issue. Follow the private disclosure path in [SECURITY.md](SECURITY.md).
- **Conduct concerns:** see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Branch protection

- `main` is protected. No direct pushes; every change goes through a pull request.
- Linear history: rebase or squash, no merge commits.
- Required checks: CI (typecheck, lint, test, license gate, ontology gate, determinism gate, dogfood gate) and DCO.
- Force pushes to `main` are forbidden.

## License of your contribution

By contributing you agree that your contribution is licensed under Apache-2.0 for code, and CC-BY-4.0 for changes to the ontology or the specification text under `docs/design/`, matching the licenses of the files you are editing. This is the same term as Apache-2.0 section 5, restated so it is not a surprise.
