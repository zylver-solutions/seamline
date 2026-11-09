/**
 * SIF — the Seamline Interchange Format.
 *
 * Extractors produce SIF and only SIF; core consumes it. JSON-Lines, one
 * `SifLine` per line, canonically serialized so that two runs over the same
 * input produce byte-identical files (design v3 §2.3).
 */

export {
  assertCleanEdgeBody,
  assertCleanNodeBody,
  assertRepoRelativePosix,
  canonicalPath,
  CanonicalizationError,
  canonicalSifLine,
  canonicalStringify,
  compareCodeUnits,
  compareEdges,
  compareKeyTuples,
  compareNodes,
  formatNumber,
  isAbsoluteLike,
  isPathField,
  isTimestampField,
  quoteString,
  SIF_GROUP_ORDER,
  sifSortKey,
  sortEdges,
  sortNodes,
} from './canonicalize.ts';

export {
  canonicalSifOrder,
  streamSif,
  writeSif,
  writeSifAsync,
  writeSifTo,
} from './writer.ts';
export type { SifSink } from './writer.ts';

export {
  parseSifLine,
  readSif,
  readSifLines,
  readSifStream,
  SifParseError,
} from './reader.ts';
export type { ParseSifContext, ReadSifOptions } from './reader.ts';

export {
  assertByteIdentical,
  assertDeterministic,
  checkDeterminism,
  compareSif,
  formatDivergence,
  formatReport,
} from './determinism.ts';
export type { DeterminismReport, SifDivergence, SifProducer } from './determinism.ts';
export { SIF_FRAME, SifFraming, SifFramingError } from './framing.ts';
export { assertSifAuthority } from './authority.ts';
