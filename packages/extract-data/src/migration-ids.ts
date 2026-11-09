/**
 * Canonical names for Migration nodes.
 *
 * A migration's natural key is its version (the file stem, or the directory
 * name in the Prisma layout), so one file per version, the common case, is
 * named by the bare version. Two files can share a version when a repository
 * has more than one migrations directory (`a/migrations/0001_init.sql` and
 * `b/migrations/0001_init.sql`), and then the version alone would give two
 * nodes one id.
 *
 * Qualification is a function of the whole set of migration files, never of
 * the order they were discovered or applied in:
 *
 * 1. A version held by exactly one file keeps the bare version.
 * 2. Every file of a shared version is qualified with its group (the
 *    migrations directory), `0001_init~a~migrations`. Qualifying all members,
 *    not all but the first, means adding a second directory never moves the
 *    bare id onto a different migration: the old id disappears (and is
 *    tombstoned) and two new ids appear.
 * 3. Files that still share a name (the same directory holding
 *    `0001_init.sql` and `0001_init/migration.sql`) are qualified with their
 *    file path instead.
 * 4. Anything left (paths that differ only in characters the alphabet cannot
 *    carry) takes an index in sorted path order.
 *
 * Every name is built by `migrationName`, so it passes `makeNodeId`. The
 * separator is `MIGRATION_QUALIFIER_SEPARATOR`, which no version contains, so a
 * qualified name cannot equal a bare one.
 */

import { migrationName, migrationNamePart } from '@seamline/core';

export interface MigrationSource {
  /** Repo-relative POSIX path of the migration file. */
  readonly path: string;
  /** Raw version: the file stem, or the directory name for a Prisma migration. */
  readonly version: string;
  /** Repo-relative POSIX path of the migrations directory. */
  readonly group: string;
}

export interface MigrationNames {
  /** Canonical name by migration file path. */
  readonly names: ReadonlyMap<string, string>;
  /** Sorted, repo-relative diagnostics. */
  readonly diagnostics: readonly string[];
}

function pathParts(p: string): string[] {
  return p
    .split('/')
    .filter((s) => s.length > 0)
    .map(migrationNamePart);
}

function byPath(a: MigrationSource, b: MigrationSource): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Splits `items` into those whose key is unique in `items` and those whose key is shared. */
function partition(
  items: readonly MigrationSource[],
  key: (m: MigrationSource) => string,
): { readonly unique: MigrationSource[]; readonly shared: MigrationSource[] } {
  const counts = new Map<string, number>();
  for (const m of items) counts.set(key(m), (counts.get(key(m)) ?? 0) + 1);
  const unique: MigrationSource[] = [];
  const shared: MigrationSource[] = [];
  for (const m of items) (counts.get(key(m)) === 1 ? unique : shared).push(m);
  return { unique, shared };
}

export function assignMigrationNames(sources: readonly MigrationSource[]): MigrationNames {
  const diagnostics = new Set<string>();
  const names = new Map<string, string>();

  const sorted = [...sources].sort(byPath);
  for (const m of sorted) {
    if (migrationNamePart(m.version) !== m.version) {
      diagnostics.add(
        `migration version ${JSON.stringify(m.version)} is not a valid canonical name, identified as ${migrationNamePart(m.version)}`,
      );
    }
  }
  const versionOf = (m: MigrationSource): string => migrationNamePart(m.version);

  // Tier 1: the bare version, when no other file has it.
  const bare = partition(sorted, versionOf);
  for (const m of bare.unique) names.set(m.path, migrationName(versionOf(m)));

  // Tier 2: version and group.
  const groupName = (m: MigrationSource): string => migrationName(versionOf(m), pathParts(m.group));
  const byGroup = partition(bare.shared, groupName);
  for (const m of byGroup.unique) names.set(m.path, groupName(m));

  // Tier 3: version and file path.
  const pathName = (m: MigrationSource): string => migrationName(versionOf(m), pathParts(m.path));
  const byFile = partition(byGroup.shared, pathName);
  for (const m of byFile.unique) names.set(m.path, pathName(m));

  // Tier 4: an index within the files that are still indistinguishable. `byFile.shared`
  // keeps the sorted path order, which is the only order available and is content-determined.
  const seen = new Map<string, number>();
  for (const m of byFile.shared) {
    const base = pathName(m);
    const next = (seen.get(base) ?? 0) + 1;
    seen.set(base, next);
    names.set(m.path, `${base}~${next}`);
  }

  // The tiers above hold by construction; this guards the invariant rather than trusting it.
  const owner = new Map<string, string>();
  for (const [path, name] of names) {
    const prior = owner.get(name);
    if (prior !== undefined) {
      throw new Error(`extract-data assigned Migration name ${name} to both ${prior} and ${path}`);
    }
    owner.set(name, path);
  }

  for (const [version, members] of groupBy(bare.shared, versionOf)) {
    const qualified = members.map((m) => names.get(m.path) as string).sort();
    diagnostics.add(
      `migration version collision: ${version} is declared by ${members.length} files, qualified as ${qualified.join(', ')}`,
    );
  }

  return { names, diagnostics: [...diagnostics].sort() };
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(key(item));
    if (list === undefined) out.set(key(item), [item]);
    else list.push(item);
  }
  return out;
}
