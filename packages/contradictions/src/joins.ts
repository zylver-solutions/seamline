/**
 * The join routes the field-level detectors traverse.
 *
 * These are the edges v3 section 4 lists under "The join - the wedge, mostly
 * INFERRED". Each route is written once here so that a change in how
 * `infer-join` connects two domains is a one-line change rather than a sweep
 * through ten detectors.
 */

import { into, out, type Step } from './graph.ts';

/** Column to the contract property that exposes it. */
export const COLUMN_TO_PROPERTY: ReadonlyArray<ReadonlyArray<Step>> = [
  [out('EXPOSED_AS')],
  [into('BACKED_BY')],
];

/** Column to the ORM / model field that maps it. */
export const COLUMN_TO_FIELD: ReadonlyArray<ReadonlyArray<Step>> = [[out('MAPS_TO_FIELD')]];

/** Code field to the contract property that exposes it. */
export const FIELD_TO_PROPERTY: ReadonlyArray<ReadonlyArray<Step>> = [[out('EXPOSED_AS')]];

/**
 * Column to the validator symbol that guards it, directly or through the code
 * field or contract property it is joined to.
 */
export const COLUMN_TO_VALIDATOR: ReadonlyArray<ReadonlyArray<Step>> = [
  [out('VALIDATED_BY')],
  [out('MAPS_TO_FIELD'), out('VALIDATED_BY')],
  [out('EXPOSED_AS'), out('VALIDATED_BY')],
  [into('BACKED_BY'), out('VALIDATED_BY')],
];

/**
 * Operation to the symbols that serve it: the route handler's own symbol, and
 * up to two levels of calls out of it (handler to service to repository).
 * Every hop here is normally EXTRACTED, so the confidence stays at 1 unless
 * `IMPLEMENTED_BY` was inferred by route matching.
 */
export const OPERATION_TO_SYMBOL: ReadonlyArray<ReadonlyArray<Step>> = [
  [out('IMPLEMENTED_BY'), into('HANDLES_ROUTE')],
  [out('IMPLEMENTED_BY'), into('HANDLES_ROUTE'), out('CALLS')],
  [out('IMPLEMENTED_BY'), into('HANDLES_ROUTE'), out('CALLS'), out('CALLS')],
];
