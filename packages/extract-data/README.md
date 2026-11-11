# @seamline/extract-data

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

Database schema facts at provenance `EXTRACTED`: `DataSource`, `Schema`, `Table`, `Column`, and `Migration` nodes, extracted from static files only: SQL DDL, Drizzle schema modules for Postgres (`pgTable`, `pgSchema`, `pgEnum`), `schema.prisma`, and ordered migration directories (design v3 §6). There is no live database introspection.

## Install

```bash
npm install @seamline/extract-data
```

Requires Node.js 22.13 or later. Most users should not install or import this directly: `seamline extract` in `@seamline/cli` runs it as part of the normal pipeline. Import it directly only if you are building a tool that needs to run this extractor standalone.

## Usage

```js
import { extractData } from '@seamline/extract-data';

// Note the option is `root` here (the other extractors call it `repoRoot`), and the function is async.
const { result, nodes, edges } = await extractData({
  root: process.cwd(),
  repo: 'my-repo',
  runId: 'run-1',
});
console.log(result.status, nodes.length, edges.length);
```

## Configuration

From `seamline.config.json`, this extractor's `options` accept `dataSource`, `defaultSchema`, `dialect`, `skipDirs` and `maxFileBytes`.

A `Table` carries `ormModel` when exactly one ORM source declares it: the Prisma model name, or the name a Drizzle table is bound to. The `DataSource` node carries the `dialect` and the `defaultSchema` an unqualified name resolves in. Both are options of the extractor, in `seamline.config.json` (`public` and `postgres` when unset), and the code extractor binds an unqualified table name in a SQL string to the default schema only. A repository whose tables all live in one other schema (Prisma `multiSchema`, Drizzle `pgSchema('app')`) states it, or none of its raw SQL is bound to those tables:

```json
{ "name": "extract-data", "enabled": true, "options": { "defaultSchema": "app" } }
```

The dialect is not inferred from a Prisma `provider` or a Drizzle driver; set `"dialect": "mysql"` or `"sqlite"` for those repositories, or names are compared by PostgreSQL rules. A Drizzle table declared behind a namespace import (`export const user = pg.pgTable(...)`) is recorded under its binding name like a bare `pgTable`; its column builders (`pg.text('id')`) are not read.

Main exports:

- `DATA_SCOPE`, `EXTRACTOR_NAME`, `EXTRACTOR_VERSION`, `MANIFEST`, `extractData`, and the `ExtractDataOptions`, `ExtractDataOutput` types: the extractor entry point and manifest.
- `canonicalJson`, `canonicalSif` — deterministic serialization.
- `buildDataModelIndex`, `DATA_MODEL_INDEX_VERSION`, `prismaDelegateName`: the data-model index, a canonical JSON document, built from this extractor's nodes, that `@seamline/extract-code-ts` reads to bind a table name in SQL to a `Table` node (its format is documented in `src/data-model-index.ts`). It travels as text, so it can cross a process boundary unchanged.
- `normalizeSqlType`, `TYPE_CATEGORIES`, and the `NormalizedType`, `TypeCategory` types — SQL type normalization.
- `classifyPii`, `PII_CATEGORIES`, and the `PiiCategory`, `PiiVerdict` types — column-name-based PII classification feeding sensitivity defaults.
- `discover`, `discoverSources`, `migrationIdentity`, and the `DiscoveredFile`, `Discovery` types: file discovery and migration identity. `discoverSources` also returns `unread`, the paths it knows are, or may be, a schema source and did not read (see the next section); `ExtractDataOutput.noSchemaSource` is true only when discovery finished, found nothing, and knew of nothing it did not read. That is how `seamline extract` tells "discovery found none" from "a schema source was not read" (both are UNAVAILABLE). It is a statement about discovery, not about the repository.

## What discovery reads, and what it records as unread

Discovery reads `.sql` files, `.prisma` files and TypeScript or JavaScript modules that call Drizzle's `pgTable`, `pgSchema` or `pgEnum`, anywhere under the repository root. It does not enter dependency and tool directories (`node_modules`, `.git`, `.pnpm-store`, `.yarn`, `.venv`, `venv`, `__pycache__`, `.cache`, `.turbo`, `coverage`) or any directory named in the `skipDirs` option.

It also records, in `unread`, every candidate it knows exists and does not read. When nothing at all was read, a non-empty `unread` keeps the data scope UNAVAILABLE and `seamline extract` leaves the data-model index absent (so the code scope is UNAVAILABLE too if it holds a raw-SQL table reference), instead of reading the silence as "no tables". The candidates:

