import type { ContradictionCode } from '@seamline/ontology';

import type { SeamlineDetector } from '../detector.ts';
import { x1Nullability } from './x1-nullability.ts';
import { x2Type } from './x2-type.ts';
import { x3Constraint } from './x3-constraint.ts';
import { x4UnbackedProperty } from './x4-unbacked-property.ts';
import { x5UnwrittenColumn } from './x5-unwritten-column.ts';
import { x6PiiUnauthenticated } from './x6-pii-unauthenticated.ts';
import { x7ValidatorDivergence } from './x7-validator-divergence.ts';
import { x8OrphanedMigration } from './x8-orphaned-migration.ts';
import { x9ContractDrift } from './x9-contract-drift.ts';
import { x10UntestedPiiWrite } from './x10-untested-pii-write.ts';

export {
  x1Nullability,
  x2Type,
  x3Constraint,
  x4UnbackedProperty,
  x5UnwrittenColumn,
  x6PiiUnauthenticated,
  x7ValidatorDivergence,
  x8OrphanedMigration,
  x9ContractDrift,
  x10UntestedPiiWrite,
};

/** Every detector in v3 section 5, in catalog order. */
export const ALL_DETECTORS: ReadonlyArray<SeamlineDetector> = [
  x1Nullability,
  x2Type,
  x3Constraint,
  x4UnbackedProperty,
  x5UnwrittenColumn,
  x6PiiUnauthenticated,
  x7ValidatorDivergence,
  x8OrphanedMigration,
  x9ContractDrift,
  x10UntestedPiiWrite,
];

export const DETECTORS_BY_CODE: ReadonlyMap<ContradictionCode, SeamlineDetector> = new Map(
  ALL_DETECTORS.map((d) => [d.code, d]),
);
