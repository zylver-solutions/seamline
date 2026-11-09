#!/usr/bin/env node
/**
 * The `seamline` binary. The only file in this package that touches the
 * process: everything else returns an exit code.
 *
 * WIRING: `@seamline/core`, `@seamline/contradictions`, `@seamline/infer-join`,
 * and the four extractor packages are workspace dependencies of this package
 * (see `package.json`), so `CliDeps` is fully wired here via `wiring.ts`.
 * `runCli` itself stays decoupled from all of them — it only ever sees the
 * `ports.ts` interfaces — so the ports remain swappable (a fake store and
 * fake extractors are exactly what `testing.ts` and the command tests use).
 */

import { processIo } from './io.ts';
import { runCli } from './run.ts';
import { buildCliDeps } from './wiring.ts';

const io = processIo();
const deps = buildCliDeps(io);

const code = await runCli(deps, process.argv.slice(2));
process.exitCode = code;
