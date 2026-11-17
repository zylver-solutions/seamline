#!/usr/bin/env node
/**
 * Tests for the gate steps of `.github/workflows/ci.yml` and `release.yml`.
 *
 * Two kinds of check. The release step that requires the tagged commit to be
 * contained in main is extracted from the YAML and run, as Bash, against
 * temporary git repositories. The gate lists are compared as text: every
 * command of `pnpm verify` must be run, unconditionally and with its failure
 * fatal, by the `verify` job of both workflows.
 *
 * The workflows are read as text, not parsed: the repository has no YAML
 * parser among its root dependencies, and the steps are located the same way
 * `pack-check.test.mjs` locates the provenance step. The readers below rely
 * on the layout both files use: jobs at two spaces, steps at six, step keys
 * at eight.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(REPO_ROOT, path), 'utf8');
const CI = read('.github/workflows/ci.yml');
const RELEASE = read('.github/workflows/release.yml');
const SCRIPTS = JSON.parse(read('package.json')).scripts;

/** The workflow's lines that are not comments, each with a trailing comment removed. */
function yamlLines(workflow) {
  return workflow
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ''));
}

/** The text of one job: from its key to the next key at job indentation. */
function job(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z_-]+:/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n');
}

/**
 * The steps of a job, in order. `keys` holds the step's own keys (`if`,
 * `continue-on-error`, `uses`, ...) and `commands` every command it runs: the
 * value of a single-line `run:`, or each line of a block scalar.
 */
function steps(jobText) {
  const [head, ...chunks] = jobText.split(/\n(?= {6}- )/);
  assert.match(head, /\n {4}steps:\s*$/, 'the job has a steps list');
  return chunks.map((chunk) => {
    const lines = yamlLines(chunk.replace(/^ {6}- /, '        '));
    const keys = new Map();
    const commands = [];
    for (let i = 0; i < lines.length; i++) {
      const key = /^ {8}([A-Za-z-]+):\s*(.*)$/.exec(lines[i]);
      if (!key) continue;
      keys.set(key[1], key[2]);
      if (key[1] !== 'run') continue;
      if (!/^[|>][+-]?$/.test(key[2])) {
        commands.push(key[2].trim());
        continue;
      }
      while (
        i + 1 < lines.length &&
        (lines[i + 1] === '' || lines[i + 1].startsWith('          '))
      ) {
        commands.push(lines[++i].trim());
      }
    }
    return {
      name: (keys.get('name') ?? '').replace(/^'(.*)'$/, '$1'),
      text: chunk,
      keys,
      commands,
    };
  });
}

function step(jobText, name) {
  const found = steps(jobText).filter((candidate) => candidate.name === name);
  assert.equal(found.length, 1, `exactly one step is named "${name}"`);
  return found[0];
}

/** The script of a step whose `run` is a block scalar, with its indentation removed. */
function stepScript(jobText, name) {
  const lines = step(jobText, name).text.split('\n');
  const start = lines.indexOf('        run: |');
  assert.ok(start >= 0, `step "${name}" has a script`);
  const script = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  return script.join('\n');
}

// ---------------------------------------------------------------------------
// The gate lists
// ---------------------------------------------------------------------------

/** The script names `pnpm verify` chains, in order. */
function verifyScripts() {
  return SCRIPTS.verify.split('&&').map((part) => {
    const match = /^pnpm (\S+)$/.exec(part.trim());
    assert.ok(match, `verify chains only pnpm scripts, got "${part.trim()}"`);
    return match[1];
  });
}

/**
 * A command is a script when it is `pnpm <name>`, or the script's own command
 * with optional plain arguments (so a stricter flag such as --publish still
 * counts, and `|| true` or a redirect does not). `pnpm build` counts for
 * `typecheck`: both run `tsc --build`, and on a fresh checkout nothing is up
 * to date to skip.
 */
function isScript(command, name) {
  const own = SCRIPTS[name];
  assert.equal(typeof own, 'string', `package.json defines the script ${name}`);
  const accepted = name === 'typecheck' ? ['pnpm typecheck', 'pnpm build'] : [`pnpm ${name}`];
  if (accepted.includes(command) || command === own) return true;
  return command.startsWith(`${own} `) && /^[\w./=:@ -]+$/.test(command.slice(own.length));
}

