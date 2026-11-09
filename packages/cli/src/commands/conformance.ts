/**
 * `seamline conformance <extractor-module>`: run the extractor conformance suite.
 *
 * The suite is `conformance/suite.ts`; this file is argument handling and rendering. It prints one
 * line per property with a verdict and the evidence for it, and exits 0 only when every property
 * is PASS (or NOT_APPLICABLE). A property the fixtures could not exercise is UNAVAILABLE, and
 * UNAVAILABLE is never PASS: it exits non-zero, with a different code from FAIL so a pipeline can
 * tell "the extractor misbehaved" from "the suite could not tell".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCommandArgs } from '../args.ts';
import { styleFor, type Style } from '../colour.ts';
import { conformanceOfModule } from '../conformance/suite.ts';
import type { ConformanceReport, Verdict } from '../conformance/types.ts';
import { EXIT_FINDINGS, EXIT_OK, EXIT_RUNTIME, usageError } from '../io.ts';
import type { CliDeps } from '../ports.ts';
import { printable } from '@seamline/security';
import { emitJson, emitText } from '../render.ts';

const OPTION_SPEC = {
  seed: { type: 'string' },
  options: { type: 'string' },
  'stress-mb': { type: 'string' },
} as const;

function paint(style: Style, verdict: Verdict, text: string): string {
  if (verdict === 'PASS') return style.green(text);
  if (verdict === 'FAIL') return style.red(text);
  if (verdict === 'UNAVAILABLE') return style.yellow(text);
  return style.dim(text);
}

export function renderConformance(report: ConformanceReport, style: Style): string {
  const lines: string[] = [];
  const who =
    report.extractor === null
      ? '(extractor not loaded)'
      : printable(`${report.extractor.name}@${report.extractor.version}`);
  lines.push(`${style.bold('seamline conformance')} ${who}`, '');
  const width = Math.max(...report.properties.map((p) => printable(p.id).length));
  for (const p of report.properties) {
    lines.push(
      `${paint(style, p.verdict, p.verdict.padEnd(14))}${printable(p.id).padEnd(width + 2)}${printable(p.title)}`,
    );
    for (const line of p.evidence) lines.push(`${' '.repeat(14)}  ${style.dim(`- ${printable(line)}`)}`);
  }
  const count = (v: Verdict): number => report.properties.filter((p) => p.verdict === v).length;
  lines.push(
    '',
    `${paint(style, report.verdict, `conformance: ${report.verdict}`)} (${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('UNAVAILABLE')} UNAVAILABLE, ${count('NOT_APPLICABLE')} NOT_APPLICABLE)`,
  );
  if (report.verdict === 'UNAVAILABLE') {
    lines.push(
      'UNAVAILABLE is not PASS: a property the fixtures could not exercise has not been shown to hold.',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function conformanceCommand(deps: CliDeps, argv: readonly string[]): Promise<number> {
  const parsed = parseCommandArgs<{ seed?: string; options?: string; 'stress-mb'?: string }>(
    argv,
    OPTION_SPEC,
  );
  const style = styleFor(deps.io, {
    noColorFlag: parsed.globals.noColor,
    json: parsed.globals.json,
  });

  const [modulePath, ...rest] = parsed.positionals;
  if (modulePath === undefined) {
    throw usageError(
      'seamline conformance needs the path of an extractor module.',
      'Usage: seamline conformance <path-to-extractor-module> [--seed <dir>] [--options <file.json>] [--stress-mb <n>] [--json]',
    );
  }
  if (rest.length > 0) {
    throw usageError(`seamline conformance takes one extractor module, got ${rest.length + 1}.`);
  }

  let options: Record<string, unknown> | undefined;
  if (parsed.values.options !== undefined) {
    const file = resolve(deps.io.cwd, parsed.values.options);
    try {
      const json: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new Error('it is not a JSON object');
      }
      options = json as Record<string, unknown>;
    } catch (e) {
      throw usageError(`--options ${parsed.values.options}: ${(e as Error).message}`);
    }
  }
  let stressMb: number | undefined;
  if (parsed.values['stress-mb'] !== undefined) {
    stressMb = Number(parsed.values['stress-mb']);
    if (!Number.isFinite(stressMb) || stressMb < 0) {
      throw usageError('--stress-mb must be a number of MiB, zero or more.');
    }
  }

  const report = await conformanceOfModule(modulePath, deps.io.cwd, {
    env: deps.io.env,
    ...(parsed.values.seed === undefined ? {} : { seed: resolve(deps.io.cwd, parsed.values.seed) }),
    ...(options === undefined ? {} : { options }),
    ...(stressMb === undefined ? {} : { stressMb }),
  });

  if (parsed.globals.json) emitJson(deps.io, report);
  else emitText(deps.io, style, renderConformance(report, style));
  if (report.verdict === 'PASS') return EXIT_OK;
  return report.verdict === 'FAIL' ? EXIT_FINDINGS : EXIT_RUNTIME;
}
