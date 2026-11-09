/**
 * @seamline/core — the merge, identity, lifecycle, storage, and security layer.
 *
 * Every subsystem is written against `@seamline/ontology`'s contract. The
 * barrels below are the package root's public surface. Three subpath entries sit
 * beside it: `@seamline/core/identity` (a subset of this surface),
 * `@seamline/core/semantic` (the optional semantic layer, ADR-0015, which is
 * deliberately not re-exported here) and `@seamline/core/sql` (the SQL
 * tokenizer the data and code extractors share, also not re-exported here).
 */
export * from './sif/index.ts';
export * from './identity/index.ts';
export * from './merge/index.ts';
export * from './store/index.ts';
export * from './security/index.ts';
export * from './traversal/index.ts';