/**
 * The gates of `pnpm verify` a job does not enforce. A step enforces a gate
 * when it runs the gate's command with no `if:` and no `continue-on-error`:
 * a conditional step can be skipped and an advisory one cannot fail the job.
 * The job itself must be unconditional for the same reason.
 */
function unenforcedGates(jobText) {
  const head = yamlLines(jobText.split(/\n {4}steps:/)[0]).join('\n');
  if (/^ {4}(if|continue-on-error):/m.test(head)) return verifyScripts();
  const enforcing = steps(jobText).filter(
    (s) => !s.keys.has('if') && !s.keys.has('continue-on-error'),
  );
  return verifyScripts().filter(
    (name) => !enforcing.some((s) => s.commands.some((command) => isScript(command, name))),
  );
}

test('pnpm verify chains the expected gates', () => {
  assert.deepEqual(verifyScripts(), [
    'typecheck',
    'lint',
    'test',
    'gate:license',
    'gate:ontology',
    'gate:ontology-ref',
    'gate:determinism',
    'gate:versions',
    'gate:pack',
    'gate:dogfood',
    'gate:leaks',
  ]);
});

test('the CI verify job enforces every gate of pnpm verify', () => {
  assert.deepEqual(unenforcedGates(job(CI, 'verify')), []);
});

test('the release verify job enforces every gate of pnpm verify', () => {
  assert.deepEqual(unenforcedGates(job(RELEASE, 'verify')), []);
});

test('a gate step that is removed, conditional, advisory or failure-tolerant is reported', () => {
  const verify = job(CI, 'verify');
  const packStep = "      - name: 'Gate: pack'\n";
  const packRun = '        run: pnpm gate:pack\n';
  assert.ok(verify.includes(packStep) && verify.includes(packRun));
  const mutated = (from, to) => unenforcedGates(verify.replace(from, to));

  assert.deepEqual(mutated(packRun, '        run: echo skipped\n'), ['gate:pack']);
  assert.deepEqual(mutated(packStep, `${packStep}        if: github.event_name == 'push'\n`), [
    'gate:pack',
  ]);
  assert.deepEqual(mutated(packStep, `${packStep}        continue-on-error: true\n`), [
    'gate:pack',
  ]);
  assert.deepEqual(mutated(packRun, '        run: pnpm gate:pack || true\n'), ['gate:pack']);
  assert.deepEqual(mutated(packRun, `${packRun}        continue-on-error: true\n`), ['gate:pack']);
  // A gate run from a block scalar still counts.
  assert.deepEqual(
    mutated(packRun, '        run: |\n          set -e\n          pnpm gate:pack\n'),
    [],
  );
  // A condition on the whole job makes every gate skippable.
  assert.deepEqual(
    unenforcedGates(
      verify.replace(
        '    timeout-minutes: 30\n',
        "    timeout-minutes: 30\n    if: github.actor != 'x'\n",
      ),
    ),
    verifyScripts(),
  );
});

test('the only conditional steps of the verify jobs are the tag checks and the license report', () => {
  // The tag checks of the release job and the license report of CI are
  // conditional on purpose. They stay allowed because none of them is the
  // step a gate is enforced by, which the two tests above establish.
  const conditional = (workflow) =>
    steps(job(workflow, 'verify'))
      .filter((s) => s.keys.has('if'))
      .map((s) => s.name);
  assert.deepEqual(conditional(RELEASE), [
    'Tagged commit is contained in main',
    'Tag matches the published version',
  ]);
  assert.deepEqual(conditional(CI), ['License report (artifact)', 'Upload license report']);
});

test('CI scans for leaks in the default mode and the release in the publication mode', () => {
  assert.equal(SCRIPTS['gate:leaks'], 'node scripts/internal-leak-scan.mjs');
  const scans = (workflow) =>
    steps(job(workflow, 'verify'))
      .flatMap((s) => s.commands)
      .filter((command) => /internal-leak-scan|gate:leaks/.test(command));
  assert.deepEqual(scans(CI), ['pnpm gate:leaks']);
  assert.ok(
    yamlLines(CI).every((line) => !line.includes('--publish')),
    'no CI line carries --publish',
  );
  assert.deepEqual(scans(RELEASE), ['node scripts/internal-leak-scan.mjs --publish']);
});

// ---------------------------------------------------------------------------
// A manual run never publishes
// ---------------------------------------------------------------------------

