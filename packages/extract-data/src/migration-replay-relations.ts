/** Uncertainty footprints for implicit relations. Never positive object facts. */
import type { ImplicitRelation, TableName } from './migration-replay-sql.ts';

const MAX_WORK = 100_000;
export class ImplicitRelations {
  private readonly named = new Map<string, Set<string>>();
  private readonly generated = new Map<string, Set<string>>();
  private readonly unknownSchemas = new Set<string>();
  private work = 0;
  private chars = 0;
  private spend(): void { if (++this.work > MAX_WORK) throw new RangeError('implicit relation footprint limit'); }
  note(schema: string, effects: readonly ImplicitRelation[]): void {
    for (const effect of effects) {
      this.spend();
      if (effect.kind === 'named') {
        // A long explicit identifier may be truncated by the server. This
        // subset cannot assert absence anywhere in that relation namespace.
        if (Buffer.byteLength(effect.name) > 63) this.unknownSchemas.add(schema);
        const names = this.named.get(schema) ?? new Set<string>();
        names.add(effect.name); this.named.set(schema, names);
      } else {
        const labels = this.generated.get(schema) ?? new Set<string>();
        labels.add(effect.label); this.generated.set(schema, labels);
      }
    }
  }
  maybe([schema, name]: TableName): boolean {
    this.chars += schema.length + name.length;
    if (this.chars > 64_000_000) throw new RangeError('implicit relation name work limit');
    if (this.unknownSchemas.has(schema) || this.named.get(schema)?.has(name)) return true;
    const labels = this.generated.get(schema);
    if (labels === undefined) return false;
    const suffix = name.slice(name.lastIndexOf('_') + 1);
    if (suffix.length === name.length) return false;
    // PostgreSQL preserves the generator's label when truncating name parts
    // and appends decimal digits on collisions. Match a broad family only to
    // withhold absence. It supplies neither an identity nor a finding witness.
    for (const label of labels) if (suffix.startsWith(label) && /^[0-9]*$/.test(suffix.slice(label.length))) return true;
    return false;
  }
  moveSchema(from: string, to: string): void {
    if (this.unknownSchemas.has(from)) this.unknownSchemas.add(to);
    for (const name of [...(this.named.get(from) ?? [])]) { this.spend(); this.note(to, [{ kind: 'named', name }]); }
    for (const label of [...(this.generated.get(from) ?? [])]) {
      this.spend();
      const labels = this.generated.get(to) ?? new Set<string>(); labels.add(label); this.generated.set(to, labels);
    }
  }
}
