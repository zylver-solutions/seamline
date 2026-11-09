/**
 * Scratch working trees.
 *
 * Every analysis, baseline or mutant, runs on a throwaway copy of the pinned
 * tree. That keeps the cache byte-identical to the pin (so `verifyPinned`
 * stays meaningful), keeps the extractor's output and `seamline.config.json`
 * out of the cache, and gives a mutant somewhere to edit that is not the
 * pinned tree. The copy omits git metadata: the extractors this harness runs
 * read the working tree, not history.
 */

import { cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Extractors the harness runs. `extract-change` is left out on purpose: it
 * reads git history, which a scratch copy does not carry, and no detector in
 * the catalog requires the `change` scope.
 */
export const EVAL_EXTRACTORS: readonly string[] = [
  'extract-code-ts',
  'extract-data',
  'extract-contracts',
  'infer-join',
];

/** The configuration `seamline init` would scaffold, minus `extract-change`. */
export function evalConfig(repoName: string): Record<string, unknown> {
  return {
    version: 1,
    repo: repoName,
    outDir: 'seamline-out',
    include: ['**/*'],
    exclude: ['node_modules/**', 'dist/**', '.git/**', 'seamline-out/**'],
    extractors: EVAL_EXTRACTORS.map((name) => ({ name, enabled: true, options: {} })),
    limits: { maxDepth: 6, maxResults: 500 },
    exportProfiles: {},
  };
}

/**
 * Copies `sourceDir` to `destDir`, skipping every `.git` entry and every
 * symbolic link. A fetched tree is untrusted data, and a link in it can point
 * anywhere: `extract-code-ts` reads through links, so a link to a file outside
 * the tree would put that file's content in the graph. Dropping links costs
 * nothing a pinned repository's own source depends on (a link is not source).
 */
export async function copyTree(sourceDir: string, destDir: string): Promise<void> {
  await mkdir(path.dirname(destDir), { recursive: true });
  await cp(sourceDir, destDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: async (src) => path.basename(src) !== '.git' && !(await lstat(src)).isSymbolicLink(),
  });
}

/** Copies the pinned tree into `workDir` and writes the harness configuration. */
export async function prepareWorkTree(
  sourceDir: string,
  workDir: string,
  repoName: string,
): Promise<void> {
  await copyTree(sourceDir, workDir);
  await writeFile(
    path.join(workDir, 'seamline.config.json'),
    `${JSON.stringify(evalConfig(repoName), null, 2)}\n`,
    'utf8',
  );
}
