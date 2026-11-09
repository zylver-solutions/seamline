/**
 * Fixture repositories for the conformance suite.
 *
 * Five kinds, all built from the extractor's own declaration plus an optional seed directory of
 * representative input the author supplies:
 *
 *  - `clean`: the seed, and a few files for each declared glob. What a well-behaved run reads.
 *  - `links`: `clean` plus symlinks that lead where an extractor must not read: to a file outside the
 *    repo by an absolute path and by a `..` path, to an undeclared file inside the repo, to a
 *    directory outside it, and up past the repo root. Kept apart from `bait` because the host stops
 *    a run that even looks at a link leading out, and the bait must be reachable by a run that does
 *    not.
 *  - `bait`: `clean` plus an undeclared file in the repo, and declared-looking files holding URLs of
 *    a listener the suite runs on loopback.
 *  - `unreadable`: `clean`, run with every open of a repository file failing (`wrapper.ts`).
 *  - `stress`: `clean` plus padded files for each declared glob, to push memory and time.
 *
 * Everything the lures hold is synthesized here from fixed strings. Nothing is derived from any real
 * repository (docs/design/aspirational-state.md, 6A.7).
 *
 * The lures live under `conformance-lures/`, the stress files under `conformance-stress/`, both at
 * the repository root. An extractor whose discovery starts from its own configuration (a tsconfig
 * `include`) does not walk there unless the seed's configuration points it there; docs/conformance.md
 * says so.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { ExtractorManifest } from '@seamline/ontology';
import {
  contentFor,
  extensionOf,
  paddedContentFor,
  sampleForGlob,
  undeclaredName,
} from './globs.ts';
import { BAIT_DIR, STRESS_DIR, type FixtureKind } from './types.ts';

/** Content of the in-repo file no declared glob admits. If it shows up in an output, a read got past every control. */
export const UNDECLARED_CANARY = 'SEAMLINE-CONFORMANCE-CANARY-UNDECLARED';
/** Content of the files outside the repository. */
export const OUTSIDE_CANARY = 'SEAMLINE-CONFORMANCE-CANARY-OUTSIDE';
export const CANARIES: ReadonlyArray<string> = [UNDECLARED_CANARY, OUTSIDE_CANARY];

const MAX_GLOBS = 4;
const STRESS_FILE_BYTES = 512 * 1024;
const MAX_STRESS_FILES_PER_GLOB = 64;

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

export interface FixtureInput {
  readonly manifest: ExtractorManifest;
  /** Binaries the program is granted. `git` makes the fixture a git repository. */
  readonly exec: ReadonlyArray<string>;
  readonly seed: string | undefined;
  readonly workDir: string;
  /** Origin of the loopback listener the bait points at, e.g. `http://127.0.0.1:41233`. */
  readonly baitOrigin: string;
  readonly stressBytes: number;
}

export interface Fixture {
  readonly kind: FixtureKind;
  readonly root: string;
  readonly repo: string;
  readonly out: string;
  /** Files the suite wrote into the repository, seed included. */
  readonly files: number;
  readonly bytes: number;
  /** What the fixture holds that a verdict depends on, as short facts. */
  readonly facts: ReadonlyArray<string>;
  /** Lures that could not be built on this machine. A verdict that needs them is UNAVAILABLE. */
  readonly skipped: ReadonlyArray<string>;
  /** Count of bait files: declared-looking files holding the listener's URL. */
  readonly baitFiles: number;
  /** Count of padded files the stress fixture holds, beyond the samples. Zero when no declared glob could be padded. */
  readonly padded: number;
  dispose(): void;
}

function globsOf(manifest: ExtractorManifest): string[] {
  return [...new Set(manifest.reads)].slice(0, MAX_GLOBS);
}

function insideGit(path: string): boolean {
  return path === '.git' || path.startsWith('.git/');
}

function git(repo: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Conformance',
      GIT_AUTHOR_EMAIL: 'conformance@example.invalid',
      GIT_COMMITTER_NAME: 'Conformance',
      GIT_COMMITTER_EMAIL: 'conformance@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    const why = result.error?.message ?? result.stderr.trim();
    throw new FixtureError(`git ${args[0] ?? ''} failed while building the fixture: ${why}`);
  }
}

function initGit(repo: string): void {
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'conformance fixture: initial']);
  writeFileSync(join(repo, 'conformance-history.txt'), 'second commit\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'conformance fixture: second']);
}

/** What a bait file of the kind `path` names holds: the listener's URL where a remote reference would go. */
function baitFor(path: string, origin: string): string {
  const ext = extensionOf(path);
  const url = `${origin}/conformance-bait`;
  if (ext === 'json') return `${JSON.stringify({ $id: url, $ref: `${url}/schema.json` })}\n`;
  if (ext === 'yaml' || ext === 'yml') {
    return `$ref: ${url}/schema.yaml\nservers:\n  - url: ${url}\n`;
  }
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return `export const remote = ${JSON.stringify(`${url}/module`)};\n`;
  }
  return contentFor(path, url);
}