- a file that could not be opened or listed, or is over `maxFileBytes`;
- a symbolic link that is a directory or is named like a candidate file (links are never followed);
- a file whose extension names a schema that no reader here parses: `.ddl`, `.psql`, `.pgsql`, `.mysql`, `.tsql`, `.plsql`, `.cql`, `.hql`, `.dbml`;
- a module that calls a Drizzle constructor other than the three above (`sqliteTable`, `mysqlTable`, `singlestoreTable`, the `*TableCreator` factories including `pgTableCreator`, `mysqlSchema`, `singlestoreSchema`), or imports, re-exports or destructures `pgTable` and the others under another name (`import { pgTable as table }`);
- The same Drizzle probe applies to test and fixture modules, including `.test.` and `.spec.` basenames. A constructor named only in a string, comment or string-valued object label declares no schema and is ignored; an actual declaration using an unparsed constructor is unread regardless of its filename.
- a Prisma schema that `package.json` (`prisma.schema`) or a `prisma.config.*` (`schema`, as a string literal or a `join` of literals) names and that was not read: a missing file, a name that is not `.prisma`, a path in a skipped directory, an empty directory, a path outside the repository (recorded as the file that holds the pointer);
- a `.sql`, `.prisma` or unparsed-extension file under a build output or vendor directory (`build`, `dist`, `out`, `target`, `vendor`, `.next`, `.nuxt`, `.output`, `.svelte-kit`). These are listed, not read. Naming one of them in `skipDirs` says it is not to be looked at.

When `unread` is not empty and tables were read, the run is still a PASS and carries a diagnostic listing the first five paths, so a partial model is not silent.

Discovery does not look for, and `noSchemaSource` stays true over, other ORMs and query builders, database files (`.db`, `.sqlite`), a schema reachable only through a `prisma --schema` script flag, a schema that exists only in a running database, and anything under a dependency directory or a `skipDirs` name. The `no schema source found` diagnostic says so.

A repository whose index is absent downstream falls into one of three cases: `extract-data` did not run (`--only`), it did not see the schema (a source it did not read, FAIL, or a crash), or it read sources that declared no tables (UNAVAILABLE, with no flag).

## SQL dialects

The SQL reader assumes standard-SQL rules (a column is nullable unless it says `NOT NULL`) except where a statement carries evidence that it is ClickHouse DDL. ClickHouse inverts the default: a column is NOT NULL unless its type is `Nullable(T)`, so reading it the standard way would make every plain `session_id UUID` a column that "permits NULL".

A statement is read as ClickHouse only on evidence that does not occur in Postgres, MySQL or SQLite DDL:

- a `CREATE TABLE` whose `ENGINE` is a ClickHouse table engine, spelled as ClickHouse spells it (`MergeTree` and its `Replicated`, `Replacing`, `Summing`, `Aggregating`, `Collapsing` variants, `Log`, `TinyLog`, `Memory`, `Distributed`, `Buffer`, `Kafka`, and similar); `ENGINE=InnoDB`, `MyISAM` or `MEMORY` rules ClickHouse out;
- `ON CLUSTER <name>` after the table name, in `CREATE TABLE` or `ALTER TABLE`;
- a column type built from a ClickHouse-only constructor or name, spelled exactly as ClickHouse spells it: `Nullable(`, `LowCardinality(`, `AggregateFunction(`, `SimpleAggregateFunction(`, `DateTime64(`, `FixedString(`, `Enum8(`, `Map(`, `Tuple(`, `Nested(`, `Decimal64(` and its siblings, `UInt8` to `UInt256`, `Int16` to `Int256`, `Float32`, `Float64`, `IPv4`, `IPv6`, `Date32`, `DateTime('<zone>')`, and `Array(` of any of these or of `String`;
- an `ALTER TABLE` on a table an earlier statement already established as ClickHouse, or whose `ADD COLUMN` / `MODIFY COLUMN` carries the type evidence above, or that adds a projection or a skipping index (`ADD PROJECTION`, `ADD INDEX ... TYPE`).

Evidence is judged per statement and is never inferred from a file name or directory. A statement with no evidence, for example `CREATE TABLE t (id UUID, name String)` or an `ALTER TABLE` on a table the extractor has not seen, is read exactly as it always was; an ambiguous file never produces a ClickHouse reading. Setting the extractor's `dialect` option to `clickhouse` states the dialect explicitly and reads every SQL statement that way.

Under ClickHouse rules:

