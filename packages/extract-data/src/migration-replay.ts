/** Group-local history facts. No final-schema snapshot seeds this catalog. */
import { createHash } from 'node:crypto';
import { makeLineIndex, splitStatements, tokenizeSql } from '@seamline/core/sql';
import type { DiscoveredFile } from './discover.ts';
import type { MigrationOrder } from './migration-order.ts';
import { parseReplayDdl, type AlterAction, type ColumnDefinition, type DdlStep, type ForeignReference, type TableName, type Target } from './migration-replay-sql.ts';
import type { ReplayGuard } from './migration-replay-procedure.ts';
import { completeReplaySource } from './migration-replay-source.ts';
import { ImplicitRelations } from './migration-replay-relations.ts';

type Scalar = string | number | boolean | null;
/** Qualified target, logical step, source line. Arrays avoid ambiguous dotted names. */
export type DeclarationRow = readonly [string, string, string | null, number, number];
export type ReferenceRow = readonly [string, string, string | null, number, number];
export type UnresolvedRow = readonly [string, string, string | null, number, number, string, number, number];
export interface ReplayFacts {
  readonly unavailable: boolean;
  readonly dataSource: Readonly<Record<string, Scalar>>;
  readonly migrations: ReadonlyMap<string, Readonly<Record<string, Scalar>>>;
}
interface Site { readonly migration: string; readonly step: number; readonly line: number; }
interface Observation { readonly target: Target; readonly site: Site; readonly state: Presence | 'skipped'; }
type Presence = 'present' | 'absent' | 'unknown';
interface TableState { readonly presence: Presence; readonly columns: Map<string, Presence>; readonly complete: boolean; readonly view?: true; }
interface MigrationState {
  readonly name: string;
  readonly group: string;
  readonly declarations: DeclarationRow[];
  readonly observations: Map<string, Observation>;
  readonly unknownSteps: number[];
  stepCount: number;
}
const MAX_STEPS = 100_000;
const MAX_REFERENCES = 100_000;
const MAX_TOKENS = 1_000_000;
const key = (target: readonly unknown[]): string => JSON.stringify(target);
const sortRows = <T extends readonly unknown[]>(rows: readonly T[]): T[] => {
  const unique = new Map(rows.map((row) => [key(row), row]));
  return [...unique.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
};

class Catalog {
  readonly sites = new Map<DdlStep | AlterAction, Site>();
  // Lookahead identifies local names only. It never populates point-state.
  readonly localTables = new Set<string>();
  readonly uncertainCreations = new Set<string>();
  readonly nativeChanges = new Set<string>();
  readonly declaredViews = new Set<string>();
  private opaque = false;
  private readonly tables = new Map<string, TableState>();
  private readonly indexes = new Map<string, number>();
  private readonly sequences = new Map<string, Presence>();
  private readonly implicit = new ImplicitRelations();
  private indexGeneration = 0;
  private relationWork = 0;
  readonly creations = new Map<string, Site[]>();
  references = 0;
  state(table: TableName): TableState {
    return this.tables.get(key(table)) ?? { presence: this.opaque ? 'unknown' : 'absent', columns: new Map(), complete: !this.opaque };
  }
  private otherRelation(table: TableName): Presence {
    const sequence = this.sequences.get(key(table));
    if (sequence === 'present') return 'present';
    const index = this.indexes.get(key(table));
    if (index === this.indexGeneration) return 'present';
    if (sequence === 'unknown' || index !== undefined || this.implicit.maybe(table)) return 'unknown';
    return this.opaque ? 'unknown' : 'absent';
  }
  private moveIndexes(schema: string): void {
    // Preserve both possible names when earlier index effects were uncertain.
    // This bounded footprint never turns invalidated existence into absence.
    const moved: string[] = [];
    for (const name of this.indexes.keys()) {
      if (++this.relationWork > MAX_STEPS) throw new RangeError('migration relation work limit');
      const qualified: unknown = JSON.parse(name);
      if (!Array.isArray(qualified) || typeof qualified[1] !== 'string') throw new Error('invalid internal index name');
      moved.push(key([schema, qualified[1]]));
    }
    for (const name of moved) this.indexes.set(name, -1);
  }
  presence(target: Target): Presence {
    const table = this.state([target[0], target[1]]);
    if (table.presence !== 'present' || target[2] === null) return table.presence;
    return table.columns.get(target[2]) ?? (table.complete ? 'absent' : 'unknown');
  }
  observe(target: Target, site: Site, migration: MigrationState): void {
    this.record(target, site, migration, this.presence(target));
  }
  private record(target: Target, site: Site, migration: MigrationState, state: Presence | 'skipped'): void {
    const id = key([...target, site.step, site.line]);
    if (!migration.observations.has(id) && ++this.references > MAX_REFERENCES) throw new RangeError('migration reference limit');
    migration.observations.set(id, { target, site, state });
  }
  private inventory(step: DdlStep, site: Site, migration: MigrationState, lineOf: (pos: number) => number, state: 'unknown' | 'skipped'): void {
    const put = (target: Target, at = site): void => this.record(target, at, migration, state);
    const foreign = (table: TableName, ref: ForeignReference, origin = site): void => {
      const at = { ...origin, line: lineOf(ref.pos) };
      for (const column of ref.columns) put([...table, column], at);
      put([...ref.table, null], at);
      for (const column of ref.remote) put([...ref.table, column], at);
    };
    if (step.kind === 'guard') {
      for (const child of step.body) this.inventory(child, this.sites.get(child) ?? site, migration, lineOf, state);
    } else if (step.kind === 'create') {
      for (const column of step.local) put([...step.table, column]);
      for (const column of step.columns) {
        for (const name of column.local) put([...step.table, name], { ...site, line: lineOf(column.pos) });
        for (const ref of column.references) foreign(step.table, ref);
      }
      for (const ref of step.foreign) foreign(step.table, ref);
    } else if (step.kind === 'index') {
      put([...step.table, null]);
      for (const column of step.columns) put([...step.table, column]);
    } else if (step.kind === 'drop') {
      for (const table of step.tables) put([...table, null]);
    } else if (step.kind === 'alter') {
      put([...step.table, null]);
      for (const action of step.actions) {
        const at = this.sites.get(action) ?? site;
        if (action.kind === 'drop') put([...step.table, action.column], at);
        else if (action.kind === 'reference') for (const column of action.columns) put([...step.table, column], at);
        else if (action.kind === 'foreign') foreign(step.table, action.reference, at);
        else if (action.kind === 'add') {
          for (const name of action.column.local) put([...step.table, name], { ...at, line: lineOf(action.column.pos) });
          for (const ref of action.column.references) foreign(step.table, ref, at);
        }
        else if (action.kind === 'rename-column') put([...step.table, action.from], at);
      }
    }
  }
  declare(target: Target, site: Site, migration: MigrationState): void {
    const values = this.creations.get(key(target)) ?? [];
    values.push(site); this.creations.set(key(target), values);
    migration.declarations.push([...target, site.step, site.line]);
  }
  unknown(): void { this.opaque = true; this.tables.clear(); this.indexes.clear(); this.sequences.clear(); }
  private foreign(table: TableName, reference: ForeignReference, site: Site, migration: MigrationState, lineOf: (pos: number) => number): void {
    const at = { ...site, line: lineOf(reference.pos) };
    for (const name of reference.columns) this.observe([...table, name], at, migration);
    this.observe([...reference.table, null], at, migration);
    for (const name of reference.remote) this.observe([...reference.table, name], at, migration);
  }
  private added(table: TableName, column: ColumnDefinition, site: Site, migration: MigrationState, lineOf: (pos: number) => number, recordDeclaration = true): void {
    const at = { ...site, line: lineOf(column.pos) };
    if (recordDeclaration) this.declare([...table, column.name], at, migration);
    this.implicit.note(table[0], column.implicit);
    for (const name of column.local) this.observe([...table, name], at, migration);
    for (const reference of column.references) this.foreign(table, reference, site, migration, lineOf);
  }
  private condition(condition: ReplayGuard): boolean | null {
    if (condition.kind === 'unknown') return null;
    if (condition.kind === 'table') {
      // An undeclared external relation may exist. Empty local history is not
      // evidence that to_regclass on that relation returns NULL.
      const other = this.otherRelation(condition.table);
      const table = this.state(condition.table).presence;
      if (table === 'present' || other === 'present') return condition.exists;
      if (other === 'unknown') return null;
      if (!this.opaque && !this.tables.has(key(condition.table)) && !this.localTables.has(key(condition.table))) return null;
      return table === 'unknown' ? null : !condition.exists;
    }
    const answers = condition.terms.map((term) => this.condition(term));
    return answers.includes(false) ? false : answers.includes(null) ? null : true;
  }
  apply(step: DdlStep, site: Site, migration: MigrationState, lineOf: (pos: number) => number): void {
    // Writes through views can rewrite to catalog metadata or invoke rules.
    // A checked target spelling alone cannot certify a row-only footprint.
    if (step.kind === 'rows' && step.targets.some((name) => {
      const current = this.tables.get(key(name));
      return current?.presence !== 'present' || current.view === true || this.declaredViews.has(key(name));
    })) {
      migration.unknownSteps.push(site.step); this.unknown(); return;
    }
    if (step.nativeCalls?.some((name) => this.nativeChanges.has(name))) {
      migration.unknownSteps.push(site.step); this.unknown(); return;
    }
    if (step.kind === 'guard') {
      const answer = this.condition(step.condition);
      if (answer === false) { this.inventory(step, site, migration, lineOf, 'skipped'); return; }
      const prior = new Map(migration.observations);
      for (const child of step.body) this.apply(child, this.sites.get(child) ?? site, migration, lineOf);
      if (answer === null) for (const [id, observation] of migration.observations) {
        if (prior.get(id) !== observation && observation.state === 'absent') migration.observations.set(id, { ...observation, state: 'unknown' });
      }
      return;
    }

    if (step.kind === 'unknown') { migration.unknownSteps.push(site.step); this.unknown(); return; }
    if (step.kind === 'none' || step.kind === 'rows') return;
    if (step.kind === 'view') {
      const prior = this.state(step.table);
      if (prior.presence === 'present') {
        // Replacement cannot turn a real table into a view. For a view,
        // existing columns survive either a valid replacement or its refusal;
        // new projection names need type/shape evidence this subset lacks.
        if (prior.view === true && step.replace) {
          this.uncertainCreations.add(key(step.table));
          this.tables.set(key(step.table), { ...prior, columns: new Map(prior.columns), complete: false });
        }
        return;
      }
      const other = this.otherRelation(step.table);
      if (other === 'present') return;
      if (prior.presence === 'unknown' || other === 'unknown' || step.columns === null) {
        this.uncertainCreations.add(key(step.table));
        this.tables.set(key(step.table), { presence: 'unknown', columns: new Map(), complete: false, view: true }); return;
      }
      this.tables.set(key(step.table), { presence: 'present', columns: new Map(step.columns.map((name) => [name, 'present' as const])), complete: true, view: true });
      this.declare([...step.table, null], site, migration);
      for (const column of step.columns) this.declare([...step.table, column], site, migration);
      return;
    }
    if (step.kind === 'relation') {
      const table = this.state(step.name).presence;
      const other = this.otherRelation(step.name);
      if (table === 'present' || other === 'present') {
        if (!step.conditional) migration.unknownSteps.push(site.step);
        return;
      }
      this.sequences.set(key(step.name), table === 'unknown' || other === 'unknown' ? 'unknown' : 'present');
      return;
    }
    this.inventory(step, site, migration, lineOf, 'unknown');
    if (step.kind === 'create') {
      const prior = this.state(step.table);
      const other = this.otherRelation(step.table);
      if (step.conditional && (prior.presence === 'present' || other === 'present')) { this.inventory(step, site, migration, lineOf, 'skipped'); return; }
      if (prior.presence !== 'absent' || other !== 'absent') {
        migration.unknownSteps.push(site.step);
        this.tables.set(key(step.table), { presence: 'unknown', columns: new Map(), complete: false }); return;
      }
      const columns = new Map(step.columns.map((column) => [column.name, 'present' as const]));
      this.indexGeneration += 1;
      this.tables.set(key(step.table), { presence: 'present', columns, complete: true });
      this.implicit.note(step.table[0], step.implicit);
      this.declare([...step.table, null], site, migration);
      // All columns are declared before self-references are resolved.
      for (const column of step.columns) this.added(step.table, column, site, migration, lineOf);
      for (const column of step.local) this.observe([...step.table, column], site, migration);
      for (const reference of step.foreign) this.foreign(step.table, reference, site, migration, lineOf);
      return;
    }
    if (step.kind === 'drop') {
      this.indexGeneration += 1;
      for (const table of step.tables) {
        if (this.state(table).view === true) { migration.unknownSteps.push(site.step); continue; }
        if (!step.conditional || this.state(table).presence === 'present') this.observe([...table, null], site, migration);
        else if (this.state(table).presence === 'absent') this.record([...table, null], site, migration, 'skipped');
        this.tables.set(key(table), { presence: 'absent', columns: new Map(), complete: true });
      }
      return;
    }
    if (step.kind === 'index') {
      const index = key([step.table[0], step.name]);
      const exists = this.otherRelation([step.table[0], step.name]) === 'present' || this.state([step.table[0], step.name]).presence === 'present';
      if (step.conditional) {
        // Only positive relation-existence evidence can skip a body. An
        // untracked external index is not proven absent by a table catalog.
        if (exists) this.inventory(step, site, migration, lineOf, 'skipped');
        else this.indexes.set(index, -1);
        return;
      }
      if (exists) return;
      this.observe([...step.table, null], site, migration);
      for (const column of step.columns) this.observe([...step.table, column], site, migration);
      const known = this.state(step.table).presence === 'present' && step.columns.every((column) => this.presence([...step.table, column]) === 'present');
      this.indexes.set(index, known ? this.indexGeneration : -1);
      return;
    }
    // Dropped columns/tables and schema moves can invalidate an index name.
    // Withhold conditional index bodies after any table mutation until another
    // positive declaration establishes that name. Never infer index absence.
    if (step.actions.some((action) => ['add', 'drop', 'rename-column', 'rename-table', 'set-schema'].includes(action.kind))) this.indexGeneration += 1;
    for (const action of step.actions) if (action.kind === 'set-schema') {
      this.moveIndexes(action.to); this.implicit.moveSchema(step.table[0], action.to);
    }
    let table = step.table;
    let current = this.state(table);
    const external = !this.opaque && !this.tables.has(key(table)) && !this.localTables.has(key(table));
    if (step.conditional && current.presence === 'absent' && !external) { this.inventory(step, site, migration, lineOf, 'skipped'); return; }
    this.observe([...table, null], site, migration);
    if (current.presence !== 'present') {
      // A rename of an external or uncertain source may introduce the
      // destination. Its bounded footprint cannot leave that name absent.
      if (external || current.presence === 'unknown') for (const action of step.actions) {
        const destination: TableName | undefined = action.kind === 'rename-table' ? [table[0], action.to] : action.kind === 'set-schema' ? [action.to, table[1]] : undefined;
        if (destination !== undefined) {
          this.uncertainCreations.add(key(destination));
          this.tables.set(key(destination), { presence: 'unknown', columns: new Map(), complete: false, view: true });
        }
      }
      return;
    }
    if (current.view === true && step.actions.some((action) => action.kind === 'add' || action.kind === 'drop' || action.kind === 'foreign')) {
      migration.unknownSteps.push(site.step); return;
    }
    // Homogeneous ADD lists establish their columns together before checking
    // cross-column references. No DROP/rename or mixed phase is admitted here.
    const staged = new Set<ColumnDefinition>();
    if (step.actions.length > 1 && step.actions.every((a) => a.kind === 'add' && (this.presence([...table, a.column.name]) === 'absent' || (a.conditional && this.presence([...table, a.column.name]) === 'present')))) {
      for (const action of step.actions) if (action.kind === 'add' && this.presence([...table, action.column.name]) === 'absent') staged.add(action.column);
      for (const column of staged) {
        current.columns.set(column.name, 'present');
        this.declare([...table, column.name], { ...site, line: lineOf(column.pos) }, migration);
      }
    }
    for (const action of step.actions) {
      const at = this.sites.get(action) ?? site;
      if (action.kind === 'add') {
        if (staged.has(action.column)) { this.added(table, action.column, at, migration, lineOf, false); continue; }
        const presence = this.presence([...table, action.column.name]);
        if (action.conditional && presence === 'present') {
          for (const name of action.column.local) this.record([...table, name], { ...at, line: lineOf(action.column.pos) }, migration, 'skipped');
          for (const ref of action.column.references) {
            const position = { ...at, line: lineOf(ref.pos) };
            for (const name of ref.columns) this.record([...table, name], position, migration, 'skipped');
            this.record([...ref.table, null], position, migration, 'skipped');
            for (const name of ref.remote) this.record([...ref.table, name], position, migration, 'skipped');
          }
          continue;
        }
        if (presence !== 'absent') {
          migration.unknownSteps.push(at.step);
          current.columns.set(action.column.name, 'unknown'); continue;
        }
        current.columns.set(action.column.name, 'present');
        this.added(table, action.column, at, migration, lineOf);
      } else if (action.kind === 'drop') {
        if (!action.conditional || this.presence([...table, action.column]) === 'present') this.observe([...table, action.column], at, migration);
        else if (this.presence([...table, action.column]) === 'absent') this.record([...table, action.column], at, migration, 'skipped');
        current.columns.set(action.column, 'absent');
      } else if (action.kind === 'reference') {
        this.implicit.note(table[0], action.implicit ?? []);
        for (const name of action.columns) this.observe([...table, name], at, migration);
      } else if (action.kind === 'foreign') this.foreign(table, action.reference, at, migration, lineOf);
      else if (action.kind === 'rename-column') {
        this.observe([...table, action.from], at, migration);
        const prior = this.presence([...table, action.from]);
        const destination = this.presence([...table, action.to]);
        if (prior === 'present' && destination === 'absent') {
          current.columns.set(action.from, 'absent'); current.columns.set(action.to, 'present');
          this.declare([...table, action.to], at, migration);
        } else {
          migration.unknownSteps.push(at.step);
          current.columns.set(action.from, 'unknown'); current.columns.set(action.to, 'unknown');
        }
      } else if (action.kind === 'rename-table' || action.kind === 'set-schema') {
        const next: TableName = action.kind === 'rename-table' ? [table[0], action.to] : [action.to, table[1]];
        const destination = this.state(next);
        if (destination.presence === 'absent' && this.otherRelation(next) === 'absent') {
          this.tables.set(key(table), { presence: 'absent', columns: new Map(), complete: true });
          this.tables.set(key(next), current);
          this.declare([...next, null], at, migration);
          for (const [column, presence] of current.columns) if (presence === 'present') this.declare([...next, column], at, migration);
        } else {
          migration.unknownSteps.push(at.step);
          this.tables.set(key(table), { presence: 'unknown', columns: new Map(), complete: false });
          this.tables.set(key(next), { presence: 'unknown', columns: new Map(), complete: false });
        }
        table = next; current = this.state(next);
      }
    }
  }
}

function tokenCount(tokens: readonly import('@seamline/core/sql').Tok[], depth = 0): number {
  if (depth > 64) throw new RangeError('migration token depth limit');
  let total = 0;
  for (const token of tokens) {
    if (token.unterminated) throw new RangeError('incomplete SQL token');
    total += 1 + (token.items.length === 0 ? 0 : tokenCount(token.items, depth + 1));
    if (total > MAX_TOKENS) throw new RangeError('migration token count limit');
  }
  return total;
}

/** Output is versioned scalar evidence. An incomplete inventory never has an empty successful proof. */
export function replayMigrations(
  files: readonly DiscoveredFile[],
  orders: readonly MigrationOrder[],
  names: ReadonlyMap<string, string>,
  options: { readonly epoch: string; readonly schema: string; readonly dialect: string; readonly unread: readonly string[] },
): ReplayFacts {
  const output = new Map<string, Readonly<Record<string, Scalar>>>();
  const groups = new Map<string, DiscoveredFile[]>();
  for (const file of files) if (file.kind === 'sql-migration') {
    const members = groups.get(file.group) ?? []; members.push(file); groups.set(file.group, members);
  }
  const groupRows: unknown[][] = [];
  let unavailable = false;
  // Until unread paths are proven irrelevant to a group, withhold all absence
  // evidence. This is conservative; it does not turn a partial read into zero.
  const inventoryRead = options.unread.length === 0;
  for (const [group, members] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const order = orders.find((candidate) => candidate.group === group);
    let complete = inventoryRead && order?.state === 'known' && options.dialect === 'postgres';
    let reason = !inventoryRead ? 'unread source candidates' : order?.state !== 'known' ? (order?.reason ?? 'missing ordering policy') : options.dialect !== 'postgres' ? 'unsupported replay dialect' : '';
    if (complete) {
      const sorted = [...members].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      if (sorted.some((file, index) => members[index]?.path !== file.path)) { complete = false; reason = 'replay order disagrees with the recorded policy'; }
    }
    const inputHash = createHash('sha256').update(JSON.stringify([
      1, group, options.schema, options.dialect,
      order?.state === 'known' ? [order.policy, order.configHash] : null,
      [...options.unread].sort(),
      members.map((file) => [file.path, createHash('sha256').update(file.text).digest('hex')]),
    ])).digest('hex');
    const catalog = new Catalog();
    const migrations: MigrationState[] = [];
    let steps = 0;
    let tokens = 0;
    try {
      const programs: { readonly migration: MigrationState; readonly statements: readonly DdlStep[]; readonly lineOf: (pos: number) => number }[] = [];
      for (const file of members) {
        const name = names.get(file.path);
        if (name === undefined) throw new Error('migration identity missing');
        const lexed = tokenizeSql(file.text);
        if (!completeReplaySource(file.text, lexed)) throw new RangeError('incomplete migration source coverage');
        tokens += tokenCount(lexed);
        if (tokens > MAX_TOKENS) throw new RangeError('migration group token limit');
        const statements = splitStatements(lexed);
        const migration: MigrationState = { name, group, declarations: [], observations: new Map(), unknownSteps: [], stepCount: statements.length };
        migrations.push(migration);
        if (!complete) {
          steps += statements.length;
          if (steps > MAX_STEPS) throw new RangeError('migration step limit');
          continue;
        }
        const lineOf = makeLineIndex(file.text);
        const parsed = statements.map((statement) => parseReplayDdl(statement.toks, options.schema));
        for (const step of parsed) if (step.kind === 'create' || step.kind === 'view') catalog.localTables.add(key(step.table));
        let ordinal = 0;
        const locate = (step: DdlStep, parentPos: number, depth: number): void => {
          if (++steps > MAX_STEPS || depth > 64) throw new RangeError('migration step limit');
          const position = step.pos ?? parentPos;
          // A declared native-name change anywhere in this bounded group
          // withholds call semantics; it never supplies a positive binding.
          for (const name of step.routineChanges ?? []) catalog.nativeChanges.add(name[1]);
          if (step.kind === 'view') catalog.declaredViews.add(key(step.table));
          // Catalog reads have native semantics only while their source names
          // are untouched by declared relation changes in this group.
          const relations = step.kind === 'drop' ? step.tables : 'table' in step ? [step.table] : step.kind === 'relation' ? [step.name] : [];
          for (const name of relations) if (name[0] === 'pg_catalog') catalog.nativeChanges.add('pg_catalog.' + name[1]);
          catalog.sites.set(step, { migration: name, step: ordinal++, line: lineOf(position) });
          if (step.kind === 'alter') for (const [index, action] of step.actions.entries()) {
            if (index > 0 && ++steps > MAX_STEPS) throw new RangeError('migration step limit');
            catalog.sites.set(action, { migration: name, step: index === 0 ? ordinal - 1 : ordinal++, line: lineOf(action.pos ?? position) });
          }
          if (step.kind === 'guard') for (const child of step.body) locate(child, position, depth + 1);
        };
        for (const step of parsed) locate(step, 0, 0);
        migration.stepCount = ordinal;
        programs.push({ migration, statements: parsed, lineOf });
      }
      for (const program of programs) {
        for (const step of program.statements) {
          catalog.apply(step, catalog.sites.get(step)!, program.migration, program.lineOf);
        }
      }
    } catch {
      complete = false; reason = 'replay analysis failed or reached a resource limit';
    }
    if ((order?.state === 'unknown' && order.candidate) || (order?.state === 'known' && (!complete || migrations.some((migration) => migration.unknownSteps.length > 0)))) unavailable = true;
    const referencesComplete = complete && migrations.every((migration) => migration.unknownSteps.length === 0);
    const referenceReason = complete && !referencesComplete ? 'unsupported or uncertain membership step' : reason;
    const groupNames = members.map((file) => names.get(file.path)).filter((name): name is string => name !== undefined).sort();
    groupRows.push([group, order?.state === 'known' ? order.policy : null, order?.state === 'known' ? order.configHash : null, referencesComplete, groupNames, referenceReason, inputHash]);
    const ordinal = new Map(migrations.map((migration, index) => [migration.name, index]));
    for (const file of members) {
      const name = names.get(file.path);
      if (name === undefined) continue;
      const migration = migrations.find((candidate) => candidate.name === name);
      const unresolved: UnresolvedRow[] = [];
      const external: ReferenceRow[] = [];
      const unknown: ReferenceRow[] = [];
      const valid: ReferenceRow[] = [];
      const skipped: ReferenceRow[] = [];
      if (complete && migration !== undefined) for (const reference of migration.observations.values()) {
        const row: ReferenceRow = [...reference.target, reference.site.step, reference.site.line];
        if (reference.state === 'present') valid.push(row);
        else if (reference.state === 'unknown') unknown.push(row);
        else if (reference.state === 'skipped') skipped.push(row);
        else {
          const witnesses = catalog.creations.get(key(reference.target)) ?? [];
          const currentOrdinal = ordinal.get(reference.site.migration) ?? -1;
          const witness = witnesses.find((candidate) => {
            const candidateOrdinal = ordinal.get(candidate.migration) ?? -1;
            return candidateOrdinal > currentOrdinal || (candidateOrdinal === currentOrdinal && candidate.step > reference.site.step);
          }) ?? witnesses[0];
          if (witness === undefined && catalog.uncertainCreations.has(key([reference.target[0], reference.target[1]]))) unknown.push(row);
          else if (witness === undefined) external.push(row);
          else unresolved.push([...row, witness.migration, witness.step, witness.line]);
        }
      }
      const declarations = complete && migration !== undefined ? sortRows(migration.declarations) : [];
      const unknownSteps = [...new Set(migration?.unknownSteps ?? [])].sort((a, b) => a - b);
      const unresolvedRows = sortRows(unresolved), externalRows = sortRows(external), unknownRows = sortRows(unknown), validRows = sortRows(valid), skippedRows = sortRows(skipped);
      output.set(name, {
        replayVersion: 1,
        replayEpoch: options.epoch,
        replayInputHash: inputHash,
        replayGroup: group,
        replayOrdinal: ordinal.get(name) ?? -1,
        replayInventoryComplete: referencesComplete,
        replayOrderPolicy: order?.state === 'known' ? order.policy : 'unknown',
        replayConfigHash: order?.state === 'known' ? order.configHash : '',
        replayStepCount: migration?.stepCount ?? 0,
        replayUnknownStepCount: unknownSteps.length,
        replayUnknownSteps: JSON.stringify(unknownSteps),
        replayDeclarations: JSON.stringify(declarations),
        replayDeclarationCount: declarations.length,
        unresolvedRefs: JSON.stringify(unresolvedRows), unresolvedRefCount: unresolvedRows.length,
        externalRefs: JSON.stringify(externalRows), externalRefCount: externalRows.length,
        unknownRefs: JSON.stringify(unknownRows), unknownRefCount: unknownRows.length,
        validRefs: JSON.stringify(validRows), validRefCount: validRows.length,
        skippedRefs: JSON.stringify(skippedRows), skippedRefCount: skippedRows.length,
        replayReferenceCount: unresolvedRows.length + externalRows.length + unknownRows.length + validRows.length + skippedRows.length,
      });
    }
  }
  const snapshot = createHash('sha256').update(JSON.stringify([
    1, options.schema, options.dialect, [...options.unread].sort(), groupRows, unavailable,
  ])).update('\n');
  // Inputs alone do not bind a corrected analysis under a reused run id.
  // Stamp the complete certificate bodies too, so an interrupted write cannot
  // mix a current root with an older interpretation of those same inputs.
  // Stream records rather than constructing another whole-graph JSON value.
  for (const [name, body] of [...output].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const fields = Object.keys(body).filter((field) => field !== 'replayEpoch' && field !== 'replaySnapshotHash').sort();
    snapshot.update(JSON.stringify([name, fields.map((field) => [field, body[field]])])).update('\n');
  }
  const snapshotHash = snapshot.digest('hex');
  for (const [name, props] of output) output.set(name, { ...props, replaySnapshotHash: snapshotHash });
  return {
    unavailable,
    dataSource: { replayVersion: 1, replayEpoch: options.epoch, replaySnapshotHash: snapshotHash, replayMembershipComplete: !unavailable, replayInventoryComplete: inventoryRead, replayGroups: JSON.stringify(groupRows), replayGroupCount: groupRows.length },
    migrations: output,
  };
}