export function buildFixture(kind: FixtureKind, input: FixtureInput): Fixture {
  const root = realpathSync(mkdtempSync(join(input.workDir, 'seamline-conformance-')));
  const repo = join(root, 'repo');
  const outside = join(root, 'outside');
  const out = join(root, 'out');
  let files = 0;
  let bytes = 0;
  let baitFiles = 0;
  let padded = 0;
  const facts: string[] = [];
  const skipped: string[] = [];

  const write = (rel: string, text: string): boolean => {
    const abs = join(repo, rel);
    if (existsSync(abs) || lstatExists(abs)) return false;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    files += 1;
    bytes += Buffer.byteLength(text);
    return true;
  };
  const link = (rel: string, target: string, label: string): boolean => {
    const abs = join(repo, rel);
    if (lstatExists(abs)) return false;
    try {
      mkdirSync(dirname(abs), { recursive: true });
      symlinkSync(target, abs);
      return true;
    } catch (e) {
      skipped.push(`${label} (${(e as NodeJS.ErrnoException).code ?? 'symlink failed'})`);
      return false;
    }
  };

  try {
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });

    if (input.seed !== undefined) {
      if (!existsSync(input.seed) || !statSync(input.seed).isDirectory()) {
        throw new FixtureError(`the seed ${input.seed} is not a directory`);
      }
      cpSync(input.seed, repo, {
        recursive: true,
        filter: (source) => basename(source) !== '.git',
      });
      facts.push('seed directory copied in');
    }

    const globs = globsOf(input.manifest);
    let samples = 0;
    for (const glob of globs) {
      for (const dir of ['conformance-samples', null]) {
        const path = sampleForGlob(glob, { dir, stem: 'sample' });
        if (path === undefined || insideGit(path)) continue;
        if (write(path, contentFor(path, 'conformance sample, nothing to extract'))) samples += 1;
      }
    }
    facts.push(`${samples} sample file(s) for ${globs.length} declared glob(s)`);

    if (input.exec.includes('git') && kind !== 'unreadable') {
      initGit(repo);
      facts.push('git repository with two commits');
    }

    const hidden =
      kind === 'links' || kind === 'bait' ? undeclaredName(input.manifest.reads) : undefined;
    if (kind === 'links' || kind === 'bait') {
      if (hidden !== undefined) {
        write(hidden, contentFor(hidden, UNDECLARED_CANARY));
        facts.push(`undeclared file ${hidden} holds a canary`);
      } else {
        facts.push('every in-repo path is declared, so no undeclared file was planted');
      }
    }

    if (kind === 'bait') {
      for (const glob of globs) {
        const bait = sampleForGlob(glob, { dir: BAIT_DIR, stem: 'bait' });
        if (bait === undefined || insideGit(bait)) continue;
        if (write(bait, baitFor(bait, input.baitOrigin))) baitFiles += 1;
      }
      facts.push(`${baitFiles} bait file(s) holding ${input.baitOrigin}`);
    }

    if (kind === 'links') {
      let linked = 0;
      let outsideIndex = 0;
      for (const glob of globs) {
        const probe = sampleForGlob(glob, { dir: 'conformance-lures/links', stem: 'lure' });
        if (probe === undefined || insideGit(probe)) continue;
        const named = (stem: string): string | undefined =>
          sampleForGlob(glob, { dir: 'conformance-lures/links', stem });
        const secret = join(
          outside,
          `secret-${outsideIndex}${extensionOf(probe) === '' ? '' : `.${extensionOf(probe)}`}`,
        );
        outsideIndex += 1;
        writeFileSync(secret, contentFor(secret, OUTSIDE_CANARY));
        const abs = named('lure-abs');
        if (abs !== undefined && link(abs, secret, 'symlink to a file outside the repo'))
          linked += 1;
        const rel = named('lure-dotdot');
        if (rel !== undefined) {
          const target = relative(dirname(join(repo, rel)), secret);
          if (link(rel, target, 'symlink to a file outside the repo through ..')) linked += 1;
        }
        const inRepo = named('lure-undeclared');
        if (inRepo !== undefined && hidden !== undefined) {
          const target = relative(dirname(join(repo, inRepo)), join(repo, hidden));
          if (link(inRepo, target, 'symlink to an undeclared file in the repo')) linked += 1;
        }
      }
      // A directory of declared-looking files that lives outside the repo, and a link up past the root.
      const sampleGlob = globs
        .map((g) => sampleForGlob(g, { dir: null, stem: 'in-linked-dir' }))
        .find((p) => p !== undefined && !insideGit(p));
      if (sampleGlob !== undefined) {
        const target = join(outside, 'linked-dir');
        mkdirSync(dirname(join(target, sampleGlob)), { recursive: true });
        writeFileSync(join(target, sampleGlob), contentFor(sampleGlob, OUTSIDE_CANARY));
        if (link('conformance-lures/linked-dir', target, 'symlink to a directory outside the repo'))
          linked += 1;
      }
      if (link('conformance-lures/up', '../..', 'symlink up past the repo root through ..'))
        linked += 1;
      facts.push(`${linked} symlink lure(s) leading outside the repo or to an undeclared file`);
    }

    if (kind === 'stress') {
      const usable = globs.filter((g) => {
        const p = sampleForGlob(g, { dir: STRESS_DIR, stem: 'stress-0' });
        return p !== undefined && !insideGit(p);
      });
      if (usable.length > 0) {
        const each = Math.min(
          MAX_STRESS_FILES_PER_GLOB,
          Math.max(1, Math.ceil(input.stressBytes / (usable.length * STRESS_FILE_BYTES))),
        );
        for (const glob of usable) {
          for (let n = 0; n < each; n += 1) {
            const path = sampleForGlob(glob, { dir: STRESS_DIR, stem: `stress-${n}` });
            if (path === undefined) continue;
            if (write(path, paddedContentFor(path, STRESS_FILE_BYTES))) padded += 1;
          }
        }
      }
      facts.push(
        padded === 0
          ? 'no stress file could be generated from the declared globs'
          : `${padded} padded file(s) of about ${STRESS_FILE_BYTES / 1024} KiB`,
      );
    }
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }

  return {
    kind,
    root,
    repo,
    out,
    files,
    bytes,
    facts,
    skipped,
    baitFiles,
    padded,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
