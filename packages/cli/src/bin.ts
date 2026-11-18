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

import { preflight } from './args.ts';
import { processIo } from './io.ts';

const io = processIo();
const argv = process.argv.slice(2);

// `--version` and `--help` open no store, so they are answered before the
// modules that load `node:sqlite` are imported. Every other invocation loads
// them here, and `runCli` repeats the same preflight to pick the command.
const checked = preflight(io, argv);
if (checked.answered) {
  process.exitCode = checked.code;
} else {
  const [{ runCli }, { buildCliDeps }] = await Promise.all([
    import('./run.ts'),
    import('./wiring.ts'),
  ]);
  process.exitCode = await runCli(buildCliDeps(io), argv);
}
