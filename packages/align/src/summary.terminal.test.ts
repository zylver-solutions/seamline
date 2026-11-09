/**
 * Terminal escaping: the human summary quotes `repo` and the facts run id, which come
 * from the repository's config and store. They are written to a terminal, so a
 * control character, a bidi override or a line break in either must not survive.
 * The JSON summary carries no repo name, and the packet is machine output.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMIT, caseFiles, factsFor } from './__fixtures__/build.ts';
import { runAlign, type AlignRequest } from './run.ts';
import { memTree } from './tree.ts';
import type { AlignSink } from './write.ts';

const HOSTILE = 'fx\u001b[31mRED\u001b]0;pwned\u0007\u009b2J\u007f\u202Eevil\u200BZW\u2028SEP\nCRITICAL  forged\rend';

function request(over: Partial<AlignRequest>): AlignRequest {
  const files = caseFiles();
  return {
    repoRoot: '/nowhere',
    repo: 'fx',
    at: null,
    worktree: false,
    facts: factsFor(files),
    baselineText: null,
    config: {},
    output: { packet: false, json: false },
    producer: { toolVersion: '0.0.0-test', sifVersion: '1.0.0' },
    tree: { tree: memTree(files), commit: COMMIT },
    ...over,
  };
}

test('the text summary escapes a repo name and keeps it on one line', async () => {
  const out: string[] = [];
  const sink: AlignSink = { stdout: (t) => void out.push(t), file: () => undefined };
  await runAlign(request({ repo: HOSTILE }), sink);
  const text = out.join('');
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200B-\u200F\u2028-\u202E]/u);
  assert.ok(text.includes('RED') && text.includes('pwned') && text.includes('evil') && text.includes('forged'));
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('CRITICAL')), []);
  assert.match(text.split('\n')[0] ?? '', /^alignment of fx\\x1b\[31mRED/);
});

test('the text summary escapes the facts run id, which a facts file controls', async () => {
  const out: string[] = [];
  const sink: AlignSink = { stdout: (t) => void out.push(t), file: () => undefined };
  const files = caseFiles();
  await runAlign(request({ facts: factsFor(files, { runId: HOSTILE }) }), sink);
  const text = out.join('');
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200B-\u200F\u2028-\u202E]/u);
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('CRITICAL')), []);
  assert.match(text, /run fx\\x1b\[31mRED/);
});
