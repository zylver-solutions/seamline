/**
 * `extract-code-ts` as a program the sandbox host can run.
 *
 * `run` is the whole adapter: it maps the CLI's `ExtractContext` onto the
 * package's options and the package's output back onto `ExtractorOutput`, and
 * decides nothing about status or scope. The sandbox child imports this module
 * and nothing else from the CLI, so the process that analyses a repository
 * loads this extractor and no other.
 */

import {
  CODE_TS_SCOPE,
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  extractCodeTs,
  manifest,
  type ExtractCodeTsOptions,
} from '@seamline/extract-code-ts';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import { stringOpt } from './options.ts';

export { EXTRACTOR_NAME as NAME, EXTRACTOR_VERSION as VERSION, manifest as MANIFEST };

export async function run(ctx: ExtractContext): Promise<ExtractorOutput> {
  const tsConfigFilePath = stringOpt(ctx.options, 'tsConfigFilePath');
  const options: ExtractCodeTsOptions = {
    repoRoot: ctx.repoRoot,
    repo: ctx.repo,
    runId: ctx.runId,
    deterministic: ctx.deterministic,
    // Bounds the coverage report and tsconfig discovery; each tsconfig decides what it reads.
    include: ctx.include,
    exclude: ctx.exclude,
    ...(tsConfigFilePath === undefined ? {} : { tsConfigFilePath }),
    // The index is text from the data program's output, carried here by the host protocol. Without
    // it the extractor reports `ormIndexAbsent`, and UNAVAILABLE if it reads an ORM-shaped write.
    ...(ctx.dataModelIndex === undefined ? {} : { dataModelIndex: ctx.dataModelIndex }),
  };
  const output = extractCodeTs(options);
  return {
    result: output.result,
    nodes: output.nodes,
    edges: [{ scope: CODE_TS_SCOPE, edges: output.edges }],
  };
}
