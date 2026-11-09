/**
 * How much of a workspace one run reads, decided from its input and nothing else.
 *
 * A workspace run keeps one TypeScript program per tsconfig alive until it ends,
 * so memory is the sum of the programs, and a very large workspace would pass the
 * `memMb` the manifest declares. The packages that are read must still be a pure
 * function of the repository (design v3 section 2.3, ADR-0009 section 3a): the
 * same tree, config and extractor version give the same bytes on every machine.
 * The process's resident memory is therefore never what decides the cut. The size
 * of each program's own file list is known before any program is built, and the
 * cut is made from that, in package order, against a budget that follows
 * `manifest.memMb`: a program whose estimate does not fit what is left of the
 * budget is not read, and the programs after it are tried in turn (first fit).
 *
 * Resident memory is read only as a fail-safe: if it passes the ceiling anyway
 * (an estimate that was too low, or a process that was already large), the run is
 * `UNAVAILABLE`. It is never a different `PASS`.
 */

import * as fs from 'node:fs';
import { manifest } from './manifest.ts';
import { toRepoRelative } from './paths.ts';

/**
 * Bounds how much of a large workspace one run reads. See the module comment:
 * `mb` bounds an estimate made from the input, and `usedMb` only guards a ceiling.
 */
export interface MemoryBudget {
  /**
   * Resident memory, in MiB, that reading the workspace may be estimated to need
   * (`estimateMib`). Defaults to the manifest's `memMb`.
   */
  readonly mb?: number;
  /**
   * Resident memory, in MiB, past which the run stops and is `UNAVAILABLE`.
   * Defaults to the manifest's `memMb`.
   */
  readonly ceilingMb?: number;
  /**
   * Resident memory in use now, in MiB. Defaults to the process RSS. It decides
   * nothing but the fail-safe, so injecting it cannot change which packages are
   * read; tests inject it to cross the ceiling without allocating.
   */
  readonly usedMb?: () => number;
}

/**
 * The estimate of the resident memory a workspace run reaches at its peak, in MiB:
 * `baseMib + sum over programs (perProgramMib + perSourceMib * MiB of source)`,
 * where the source is the bytes of the files in the program's own file list
 * (`parsed.fileNames`), which are known before the program is built.
 *
 * The constants are calibrated to peak RSS, not retained heap, because RSS is
 * what the host limits. Measured in-process (`process.resourceUsage().maxRSS`,
 * no heap cap) on five repositories whose estimate the run prints as
 * `memory estimate: N MiB ...`:
 *
 * | repository                    | programs | source | peak | estimate | of budget |
 * | ----------------------------- | -------: | -----: | ---: | -------: | --------: |
 * | rallly (no node_modules)      |        5 |   0.06 |  295 |      933 |       46% |
 * | this repository (installed)   |       11 |   2.76 | 1347 |     1434 |       70% |
 * | dokploy (no node_modules)     |        4 |   6.16 | 1465 |     1701 |       83% |
 * | karakeep (no node_modules)    |       21 |   4.22 | 1782 |     1874 |       92% |
 * | frapp (no node_modules)       |       14 |  15.78 | 2441 |     3202 |      156% |
 *
 * The estimate is above the measured peak on all five: by 6% (this repository),
 * 16% (dokploy), 5% (karakeep) and 31% (frapp), and far above on the smallest.
 * Karakeep, the tightest repository that must be read whole, comes out at 92% of
 * the 2048 MiB budget. Frapp, whose peak is above both the 2048 MiB heap cap and
 * the host's kill line, comes out at 156% of it, so the tsconfigs that fit the
 * budget are read and the others are not, instead of the process being killed.
 *
 * What the estimate cannot see is the declaration files of installed
 * dependencies, which each program loads and which are not in `fileNames`: this
 * repository, installed, sits 6% under its estimate, and a repository with
 * heavier types could sit above it. The ceiling check below is what covers that,
 * by ending the run as `UNAVAILABLE` instead of letting the host kill it.
 */
export const MEMORY_MODEL = {
  /** The process, the type checker's library files, and the passes' fixed costs. */
  baseMib: 800,
  /** Library files and checker state that every program repeats. */
  perProgramMib: 25,
  /** Resident memory per MiB of source in a program's own file list, passes included. */
  perSourceMib: 130,
} as const;

const MIB = 1024 * 1024;

/** The bytes of `files` that are inside the repository; a file outside it, or one that is not there, counts as nothing. */
export function sourceBytes(repoRoot: string, files: readonly string[]): number {
  let total = 0;
  for (const file of files) {
    // What lies outside the repository is not part of the input, so it cannot decide what is read.
    if (toRepoRelative(repoRoot, file) === null) continue;
    try {
      total += fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    } catch {
      // A file that cannot be examined has no size to count.
    }
  }
  return total;
}

/** What one program adds to the estimate, in MiB, for `bytes` of source. */
export function estimateProgramMib(bytes: number): number {
  return MEMORY_MODEL.perProgramMib + (bytes / MIB) * MEMORY_MODEL.perSourceMib;
}

export interface MemoryPlan {
  /**
   * For each program, in the order given: whether it fits the budget left after
   * the programs before it that fit.
   */
  readonly fits: readonly boolean[];
  /** The estimate for the whole list, in MiB, rounded. */
  readonly totalMib: number;
  /** The estimate for the programs that fit, in MiB, rounded. */
  readonly readMib: number;
}

/**
 * Which of `programMib` (each from `estimateProgramMib`, in the order the
 * programs are built) are read: first fit. A program is read when the estimate of
 * the ones already taken plus its own stays within `budgetMb`; one that does not
 * fit is left out and the next is tried, so a large package early in the order
 * does not hide the smaller ones after it. The answer depends on the sizes and
 * their order and on nothing else.
 */
export function planPrograms(programMib: readonly number[], budgetMb: number): MemoryPlan {
  let all = MEMORY_MODEL.baseMib;
  let kept = MEMORY_MODEL.baseMib;
  const fits = programMib.map((mib) => {
    all += mib;
    if (kept + mib > budgetMb) return false;
    kept += mib;
    return true;
  });
  return { fits, totalMib: Math.round(all), readMib: Math.round(kept) };
}

/** Resident memory passed the ceiling: the run cannot be trusted to finish, and says so by being `UNAVAILABLE`. */
export class MemoryCeilingError extends Error {}

export interface ResolvedMemory {
  readonly budgetMb: number;
  readonly ceilingMb: number;
  /** Throws `MemoryCeilingError` when resident memory is past the ceiling. */
  readonly checkCeiling: () => void;
}

export function resolveMemory(option: MemoryBudget | undefined): ResolvedMemory {
  const ceilingMb = option?.ceilingMb ?? manifest.memMb;
  const usedMb = option?.usedMb ?? ((): number => process.memoryUsage.rss() / MIB);
  return {
    budgetMb: option?.mb ?? manifest.memMb,
    ceilingMb,
    checkCeiling: () => {
      if (usedMb() > ceilingMb)
        throw new MemoryCeilingError(`resident memory passed ${ceilingMb} MiB`);
    },
  };
}
