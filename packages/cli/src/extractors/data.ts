/**
 * `extract-data` as a program the sandbox host can run. See `code-ts.ts`.
 */

import {
  buildDataModelIndex,
  DATA_SCOPE,
  EXTRACTOR_NAME,
  EXTRACTOR_VERSION,
  MANIFEST,
  extractData,
  type ExtractDataOptions,
} from '@seamline/extract-data';
import type { ExtractContext, ExtractorOutput } from '../ports.ts';
import { numberOpt, stringArrayOpt, stringOpt } from './options.ts';

export { EXTRACTOR_NAME as NAME, EXTRACTOR_VERSION as VERSION, MANIFEST };

export async function run(ctx: ExtractContext): Promise<ExtractorOutput> {
  const dataSource = stringOpt(ctx.options, 'dataSource');
  const defaultSchema = stringOpt(ctx.options, 'defaultSchema');
  // Passed through as written, whatever its type: `extractData` refuses a value that is not
  // one of its dialects (a number or an array included) with a FAIL, and narrowing it to
  // `string | undefined` here would turn a mistyped option into "not set", with no diagnostic.
  const dialect = ctx.options['dialect'] as string | undefined;
  const skipDirs = stringArrayOpt(ctx.options, 'skipDirs');
  const maxFileBytes = numberOpt(ctx.options, 'maxFileBytes');
  const options: ExtractDataOptions = {
    root: ctx.repoRoot,
    repo: ctx.repo,
    runId: ctx.runId,
    deterministic: ctx.deterministic,
    ...(dataSource === undefined ? {} : { dataSource }),
    ...(defaultSchema === undefined ? {} : { defaultSchema }),
    ...(dialect === undefined ? {} : { dialect }),
    ...(skipDirs === undefined ? {} : { skipDirs }),
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  };
  const output = await extractData(options);
  return {
    result: output.result,
    nodes: output.nodes,
    edges: [{ scope: DATA_SCOPE, edges: output.edges }],
    // A PASS has tables to index. When discovery found no schema source it reads or recognises,
    // and knew of nothing it did not read, the (empty) index is published too, flagged so that the
    // command can tell it from a source that was not read; every other status leaves the index
    // absent downstream.
    ...(output.result.status === 'PASS'
      ? { dataModelIndex: buildDataModelIndex(output.nodes) }
      : output.noSchemaSource
        ? { dataModelIndex: buildDataModelIndex(output.nodes), noSchemaSource: true as const }
        : {}),
  };
}
