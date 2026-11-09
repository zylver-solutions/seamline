/**
 * Shared state for the two extraction passes.
 *
 * The passes are split because relationship edges cannot be resolved while
 * declarations are still being discovered: a `CALLS` in the first file walked
 * routinely targets a symbol declared in the last. Pass one populates `decls`;
 * pass two reads it. Anything a pass-two lookup misses is a real dangling edge,
 * not a traversal-order artefact, which is what makes the collector's rejection
 * list meaningful.
 */

import type { NodeId, NodeKind } from '@seamline/ontology';
import { Node } from 'ts-morph';
import type { Collector } from './collector.ts';
import type { ModuleInfo, ModuleResolver } from './modules.ts';
import type { OrmNames, TableBinding } from './data-model.ts';
import type { QueryFolds } from './queries.ts';
import type { SqlTableName } from './sql.ts';

export interface DeclRecord {
  readonly id: NodeId;
  /** The declaration node itself, so pass two does not re-walk the AST to find it. */
  readonly declaration: Node;
  readonly canonicalName: string;
  readonly kind: NodeKind;
  /** Repo-relative POSIX path of the declaring file. */
  readonly file: string;
}

export interface FileRecord {
  /** Repo-relative POSIX path. */
  readonly rel: string;
  readonly id: NodeId;
  readonly module: ModuleInfo;
  readonly moduleId: NodeId;
}

/**
 * What every file-level `IMPORTS` between two modules reduces to. Many files
 * collapse into one module edge, so the winner is chosen by a fixed rule in
 * `relations.ts` rather than by whichever file happened to be walked last.
 */
export interface ModuleImport {
  readonly src: NodeId;
  readonly dst: NodeId;
  /** Repo-relative POSIX path of the importing file this edge is attributed to. */
  readonly srcFile: string;
  /** Repo-relative POSIX path of the imported file this edge is attributed to. */
  readonly dstFile: string;
  readonly specifier: string;
}

/** A place in the source: repo-relative POSIX path and 1-based line. */
export interface SourceSite {
  readonly file: string;
  readonly line: number;
}

/**
 * Why a write was counted in `untracedWriteCalls` (design `docs/design/real-world-inputs.md`,
 * section 5.2): rule (1) `unsafe-raw-call`, rule (2) `unattributed-statement`, rule (2b)
 * `concatenated-statement`, rule (3) `spliced-fragment`, rule (4) `computed-delegate`, rule (5)
 * `query-builder-call`.
 */
export type UntracedRule =
  | 'unsafe-raw-call'
  | 'unattributed-statement'
  | 'concatenated-statement'
  | 'spliced-fragment'
  | 'computed-delegate'
  | 'query-builder-call';

/**
 * What a counted place writes with, as far as its text says: `insert` (an INSERT, a REPLACE INTO,
 * an upsert, a `create`), `update`, `delete` (a TRUNCATE included), or `unknown` (the verb is a
 * value, a name, a `MERGE`, or not in the text). A place whose text has several verbs takes
 * `insert` before `unknown` before `update` before `delete`, so a gate on insert-class places that
 * counts `insert` and `unknown` never loses one. Only the diagnostics carry it; the counted prop does not.
 */
export type UntracedVerb = 'insert' | 'update' | 'delete' | 'unknown';

export interface UntracedSite extends SourceSite {
  readonly rule: UntracedRule;
  readonly verb: UntracedVerb;
}

/** The first place a table was found to have a writer that no edge records, and what kind of place it was. */
export interface UnknownWriter extends SourceSite {
  /** `ambiguous` and `elsewhere` are raw-SQL names the index cannot settle; `orm-write` is an ORM-shaped call. */
  readonly why: 'ambiguous' | 'elsewhere' | 'orm-write';
}

/**
 * What the run noticed about writes it could not turn into an edge. Counted once per place:
 * the key of `untraced` and `hooks` is the file and the offset of the node, so a place that two
 * rules see is one place.
 */
export interface WriteGuards {
  readonly untraced: Map<string, UntracedSite>;
  readonly hooks: Map<string, SourceSite>;
  /** SQL expression sites that may change schema facts outside the data extractor's replay. */
  readonly runtimeDdl: Map<string, SourceSite>;
  /**
   * `[start, end)` offsets, in the file being scanned, of the argument of a call that rule (1)
   * counted. A literal inside it is part of that one call and is not counted again.
   */
  excluded: Array<readonly [number, number]>;
}

export interface Ctx {
  readonly repo: string;
  readonly repoRoot: string;
  readonly collector: Collector;
  readonly modules: ModuleResolver;
  /** Keyed by ts-morph's absolute file path. Never serialized. */
  readonly files: Map<string, FileRecord>;
  /** Keyed by `declKey`. */
  readonly decls: Map<string, DeclRecord>;
  readonly diagnostics: string[];
  /** The `Table` id for a reference that no declared table matches: `public.<table>` unless qualified. */
  readonly tableId: (ref: Pick<SqlTableName, 'table' | 'schema'>) => NodeId;
  /** Binds a reference to a declared table; `null` when the run has no data-model index. */
  readonly bindTable: ((ref: SqlTableName) => TableBinding) | null;
  /**
   * Physical names of tables something may write that no edge records, each with the first place
   * that said so: a raw-SQL name two declared tables could mean, a name only a non-default schema
   * declares (see `TableBinding`), and an ORM-shaped write call naming a delegate or table export
   * of the data-model index. Files this run did not read are added by the unread-file scan.
   */
  readonly unknownWriterTables: Map<string, UnknownWriter>;
  /** Delegate and export names of the data-model index; `null` when the run has none. */
  readonly names: OrmNames | null;
  readonly guards: WriteGuards;
  /**
   * The first raw-SQL table reference of the run (smallest file, then line), recorded only while
   * there is no data-model index. Such a reference may have been bound to a declared table by an
   * earlier run with the index; a PASS now would re-point or sweep that edge (`extract.ts`).
   */
  readonly firstRawSql: { site: SourceSite | null };
  /** The first SQL literal the tokenizer could not finish; the code scope cannot claim completeness. */
  readonly sqlResourceLimit: { site: SourceSite | null };
  /** Module-level `IMPORTS`, keyed by `src dst`; emitted once, after every file is scanned. */
  readonly moduleImports: Map<string, ModuleImport>;
  /** Raw-SQL statements folded per (symbol, table); one `QUERIES` edge each, emitted after every file is scanned. */
  readonly queries: QueryFolds;
}

/**
 * Stable key for a declaration node.
 *
 * Uses the absolute path only as an in-memory map key; it never reaches a node
 * or an edge. Position is unique within a file and cheaper than any structural
 * alternative, with one exception: a source file starts at 0 and so does its
 * first statement (`getPos()` includes leading trivia), so by position alone the
 * file is that statement. The file gets a key of its own. Without it, a walk up
 * from module-scope code (`enclosingSymbol`) reaches the file, finds the first
 * declaration under the file's key, and attributes the code to it; and a
 * namespace import, whose declaration is the file, resolves to that declaration.
 */
export function declKey(node: Node): string {
  const path = node.getSourceFile().getFilePath();
  return Node.isSourceFile(node) ? `${path}|file` : `${path}|${node.getPos()}`;
}
