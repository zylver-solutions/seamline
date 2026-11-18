// SPDX-License-Identifier: Apache-2.0
/** Complete source-world command provenance. Script strings are never executed. */
import { record, type WriteInventory, type WriteSource, WriteUnknown } from './write-source.ts';
import { readCapped, resolveInsideRoot } from './safe-fs.ts';
import type { ExtractLimits } from './types.ts';

function assertScripts(scripts: unknown, path: string): void {
  if (scripts === undefined) return;
  if (!record(scripts))
    throw new WriteUnknown(`WRITE_EXECUTION_ORIGIN_UNKNOWN: ${path}: scripts is not an object`);
  if (Object.keys(scripts).length !== 0)
    throw new WriteUnknown(`WRITE_EXECUTION_ORIGIN_UNKNOWN: ${path}: nonempty scripts have no invocation/emitter proof`);
}

export function assertWriteScriptOrigins(project: WriteSource): void {
  project.assertBudget();
  if (!project.inventoryComplete) throw new WriteUnknown('WRITE_SOURCE_INVENTORY_INCOMPLETE');
  project.memoize('write-script-origins', () => {
    for (const path of project.inventory) {
      if (!/(?:^|\/)package\.json$/.test(path)) continue;
      const scripts = project.json(path)['scripts'];
      // No command has a closed invocation/emitter proof yet. Token blacklists
      // cannot establish shell expansion, compiler or source-writer provenance.
      assertScripts(scripts, path);
    }
  });
  project.assertBudget();
}

/** Absence authority must check metadata even when no TypeScript candidate exists. */
export function assertInventoryScriptOrigins(root: string, limits: ExtractLimits, inventory: WriteInventory): void {
  if (!inventory.complete) throw new WriteUnknown('WRITE_SOURCE_INVENTORY_INCOMPLETE');
  for (const path of inventory.files) {
    if (!/(?:^|\/)package\.json$/.test(path)) continue;
    const resolved = resolveInsideRoot(root, root, path);
    if (!resolved.ok) throw new WriteUnknown(`WRITE_EXECUTION_ORIGIN_UNKNOWN: ${path}: manifest path resolution refused`);
    const read = readCapped(resolved.absolute, limits.maxFileBytes);
    if (!read.ok) throw new WriteUnknown(`WRITE_EXECUTION_ORIGIN_UNKNOWN: ${path}: manifest read refused`);
    let manifest: unknown;
    try { manifest = JSON.parse(read.text) as unknown; }
    catch { throw new WriteUnknown(`WRITE_EXECUTION_ORIGIN_UNKNOWN: ${path}: manifest is not valid JSON`); }
    if (!record(manifest)) throw new WriteUnknown(`WRITE_EXECUTION_ORIGIN_UNKNOWN: ${path}: manifest is not an object`);
    const scripts = manifest['scripts'];
    assertScripts(scripts, path);
  }
}
