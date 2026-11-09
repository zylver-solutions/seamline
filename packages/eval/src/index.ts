export { parseCorpus, loadCorpus, readJsonFile } from './corpus.ts';
export {
  ConfigError,
  DirtyCheckoutError,
  PinMismatchError,
  UnguardedCheckoutError,
} from './errors.ts';
export { evaluate, ensureCorpus, fetchCorpus } from './evaluate.ts';
export { buildLabelSheet, renderLabelSheet } from './label-sheet.ts';
export type { EvaluateOptions, EvaluateResult } from './evaluate.ts';
export { ATTRIBUTES_GUARD, checkoutDir, fetchRepo, isCloned, verifyPinned } from './fetch.ts';
export {
  allUnknown,
  dedupeFindings,
  detectorOutcomes,
  findingId,
  parseCheckOutput,
} from './findings.ts';
export { matchLabels, parseLabels } from './labels.ts';
export {
  applyEdits,
  checkMutants,
  judgeMutant,
  matchesExpectation,
  MutantEditError,
  parseMutants,
  replaceExactlyOnce,
} from './mutants.ts';
export {
  calibrate,
  clusteredTally,
  CONFIDENCE_BANDS,
  formatInterval,
  formatRatio,
  headline,
  meetsReleaseBar,
  precision,
  precisionStat,
  rawTally,
  recall,
  RELEASE_BAR,
  wilson95,
} from './metrics.ts';
export { runPipeline } from './pipeline.ts';
export { buildReport, renderMarkdown, reportBody, serializeReport } from './report.ts';
export type { Report } from './report.ts';
export type { CorpusEntry, Finding, Label, Mutant, PipelineResult, Verdict } from './types.ts';
export { copyTree, evalConfig, EVAL_EXTRACTORS, prepareWorkTree } from './workdir.ts';
