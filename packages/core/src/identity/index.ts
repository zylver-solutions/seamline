/**
 * Identity: natural keys that are path-free for every kind except `File`
 * (whose key is its repo-relative path), and the alias machinery that lets
 * history survive a file rename. See docs/design/v3.md §2.1.
 */
export * from './canonical.ts';
export * from './alias.ts';
export * from './rename.ts';
