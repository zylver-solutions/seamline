/**
 * `extract-contracts` as a program the sandbox host can run. See `code-ts.ts`.
 */

import {
  CONTRACTS_SCOPE,
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  MANIFEST,
  extractContracts,
  type ExtractOptions as ExtractContractsOptions,
} from '@seamline/extract-contracts';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import { stringArrayOpt } from './options.ts';

export { EXTRACTOR_NAME as NAME, EXTRACTOR_VERSION as VERSION, MANIFEST };

export async function run(ctx: ExtractContext): Promise<ExtractorOutput> {
  const files = stringArrayOpt(ctx.options, 'files');
  const options: ExtractContractsOptions = {
    repoRoot: ctx.repoRoot,
    repo: ctx.repo,
    runId: ctx.runId,
    ...(ctx.dataModelIndex === undefined ? {} : { dataModelIndex: ctx.dataModelIndex }),
    ...(files === undefined ? {} : { files }),
  };
  const output = extractContracts(options);
  return {
    result: output.result,
    nodes: output.nodes,
    edges: [{ scope: CONTRACTS_SCOPE, edges: output.edges }],
  };
}
