/** Conditional declared-Source semantics. Never observes an installed extension. */
import { STOCK_PG17_CATALOG } from './migration-replay-native-catalog.ts';
import type { TableName } from './migration-replay-sql.ts';

export const CORE_REPLAY_MODEL = Object.freeze({ id: 'declared-ddl-core-v2', hash: '5748cb97c26ed635672e73c87773d3b0cb6194d5086c9292936abb25dc0db49f', scope: 'Declared DDL; runtime and external state excluded.' });
export const PG17_NATIVE_MODEL = Object.freeze({ id: 'postgresql-17.12-stock-source-local-v1', hash: 'e631b9ee69943164713b490db76177abf3de8f3994d2aa62bf5844523c6dde5c', scope: 'Canonical PostgreSQL 17.12 stock Source-local native model; externally preinstalled/added members and deployed minor/state excluded; later references conditional on live continuation.' });
export type ReplayNativeModel = typeof CORE_REPLAY_MODEL | typeof PG17_NATIVE_MODEL;
export function nativeModelForMajor(major: number | null | undefined): ReplayNativeModel { return major === 17 ? PG17_NATIVE_MODEL : CORE_REPLAY_MODEL; }
export type ExtensionStep =
  | { readonly kind: 'extension'; readonly name: string; readonly version: string | null; readonly schema: string | null; readonly conditional: boolean }
  | { readonly kind: 'extension-move'; readonly name: string; readonly schema: string };
type Descriptor = (typeof STOCK_PG17_CATALOG.extensions)[number];
interface Exposure { readonly schema: string | null; readonly types: readonly string[]; }
interface Instance { readonly descriptor: Descriptor; readonly schemas: readonly (string | null)[]; }
export function stockDescriptor(name: string, version: string | null, model: ReplayNativeModel): Descriptor | undefined {
  if (model.id !== PG17_NATIVE_MODEL.id || model.hash !== PG17_NATIVE_MODEL.hash) return undefined;
  return STOCK_PG17_CATALOG.extensions.find(d => d.name === name && (version === null || version === d.defaultVersion));
}
/** Every entry contributes refusal/collision evidence only, never SQL presence. */
export class NativeExtensions {
  private readonly instances = new Map<string, Instance>();
  private readonly exposures: Exposure[] = [];
  private poisoned = false;
  snapshot(): string {
    return JSON.stringify([this.model.id, this.model.hash, this.poisoned, [...this.instances].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, instance]) => [name, instance.descriptor.defaultVersion, instance.schemas]), this.exposures.map(exposure => [exposure.schema, exposure.types])]);
  }
  private readonly spend: () => void;
  private readonly model: ReplayNativeModel;
  constructor(model: ReplayNativeModel, spend: () => void) { this.model = model; this.spend = spend; }
  poison(): void { this.poisoned = true; }
  private expose(schema: string | null, types: readonly string[]): void {
    for (let i = 0; i < types.length; i += 1) this.spend();
    this.exposures.push({ schema, types });
  }
  noteType(name: TableName): void { this.expose(name[0], [name[1]]); }
  collides(name: TableName): boolean {
    for (const exposure of this.exposures) {
      this.spend();
      if (exposure.schema !== null && exposure.schema !== name[0]) continue;
      // pg_type.c makeArrayTypeName: '_' prefix, possible truncation/numeric suffix.
      // The conservative '_' class also covers later automatic array renaming.
      // It is NOT an exact array id and never a to_regclass relation.
      if (exposure.types.length > 0 && (exposure.types.includes(name[1]) || name[1].startsWith('_'))) return true;
    }
    return false;
  }
  private exposureConflict(schema: string | null, types: readonly string[]): boolean {
    if (!types.length) return false;
    for (const exposure of this.exposures) {
      this.spend();
      if (schema !== null && exposure.schema !== null && schema !== exposure.schema) continue;
      if (types.some(name => exposure.types.includes(name))) return true;
    }
    return false;
  }
  apply(step: ExtensionStep, conflict: (schema: string | null, types: readonly string[]) => boolean): boolean {
    this.spend();
    if (this.poisoned) return false;
    if (step.kind === 'extension') {
      const prior = this.instances.get(step.name);
      if (prior !== undefined) {
        if (step.conditional) return true; // no body/schema/version donation
        this.poison(); return false;
      }
      const descriptor = stockDescriptor(step.name, step.version, this.model);
      if (descriptor === undefined) { this.poison(); return false; }
      if (this.exposureConflict(step.schema, descriptor.baseTypes)) { this.poison(); return false; }
      this.expose(step.schema, descriptor.baseTypes);
      if (conflict(step.schema, descriptor.baseTypes)) { this.poison(); return false; }
      this.instances.set(step.name, { descriptor, schemas: [step.schema] });
      return true;
    }
    const prior = this.instances.get(step.name);
    if (prior === undefined || !prior.descriptor.relocatable) { this.poison(); return false; }
    // Keep old AND new possible negative exposure; no success/existence claim.
    // Prior pristine own exposures may overlap during a move; unrelated Source
    // type additions already poisoned the catalog at their declaration site.
    this.expose(step.schema, prior.descriptor.baseTypes);
    if (conflict(step.schema, prior.descriptor.baseTypes)) { this.poison(); return false; }
    this.instances.set(step.name, { descriptor: prior.descriptor, schemas: [...prior.schemas, step.schema] });
    return true;
  }
}
