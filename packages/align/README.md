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

`typescript` is an optional peer dependency, as for `@seamline/extract-contracts`. The output-format, detector-liveness and control-wiring probes parse TypeScript, and `npm install @seamline/cli` does not install it. Without it the report is much thinner, and in 0.1.0 it does not say why: the summary, `--json` and the packet show the bare reason `probe-failed` for the claims a probe could not check, and many detector and control claims are not reported at all. Install `typescript@^6.0.3` next to the CLI before reading a report. The peer range is `^6.0.3`; with TypeScript 7 installed, `align` in 0.1.0 stops with an error and exit code 3.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0. The packet schema is versioned independently: within version 1 a producer never removes, renames or retypes a field, and a consumer must ignore fields it does not know.

See the [repository README](https://github.com/zylver-solutions/seamline#documents-against-code-seamline-align) for the command and the design linked above for the detail. License: Apache-2.0 ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)).