- **Nullability.** A column is nullable if and only if its type is `Nullable(T)`, bare or inside `LowCardinality(Nullable(T))` (an explicit `NULL` modifier also counts). `Array(Nullable(T))` is not nullable; the array itself cannot be.
- **Types.** The type is normalized without its `Nullable` and `LowCardinality` wrappers, so `LowCardinality(String)` is `text`, `DateTime64(3)` is a timestamp, `UUID` is `uuid`, `UInt32` is an integer and `Decimal(10, 1)` is `numeric(10,1)`. `AggregateFunction(...)`, `SimpleAggregateFunction(...)`, `Map(...)`, `Tuple(...)` and any type this reader does not model get the `other` category and a type that names only the constructor, which every type comparison skips; they are never reported as a mismatch.
- **Defaults.** `DEFAULT`, `MATERIALIZED`, `ALIAS` and `EPHEMERAL` columns are recorded as defaulted with their expression (`MATERIALIZED` and `ALIAS` columns cannot be inserted into at all). A column with no default of its own is also recorded as defaulted, with the placeholder expression `type default`, because omitting it from an `INSERT` stores the type's default value instead of failing; a nullable column with no default stays "no default", as in every other dialect.
- **Provenance.** The `dialect` property of the `Column` and `Table` nodes is `clickhouse` for what was read this way and the extractor's `dialect` option (default `postgres`) for everything else.
- `INDEX` and `PROJECTION` entries in a ClickHouse column list are not columns. A column that declares no type (`doubled ALIAS id`) is not extracted, and says so in the diagnostics, rather than being given a nullability it was never declared with.

Known limits: backtick-quoted identifiers are not read in any dialect, so DDL written with them (such as `SHOW CREATE TABLE` output) yields no columns; `RENAME TABLE` is not applied; and a ClickHouse database name is read as a schema, so an unqualified table in a ClickHouse migration lands in the default schema.

## Writers the column list cannot see

A required column is satisfied when something other than the writer supplies a value. Four props record what the schema sources say about that, so a detector can tell a column that every insert must name from one that a default, a trigger or a client library fills in.

| Prop            | On           | Values                 | Meaning                                                                                                                    |
| --------------- | ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `defaultSite`   | `Column`     | `db`, `client`, `none` | Who supplies the column's default (below). Gate on this prop, not on `hasDefault` (see the next paragraph).                |
| `insertTrigger` | `Table`      | `true`, `false`        | A `BEFORE INSERT` trigger on the table was seen in a `.sql` file that was read.                                            |
| `declarations`  | `Table`      | count                  | Distinct non-migration files that declare the table (`CREATE TABLE`, `pgTable`, a Prisma `model`). Migrations never count. |
| `dynamicDdl`    | `DataSource` | count                  | `DO` blocks and `EXECUTE` statements the replay of the schema could not follow (below).                                    |

**A missing prop is unknown, not zero.** A consumer must read an absent `defaultSite`, `insertTrigger`, `declarations` or `dynamicDdl` as "not known", never as `none`, `false`, `1` or `0`. A graph written by an older run has none of them, and a run that could not read a source leaves off the props that source could contradict. `hasDefault` is not one of them: it keeps saying what was read even when `defaultSite` is withheld, so `hasDefault: false` next to an absent `defaultSite` is not "no default". Consumers gate on `defaultSite`.

- `defaultSite` keeps `db` and omits `client` and `none`. An unread file may add a database default or remove one (an unread migration can `DROP DEFAULT`), so with a file unread even `db` is not certain. It is kept because it is the safe direction: a consumer that treats `db` as "supplied" stays silent about the column. A consumer that needs a certain `db` reads the run's diagnostics for `schema source not read`.
- `declarations` is omitted on every table when a Prisma, Drizzle or non-migration SQL file failed to parse or was not read. A migration cannot change it.
- `insertTrigger` is omitted on every table when a SQL file failed to parse or was not read, and when a trigger hid inside a construct the SQL lexer does not follow (a `DELIMITER` block, a MySQL version comment): what is hidden may have added a trigger or dropped one. A `CREATE TRIGGER` that could not be attributed to a table might be on any table, but it can only add a trigger, so it withholds `false` on the other tables and leaves a trigger already seen `true`. A trigger on a table that the repository declares nowhere is not reported.
- `dynamicDdl` is omitted when any SQL file, migration or not, failed to parse or was not read.

"Not read" covers a `.sql` or `.prisma` file larger than `maxFileBytes` or unreadable, a symlinked `.sql` or `.prisma` file, a symlinked directory, and a directory that could not be listed. Each is listed in the run's diagnostics as `schema source not read (<reason>): <path>`.

