/**
 * Is there an ORM-shaped write call in the files this run read?
 *
 * Only asked when the data-model index is absent. Without the index the
 * extractor cannot bind an ORM call to a table, so it emits no ORM edge; a
 * PASS code scope with those edges missing would read, downstream, as "this code
 * does not write that table", and the store would tombstone the edges an earlier
 * run (with an index) produced. So when there is something to lose, the run is
 * UNAVAILABLE instead (`extract.ts`; design `docs/design/real-world-inputs.md`,
 * section 3.3, "Failure behaviour").
 *
 * The shape is lexical. Section 5.2 defines it with delegate names taken from
 * the index, which is the thing that is absent here, so this is the shape with
 * the delegate left open, narrowed by one repository-level condition so that a
 * project with no ORM does not become UNAVAILABLE for calling `map.delete(k)`:
 * some file read has to mention `@prisma/client` or `drizzle-orm`, because those
 * are the only two clients whose receivers could ever be recognised (3.1). It
 * never resolves a receiver and never reads `node_modules`.
 *
 * - Prisma: `<expr>.<delegate>.<writeOp>(...)` with a write operation of the
 *   Prisma column of table 3.2. `update` and `delete` are also the names of
 *   `Hash.update` and `Map.delete`, so for those two the first argument has to
 *   be an object literal, which every Prisma call has and a map key does not.
 * - Drizzle: `<expr>.insert|update|delete(<identifier>)` whose result is chained
 *   into `.values`, `.set`, `.where` or `.returning`.
 *
 * This is the shape when there is no index to name the tables. With an index the
 * writes are read by `write-guards.ts` (design 5.2, `unknownWriterTables` (a) and
 * `untracedWriteCalls` (4) and (5)), which attributes a call to its table by the
 * delegate or the export it names; the operation sets below are shared.
 */

import { Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, SourceFile } from 'ts-morph';

/** Write operations of the Prisma column of design table 3.2. */
export const PRISMA_WRITE_OPS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** The write operations whose names other common APIs share. */
const SHARED_NAMES: ReadonlySet<string> = new Set(['update', 'delete']);

export const DRIZZLE_STARTERS: ReadonlySet<string> = new Set(['insert', 'update', 'delete']);
const DRIZZLE_CHAIN: ReadonlySet<string> = new Set(['values', 'set', 'where', 'returning']);

export interface OrmShapedCall {
  /** Repo-relative POSIX path. */
  readonly file: string;
  readonly line: number;
}

/** True when the source text mentions a package whose client this extractor could recognise. */
export function mentionsOrmPackage(text: string): boolean {
  return text.includes('@prisma/client') || text.includes('drizzle-orm');
}

export function isOrmShapedWrite(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const name = callee.getName();
  const args = call.getArguments();

  if (PRISMA_WRITE_OPS.has(name) && Node.isPropertyAccessExpression(callee.getExpression())) {
    if (!SHARED_NAMES.has(name)) return true;
    return args[0] !== undefined && Node.isObjectLiteralExpression(args[0]);
  }

  if (DRIZZLE_STARTERS.has(name) && args.length === 1 && Node.isIdentifier(args[0] as Node)) {
    const parent = call.getParent();
    return Node.isPropertyAccessExpression(parent) && DRIZZLE_CHAIN.has(parent.getName());
  }
  return false;
}

/**
 * The first ORM-shaped write call, in file order then line order, or `null` when
 * there is none or no file mentions an ORM package. `files` are `[rel, source]`
 * pairs in the order the run reads them.
 */
export function firstOrmShapedWrite(
  files: ReadonlyArray<readonly [string, SourceFile]>,
): OrmShapedCall | null {
  if (!files.some(([, sf]) => mentionsOrmPackage(sf.getFullText()))) return null;
  for (const [rel, sf] of files) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (isOrmShapedWrite(call)) return { file: rel, line: call.getStartLineNumber() };
    }
  }
  return null;
}
