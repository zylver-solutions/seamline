# @seamline/align

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The alignment report: compares what a repository's documents claim with what its code and manifests show, and emits a versioned, redacted finding packet. It never gates a build.

## Install

```bash
npm install @seamline/align
```

Requires Node.js 22.13 or later. Most users should not install or import this directly: `seamline align` in `@seamline/cli` runs it. Import it directly only if you are building a tool that reads the finding packet's producer side, or that supplies the implementation facts from somewhere other than a SIF snapshot or a Seamline store.

## Usage

```js
import { readFileSync } from 'node:fs';
import { PACKET_SCHEMA_VERSION, readBaseline } from '@seamline/align';

// Read back a packet written by `seamline align --profile <name> --packet align.json`.
// readBaseline throws unless the packet's schema version is 1 and its digest verifies.
const baseline = readBaseline(readFileSync('align.json', 'utf8'));
console.log(PACKET_SCHEMA_VERSION, baseline.digest, baseline.findings.length);
```

## How it works

The design is [`docs/design/alignment.md`](https://github.com/zylver-solutions/seamline/blob/main/docs/design/alignment.md) and the decision is [ADR-0014](https://github.com/zylver-solutions/seamline/blob/main/docs/adr/ADR-0014-alignment-drift-classes-and-finding-packet.md). In short:

- It reads a **closed set of claims** out of the Markdown a repository tracks: a Node or pnpm floor, the output formats of the CLI, which contradiction detectors work, which controls are enforced. The reading is structural anchors plus a closed list of whole-sentence templates. It has no model and no scoring.
- It compares each claim with a fact taken from Seamline's own extraction of the same commit, from sources read at that commit, or from a `package.json`.
- Each comparison that finds something ends in one of five classes: **Observed drift**, **Unexplained gap**, **Planned gap**, **Unknown** or **Resolved** (against a baseline packet you supply). The summary also counts the subjects that are aligned. A failed or unsupported extraction is Unknown and is never read as absence.
- Drift is reported and never enforced: there is no flag, environment variable or configuration key that makes drift fail.

Main exports:

- `evaluate`, `EvaluateInput`: documents and facts in, a packet body out. Pure: no clock, no environment, no network.
- `redactPacket`, `RedactedPacket`: the existing redactor is the sole writer. Free text is redacted, identity and path fields are guarded and never rewritten.
- `runAlign`, `AlignRequest`, `AlignSink`, `writeOutput`: the whole pipeline behind one function, writing through a single site.
- `readBaseline`, `packetDigest`: read a packet back as a baseline; its schema version must be 1 and its digest must verify.
- `buildScopeTable`, `runProvenance`, `AlignFacts`: the facts source and what pins a fact to a commit.
- `PACKET_SCHEMA`, `PACKET_SCHEMA_VERSION`, and the `Packet`, `PacketFinding`, `PacketProposal` types: schema version 1.
- `gitTree`, `worktreeTree`, `memTree`, `resolveCommit`: the evaluated tree, read from the git object database.

`typescript` is an optional peer dependency, as for `@seamline/extract-contracts`. The output-format and detector-liveness probes parse TypeScript, and `npm install @seamline/cli` does not install it. Install `typescript@^6.0.3` next to the CLI before reading a report. Without it those two probes do not run and the report says so in every output: the human summary states once that the parser is missing and names the probes, the `--json` summary has a `parser` object (`available`, `reason`, `probesNotRun`), and in the packet each of those probes has status `FAIL` with a `parser unavailable: <reason>` entry in `inputs.probes[].diagnostics`, and each finding they would have checked is Unknown (`probe-failed`) with the same reason in `unknown.detail`. The peer range is `^6.0.3`, read as npm reads it: a prerelease or nightly build (`6.0.3-rc`, `6.1.0-beta`, `6.1.0-dev.20261101`) is outside it. A `typescript` whose version is outside the range (TypeScript 7, for example), that lacks a member of the compiler API the probes call, or that is installed and fails to load, is treated as a missing parser: the reason names what was found and the supported range, and nothing fails. A probe that stops on a parser fault while it runs answers Unknown (`probe-failed`) with the error as the reason. In 0.1.0 the reason was not shown and TypeScript 7 stopped `align` with exit code 3.

Detector claims exist only in a repository that tracks the detector registry file `packages/contradictions/src/detectors/index.ts`, which in practice is the Seamline repository; any other repository has none, with or without the parser. When that file is tracked and cannot be read in full (no usable parser, syntax errors, over the size bound, or an `ALL_DETECTORS` that does not resolve), the codes that a catalog table in the documents names are still read as claims and reported as Unknown with the specific reason. A code that appears only in prose is not. The number of claims can therefore differ between a run with the parser and a run without it. In 0.1.0 all detector claims were dropped in that case.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0. The packet schema is versioned independently: within version 1 a producer never removes, renames or retypes a field, and a consumer must ignore fields it does not know.

See the [repository README](https://github.com/zylver-solutions/seamline#documents-against-code-seamline-align) for the command and the design linked above for the detail. License: Apache-2.0 ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)).