- Discovery never follows a symbolic link, because its target may lie outside the repository and every read stays inside it. A symlinked directory (`db/migrations -> /etc`) is therefore reported as `schema source not read (symlink): db/migrations`, like a symlinked file. A directory, or a link to one, might hold a source of any kind, so it withholds every kind. A directory link whose target is inside the repository and not under a skipped directory (`db/current -> v1`) is not reported: the walk reads the target at its own path. A candidate file link is always unread, including TypeScript links to readable internal `.js` targets and ignored `.source`, `.txt` or `.d.ts` targets. Protecting the alias itself prevents a capped or unreadable target from authorizing deletion of facts previously owned by the alias's path. A non-candidate link that points nowhere is not reported; a dangling candidate link stays unread to protect facts previously owned by its path; a link that cannot be resolved for another reason (a loop, no permission) might be a directory and is reported. A symlinked candidate file is reported whatever its target, so `docker/init.sql -> ../db/schema.sql` withholds although the target is read at its real path.
- A directory that cannot be listed is reported even when it has nothing to do with schemas (a database data directory owned by another user, say). To say that a directory, or a link standing in for one, is not a schema source, add its name to the `skipDirs` option: `{ "name": "extract-data", "options": { "skipDirs": ["pgdata"] } }`. A skipped name is never read, never reported and never withholds.
- Every TypeScript or JavaScript source file over `maxFileBytes`, unreadable, or symlinked outside the repository is a possible unread Drizzle schema and withholds `declarations` and `defaultSite` (a Drizzle module says nothing about triggers or dynamic DDL). A bounded prefix cannot prove absence: a schema import may follow a long comment or license preamble, and an unsupported dialect is still a schema. This deliberately withholds facts for oversized ordinary modules and bundles too. Fully read files containing only strings or comments that mention Drizzle remain harmless; the size limit is never lifted to establish that.

`dynamicDdl` counts a `DO` block or an `EXECUTE` (or `EXEC`) statement. In a migration every one counts. In any other `.sql` file, such as a schema snapshot or a seed, only one whose own text contains `CREATE`, `ALTER` or `DROP` counts, so a data load in a `DO` block does not raise the count, and a block that alters a default in a snapshot does. A prepared statement (`PREPARE s FROM @q; EXECUTE s;`) names its DDL in another statement and is counted only in a migration. A function that a migration calls is not followed.

**Triggers and replay order.** MySQL `DEFINER = user@host` account names are consumed as account data, including names that coincide with SQL object keywords. SQLite `CREATE TEMP TRIGGER` and `CREATE TEMPORARY TRIGGER` are read like `CREATE TRIGGER`. `CREATE TRIGGER IF NOT EXISTS` preserves an existing trigger in the same file or an earlier migration. Statements in one file are applied in order. Migrations are applied in migration order, so a `DROP TRIGGER`, `DROP TABLE`, table rename or `CREATE OR REPLACE TRIGGER` in a migration reaches the triggers that migration and the earlier ones created. The other `.sql` files are read in path order, which says nothing about the order they are deployed in, so for them the result is a union: a removal in one file reaches only the triggers created earlier in that same file, never a trigger from another standalone file or from a migration, and a trigger any standalone file creates stays `true`. A rename is followed whichever file made it. The cost is a possible `true` for a trigger a later file really removed, which keeps a consumer silent rather than wrong. For a given table the trigger answer never depends on file names, with one exception that belongs to the table model and not to triggers: a rename across standalone files is applied only if the file that makes it sorts after the file that creates the table, so which of the two names (`a` or `b`) the table is recorded under, and with it the columns and the trigger flag it carries, still depends on path order. Put a table's rename in a migration, or in the same file as its `CREATE TABLE`, to make it order-independent. `DROP TRIGGER name ON table` (Postgres) and `DROP TRIGGER [schema.]name` (MySQL, SQLite, where the name alone identifies the trigger) are both read. A trigger created by a helper call (`SELECT add_audit_trigger('users')`) is not visible, because the reader follows statements, not what a function does when it runs.

`defaultSite` is `db` if any declaration of the column in any source supplies a default the database applies, and `client` only when every declared default is applied by the ORM client, because a raw `INSERT` receives the first kind and not the second. `DROP DEFAULT` removes the database-side default and never a client-side one.