/** The value of the workflow's `on:` key as `{ event: [its nested lines] }`. */
function triggers(workflow) {
  const lines = yamlLines(workflow);
  const start = lines.indexOf('on:');
  assert.ok(start >= 0, 'the workflow has an `on:` mapping');
  const events = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() === '') continue;
    const event = /^ {2}([a-z_]+):\s*(.*)$/.exec(line);
    if (event) {
      current = event[1];
      events[current] = event[2] === '' ? [] : [event[2]];
    } else {
      assert.ok(current !== null, `unexpected line in the on: block: ${line}`);
      events[current].push(line.trim());
    }
  }
  return events;
}

/** True when a workflow line refers to the `inputs` context in any form. */
const readsInputs = (line) => /\binputs\b/.test(line);

test('the release workflow declares no dispatch input and reads none', () => {
  const events = triggers(RELEASE);
  assert.deepEqual(Object.keys(events), ['push', 'workflow_dispatch']);
  assert.deepEqual(events.workflow_dispatch, []);
  assert.deepEqual(yamlLines(RELEASE).filter(readsInputs), []);
});

test('a declared or referenced dispatch input is detected', () => {
  const declared = RELEASE.replace(
    '  workflow_dispatch:\n',
    '  workflow_dispatch:\n    inputs:\n      dry_run:\n        type: boolean\n',
  );
  assert.deepEqual(triggers(declared).workflow_dispatch, ['inputs:', 'dry_run:', 'type: boolean']);
  for (const reference of [
    "        if: inputs.dry_run == 'true'",
    "        if: ${{ inputs['dry_run'] }}",
    '        if: github.event.inputs.dry_run',
    '        run: echo "${{ toJSON(inputs) }}"',
  ]) {
    assert.equal(readsInputs(reference), true, reference);
  }
  assert.equal(readsInputs('        run: pnpm install --frozen-lockfile'), false);
});

/** True when a workflow line refers to the `secrets` context in any form. */
const readsSecrets = (line) => /\bsecrets\b/.test(line);

test('only a tag push reaches the publish command, and a dispatch runs the dry run', () => {
  const publish = job(RELEASE, 'publish');
  assert.equal(step(publish, 'Publish').keys.get('if'), "github.event_name == 'push'");
  assert.equal(step(publish, 'Dry run').keys.get('if'), "github.event_name == 'workflow_dispatch'");
  const publishing = steps(publish).filter((s) =>
    s.commands.some((command) => command.startsWith('pnpm publish')),
  );
  assert.deepEqual(
    publishing.map((s) => s.name),
    ['Publish', 'Dry run'],
  );
  assert.ok(step(publish, 'Dry run').commands.every((command) => command.includes('--dry-run')));
});

