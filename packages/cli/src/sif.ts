/**
 * CLI snapshots over the shared SIF (Seamline Interchange Format) codec.
 *
 * SIF v2 has one non-JSON framing line followed by JSON records, `\n` endings, object keys sorted, no
 * absolute paths (v3 §2.3). This implementation exists so `seamline diff` and
 * `seamline extract --json` work without a store, and so the snapshot path is
 * testable with no database.
 *
 * Core owns the complete framed writer and strict reader. Headerless legacy
 * snapshots remain readable for diff; missing run metadata is never invented
 * to upgrade them to version 2.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isCompletedRun, readSif, SifFraming, writeSif } from '@seamline/core';
import type { RunRecord, SifLine } from '@seamline/ontology';
import { createRedactor } from '@seamline/security';
import { CliError, EXIT_RUNTIME, EXIT_USAGE } from './io.ts';
import type { Snapshot, SnapshotPort } from './ports.ts';

/** Untrusted SIF values and source filenames must never escape in diagnostics. */
function sifDiagnostic(message: string, code: number, hint?: string, source?: string): CliError {
  const redactor = createRedactor();
  // As with graph locators, long filesystem names are not entropy tokens.
  // Error details retain entropy scanning; source labels still receive every pattern rule.
  const label = source === undefined ? '' : createRedactor({ entropyEnabled: false }).redactString(source) + ': ';
  return new CliError(label + redactor.redactString(message), code, hint === undefined ? undefined : redactor.redactString(hint));
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Deterministic JSON: object keys sorted recursively, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value as JsonValue));
}

function sortKeys(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: JsonValue } = {};
    for (const k of Object.keys(v).sort()) {
      const child = (v as Record<string, JsonValue>)[k];
      if (child === undefined) continue;
      out[k] = sortKeys(child);
    }
    return out;
  }
  return v;
}

export function serializeSif(snapshot: Snapshot): string {
  const run = snapshot.run;
  if (run === undefined) throw sifDiagnostic('SIF v2 writing requires actual run metadata; a legacy snapshot cannot be silently upgraded', EXIT_USAGE);
  if (!isCompletedRun(run)) throw sifDiagnostic('SIF v2 snapshot writing requires completed run metadata', EXIT_USAGE);
  if (run.runId !== snapshot.runId) throw sifDiagnostic('snapshot run id disagrees with its run metadata', EXIT_USAGE);
  if (run.results.length !== snapshot.results.length) throw sifDiagnostic('snapshot results disagree with its run metadata', EXIT_USAGE);
  const records: SifLine[] = [
    { t: 'run', run },
    ...snapshot.results.map(result => ({ t: 'status' as const, result })),
    ...snapshot.nodes.map(node => ({ t: 'node' as const, node })),
    ...snapshot.edges.map(edge => ({ t: 'edge' as const, edge })),
  ];
  try { return writeSif(records); }
  catch (error) { throw sifDiagnostic((error as Error).message, EXIT_USAGE); }
}

export function parseSif(text: string, source: string): Snapshot {
  const framing = new SifFraming();
  const body = text.split('\n');
  let legacyRunId: string | undefined;
  for (let index = 0; index < body.length; index += 1) {
    const raw = body[index] as string;
    try { if (!framing.accept(raw, index + 1, index < body.length - 1)) continue; }
    catch (error) { throw sifDiagnostic(`line ${index + 1}: ${(error as Error).message}`, EXIT_USAGE, undefined, source); }
    if (raw.trim().length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { continue; } // The strict core reader supplies the physical line error.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry['t'] !== 'sif') continue;
    if (framing.framed) throw sifDiagnostic(`line ${index + 1}: legacy SIF metadata is not a version-2 record`, EXIT_USAGE, undefined, source);
    if (legacyRunId !== undefined || (entry['version'] !== undefined && entry['version'] !== '1.0.0') ||
        typeof entry['runId'] !== 'string' || entry['runId'].length === 0)
      throw sifDiagnostic(`line ${index + 1}: invalid or duplicate legacy SIF metadata`, EXIT_USAGE, undefined, source);
    legacyRunId = entry['runId'];
    body[index] = ''; // Preserve physical numbering for legacy reader errors.
  }
  try {
    const records = readSif(body.join('\n'));
    let run: RunRecord | undefined;
    for (const record of records) if (record.t === 'run') {
      if (run !== undefined) throw new Error('multiple run records cannot form one snapshot');
      run = record.run;
    }
    if (run !== undefined && legacyRunId !== undefined && run.runId !== legacyRunId)
      throw new Error('legacy snapshot id disagrees with its run record');
    const statuses = records.flatMap(record => record.t === 'status' ? [record.result] : []);
    return {
      runId: run?.runId ?? legacyRunId ?? '',
      ...(run === undefined ? {} : { run }),
      nodes: records.flatMap(record => record.t === 'node' ? [record.node] : []),
      edges: records.flatMap(record => record.t === 'edge' ? [record.edge] : []),
      results: run?.results ?? statuses,
    };
  } catch (error) { throw sifDiagnostic((error as Error).message, EXIT_USAGE, undefined, source); }
}

/**
 * Default `SnapshotPort`: SIF files on disk.
 *
 * `outDir` is passed per call (see the `SnapshotPort` doc comment), not bound
 * here, so a caller's `--repo`/`--out` flags are honoured on every invocation
 * rather than only the directory this port happened to be constructed with.
 *
 * A ref that looks like a path (contains a separator or ends in `.sif`) is used
 * verbatim; anything else is treated as a run id and resolved to
 * `<outDir>/runs/<runId>.sif`.
 */
export function fileSnapshots(): SnapshotPort {
  return {
    async read(outDir: string, ref: string): Promise<Snapshot> {
      const file = resolveRef(outDir, ref);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        throw sifDiagnostic(
          `cannot read snapshot \`${ref}\``,
          EXIT_USAGE,
          'Pass a run id from `seamline extract`, or a path to a .sif file.',
          file,
        );
      }
      return parseSif(text, file);
    },
    async write(outDir: string, ref: string, snapshot: Snapshot): Promise<void> {
      const file = resolveRef(outDir, ref);
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, serializeSif(snapshot), 'utf8');
      } catch (e) {
        throw sifDiagnostic(`cannot write snapshot: ${(e as Error).message}`, EXIT_RUNTIME, undefined, file);
      }
    },
  };
}

export function resolveRef(outDir: string, ref: string): string {
  if (ref.includes('/') || ref.includes(path.sep) || ref.endsWith('.sif')) {
    return path.isAbsolute(ref) ? ref : path.resolve(outDir, '..', ref);
  }
  return path.join(outDir, 'runs', `${ref}.sif`);
}
