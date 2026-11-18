/** Whole-group exclusion footprint. Never a declaration or point-state seed. */
import { ImplicitRelations } from './migration-replay-relations.ts';
import type { DdlStep, TableName } from './migration-replay-sql.ts';

const MAX_WORK = 100_000;
const key = (name: TableName): string => JSON.stringify(name);

export class RowExposure {
  private readonly names = new Set<string>();
  private readonly implicit = new ImplicitRelations();
  private readonly schemaSources = new Map<string, Set<string>>();
  private work = 0;
  private spend(): void {
    if (++this.work > MAX_WORK) throw new RangeError('migration row footprint limit');
  }
  /** Called for every located step, including every guarded child. */
  note(step: DdlStep): void {
    const note = (name: TableName): void => { this.spend(); this.names.add(key(name)); };
    if (step.kind === 'drop') for (const name of step.tables) note(name);
    else if (step.kind === 'relation') note(step.name);
    else if ('table' in step) {
      let name = step.table;
      note(name);
      if (step.kind === 'index') note([name[0], step.name]);
      if (step.kind === 'create') {
        this.implicit.note(name[0], step.implicit);
        for (const column of step.columns) this.implicit.note(name[0], column.implicit);
      }
      if (step.kind === 'alter') for (const action of step.actions) {
        if (action.kind === 'add') this.implicit.note(name[0], action.column.implicit);
        if (action.kind === 'reference') this.implicit.note(name[0], action.implicit ?? []);
        if (action.kind === 'rename-table') name = [name[0], action.to];
        else if (action.kind === 'set-schema') {
          const sources = this.schemaSources.get(action.to) ?? new Set<string>();
          sources.add(name[0]); this.schemaSources.set(action.to, sources);
          name = [action.to, name[1]];
        }
        note(name);
      }
    }
  }
  has(name: TableName): boolean {
    this.spend();
    if (this.names.has(key(name))) return true;
    // Conservatively carry implicit relation families across every possible
    // schema move, regardless of statement order. Cycles terminate; work is
    // charged. This is exclusion only, not a claim that any move succeeded.
    const pending = [name[0]], seen = new Set<string>();
    for (let i = 0; i < pending.length; i += 1) {
      const schema = pending[i]!;
      if (seen.has(schema)) continue;
      seen.add(schema);
      if (this.names.has(key([schema, name[1]])) || this.implicit.maybe([schema, name[1]])) return true;
      for (const source of this.schemaSources.get(schema) ?? []) {
        this.spend();
        if (!seen.has(source)) pending.push(source);
      }
    }
    return false;
  }
}