test('the Publish step is the only place either workflow reads a secret', () => {
  assert.deepEqual(yamlLines(CI).filter(readsSecrets), []);
  const publishStep = step(job(RELEASE, 'publish'), 'Publish');
  const inStep = yamlLines(publishStep.text).filter(readsSecrets);
  assert.deepEqual(
    inStep.map((line) => line.trim()),
    ['NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}'],
  );
  assert.deepEqual(yamlLines(RELEASE).filter(readsSecrets), inStep);
  for (const form of [
    '    secrets: inherit',
    '          TOKEN: ${{ secrets.NPM_TOKEN }}',
    "          TOKEN: ${{ secrets['NPM_TOKEN'] }}",
    '          ALL: ${{ toJSON(secrets) }}',
  ]) {
    assert.equal(readsSecrets(form), true, form);
  }
  // Comment text is not a read.
  assert.deepEqual(
    yamlLines('    # the npm token is in secrets.NPM_TOKEN\n    run: x # secrets.X').filter(
      readsSecrets,
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// The tagged commit is contained in main
// ---------------------------------------------------------------------------

const ON_MAIN_STEP = 'Tagged commit is contained in main';

test('the on-main step runs on a tag push, before anything is installed, over full history', () => {
  const verify = job(RELEASE, 'verify');
  const checkout = step(verify, 'Checkout').text;
  assert.match(checkout, /^ {10}fetch-depth: 0$/m);
  assert.match(checkout, /^ {10}persist-credentials: false$/m);
  assert.equal(step(verify, ON_MAIN_STEP).keys.get('if'), "github.event_name == 'push'");
  assert.equal(step(verify, ON_MAIN_STEP).keys.has('continue-on-error'), false);
  const order = steps(verify).map((s) => s.name);
  assert.deepEqual(order.slice(0, 2), ['Checkout', ON_MAIN_STEP]);
});

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
};

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

/**
 * An origin with four tags and a clone of it:
 *   v1.0.0  annotated, an earlier commit of main
 *   v1.1.0  annotated, the tip of main
 *   v1.1.1  lightweight, the tip of main
 *   v1.2.0  annotated, a commit on a branch that was never merged
 */
function withRepositories(body) {
  const root = mkdtempSync(join(tmpdir(), 'seamline-on-main-'));
  try {
    const origin = join(root, 'origin');
    git(root, 'init', '--quiet', '--initial-branch=main', origin);
    const commit = (text) => {
      writeFileSync(join(origin, 'file.txt'), text);
      git(origin, 'add', 'file.txt');
      git(origin, 'commit', '--quiet', '-m', text);
    };
    commit('first');
    git(origin, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
    commit('second');
    git(origin, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0');
    git(origin, 'tag', 'v1.1.1');
    git(origin, 'checkout', '--quiet', '-b', 'unmerged');
    commit('third');
    git(origin, 'tag', '-a', 'v1.2.0', '-m', 'v1.2.0');
    git(origin, 'checkout', '--quiet', 'main');
    return body(root, `file://${origin}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runOnMainStep(checkout, tag) {
  git(checkout, 'checkout', '--quiet', '--detach', tag);
  return spawnSync('bash', ['-c', stepScript(job(RELEASE, 'verify'), ON_MAIN_STEP)], {
    cwd: checkout,
    env: { ...GIT_ENV, GITHUB_REF_NAME: tag },
    encoding: 'utf8',
  });
}

test('a tag on the tip of main passes', () => {
  withRepositories((root, origin) => {
    git(root, 'clone', '--quiet', origin, 'work');
    const run = runOnMainStep(join(root, 'work'), 'v1.1.0');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /^v1\.1\.0 points at [0-9a-f]{40}, which is contained in origin\/main$/m,
    );
  });
});

test('a lightweight tag on main passes', () => {
  withRepositories((root, origin) => {
    git(root, 'clone', '--quiet', origin, 'work');
    const work = join(root, 'work');
    assert.equal(git(work, 'cat-file', '-t', 'v1.1.1'), 'commit');
    assert.equal(git(work, 'cat-file', '-t', 'v1.1.0'), 'tag');
    const run = runOnMainStep(work, 'v1.1.1');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      /^v1\.1\.1 points at [0-9a-f]{40}, which is contained in origin\/main$/m,
    );
  });
});

test('a tag on an earlier commit of main passes', () => {
  withRepositories((root, origin) => {
    git(root, 'clone', '--quiet', origin, 'work');
    const run = runOnMainStep(join(root, 'work'), 'v1.0.0');
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});

test('a tag on a commit that main does not contain fails', () => {
  withRepositories((root, origin) => {
    git(root, 'clone', '--quiet', origin, 'work');
    const run = runOnMainStep(join(root, 'work'), 'v1.2.0');
    assert.equal(run.status, 1);
    assert.match(
      run.stdout,
      /^::error::v1\.2\.0 points at [0-9a-f]{40}, which is not contained in origin\/main/m,
    );
    assert.doesNotMatch(run.stdout, /which is contained in/);
  });
});

test('a checkout without origin/main fails', () => {
  withRepositories((root, origin) => {
    git(root, 'clone', '--quiet', origin, 'work');
    git(join(root, 'work'), 'update-ref', '-d', 'refs/remotes/origin/main');
    const run = runOnMainStep(join(root, 'work'), 'v1.1.0');
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^::error::origin\/main is not in this checkout/m);
  });
});

test('a shallow checkout that cannot prove containment fails', () => {
  withRepositories((root, origin) => {
    git(root, 'clone', '--quiet', '--depth', '1', origin, 'work');
    git(join(root, 'work'), 'fetch', '--quiet', '--depth', '1', 'origin', 'tag', 'v1.0.0');
    const run = runOnMainStep(join(root, 'work'), 'v1.0.0');
    assert.equal(run.status, 1);
    assert.match(
      run.stdout,
      /^::error::v1\.0\.0 points at [0-9a-f]{40}, which is not contained in origin\/main/m,
    );
  });
});