| Source  | `db`                                                                                                                                                                                                            | `client`                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| SQL DDL | `DEFAULT`, `SERIAL` family, `GENERATED ... AS IDENTITY`, `GENERATED ... AS (expr)`, `AUTO_INCREMENT`, `AUTOINCREMENT`, SQLite rowid alias, MySQL implicit `TIMESTAMP` default (below), every ClickHouse default | none                                                             |
| Prisma  | `@default(<constant>)`, `now()`, `autoincrement()`, `dbgenerated(...)`, `sequence()`, a scalar list with no `@default`                                                                                          | `cuid()`, `uuid()`, `ulid()`, `nanoid()`, `@updatedAt`           |
| Drizzle | `.default()`, `.defaultNow()`, `.defaultRandom()`, `serial`, `bigserial`, `.generatedAlwaysAs()`, identity builders                                                                                             | `.$defaultFn()`, `.$default()`, `.$onUpdate()`, `.$onUpdateFn()` |

Two forms are true in one dialect only, so they apply only when the extractor's `dialect` option names it, and are ignored under the default `postgres`, where the same text is an ordinary key or a bare timestamp:

- `sqlite`: a column declared exactly `INTEGER` and made the primary key (in the column or by a table constraint) is the rowid alias, which takes the next rowid when omitted. `INT`, `BIGINT`, `INTEGER UNSIGNED`, `INTEGER(10)`, inline `INTEGER PRIMARY KEY DESC` and a `WITHOUT ROWID` table are not. A table-level `PRIMARY KEY (id DESC)` still makes an exactly `INTEGER` column a rowid alias.
- `mysql` or `mariadb`: the first `TIMESTAMP` column of a `CREATE TABLE`, declared `NOT NULL` with no `DEFAULT` and no `ON UPDATE`, is silently given `DEFAULT CURRENT_TIMESTAMP` when the server's `explicit_defaults_for_timestamp` is off. Treating it as defaulted is the safe reading when the setting is on instead (it is on by default from MySQL 8, where the rule is false). The rule covers `CREATE TABLE` only: a `TIMESTAMP NOT NULL` column added by `ALTER TABLE ... ADD COLUMN` gets no implicit default here.

**Setting the dialect.** In `seamline.config.json`, on the `extract-data` entry of `extractors`: `{ "name": "extract-data", "options": { "dialect": "sqlite" } }`. The values are `postgres` (the default; `postgresql` is an alias and is stored as `postgres`, so the two spellings give identical nodes), `mysql`, `mariadb`, `sqlite` and `clickhouse`, in any case. `mariadb` keeps its own label on the nodes because it names a different database from `mysql`, even though every rule here treats the two alike. Any other value, such as `sqlite3` or `mysql2`, or one that is not a string at all (an array, a number, an object, `null`), is refused: the run reports `FAIL` with an `invalid option: dialect ...` diagnostic and extracts nothing, so a near miss cannot leave the option silently off. Only leaving the option out means the default; `seamline extract` passes the value from the config file through unchanged for this check. Guessing the dialect from the files would invent facts, because `integer PRIMARY KEY` and `timestamp NOT NULL` are required columns in Postgres and nothing in those statements says otherwise. A SQLite or MySQL repository left at the default therefore loses precision, not recall: the rowid-alias key and the implicit `TIMESTAMP` read as `none`, and a later check that a required column is written may report an insert that omits them. Set the option for those repositories.

A Prisma scalar list (`tags String[]`) is optional on create but reads `NOT NULL`, because the field is not marked `?`. Prisma Migrate creates such a column as a nullable array (`"tags" TEXT[]`, with a default only if the model has `@default([])`), so a statement that omits it, raw SQL included, stores `NULL` and succeeds; it is recorded as `db`, not `client`, and `hasDefault` is `true`. That does not depend on a default: `ALTER COLUMN ... DROP DEFAULT`, which Prisma emits when `@default([])` is removed, leaves the column `db`, because dropping a default does not make an array column NOT NULL. Only a migration that declares the column `NOT NULL` (in its `CREATE TABLE` or by `SET NOT NULL`, undone by `DROP NOT NULL`) makes it an ordinary required column, `none` unless something else supplies a default. The `nullable` prop keeps what the model says (`false`); reading a list as nullable would change what `X1` concludes about every list field and needs its own pass. MySQL backtick-quoted identifiers are not read (see the limits above), so `AUTO_INCREMENT` is recognised only in unquoted DDL. `ALTER TABLE ... ALTER COLUMN ... ADD GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY` (how `pg_dump` writes an identity column) is a database default, and `DROP IDENTITY` removes it.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0.

See the [repository README](https://github.com/zylver-solutions/seamline#readme) and [design v3](https://github.com/zylver-solutions/seamline/blob/main/docs/design/v3.md). File names such as `src/data-model-index.ts` above refer to this package's source in the repository. License: Apache-2.0 ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)).
