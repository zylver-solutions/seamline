/**
 * Test support: materialises the fixture set as a throwaway repository.
 *
 * The fixtures are copied into `<tmp>/repo/api/` and one file is written to
 * `<tmp>/outside.yaml`, i.e. OUTSIDE the repo root, so the `$ref` containment
 * check has a real target to refuse rather than a mocked one.
 */

import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeamlineNode } from '@seamline/ontology';

export const FIXTURES_DIR = join(import.meta.dirname, '__fixtures__');

export interface TempRepo {
  /** The repo root passed to the extractor. */
  readonly root: string;
  /** The parent of the repo root; holds the out-of-tree `$ref` target. */
  readonly base: string;
  dispose(): void;
}

export function makeTempRepo(): TempRepo {
  const base = mkdtempSync(join(tmpdir(), 'seamline-contracts-'));
  const root = join(base, 'repo');
  const api = join(root, 'api');
  mkdirSync(api, { recursive: true });
  cpSync(FIXTURES_DIR, api, { recursive: true });
  // `.ts.txt` in the fixture tree so this package's own build never has to
  // resolve `zod`; `.ts` in the temp repo so discovery treats it as source.
  renameSync(join(api, 'zod-schemas.ts.txt'), join(api, 'zod-schemas.ts'));
  writeFileSync(
    join(base, 'outside.yaml'),
    'Thing:\n  type: object\n  properties:\n    secret:\n      type: string\n',
    'utf8',
  );
  return {
    root,
    base,
    dispose: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function makeEmptyRepo(): TempRepo {
  const base = mkdtempSync(join(tmpdir(), 'seamline-empty-'));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# nothing to see here\n', 'utf8');
  writeFileSync(join(root, 'src', 'main.ts'), 'export const answer = 42;\n', 'utf8');
  return {
    root,
    base,
    dispose: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function nodeById(nodes: readonly SeamlineNode[], id: string): SeamlineNode {
  const found = nodes.find((n) => (n.id as string) === id);
  if (found === undefined) {
    const near = nodes.filter((n) => (n.id as string).startsWith(id.slice(0, 24))).map((n) => n.id);
    throw new Error(`no node ${id}\ncandidates:\n${near.join('\n')}`);
  }
  return found;
}

export function prop(node: SeamlineNode, key: string): string | number | boolean | null | undefined {
  return node.props[key];
}
