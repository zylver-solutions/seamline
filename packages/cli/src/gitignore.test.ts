import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendIgnoreEntry, ensureGitignore, hasIgnoreEntry, IGNORE_ENTRY, ignoresEntry } from './gitignore.ts';

async function fixture(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'seamline-gitignore-'));
}

function occurrences(content: string, entry: string): number {
  return content.split(/\r?\n/).filter((l) => ignoresEntry(l, entry)).length;
}

test('ensureGitignore creates .gitignore when the repo has none', async () => {
  const dir = await fixture();
  const file = path.join(dir, '.gitignore');
  const r = await ensureGitignore(file);
  assert.equal(r.action, 'created');
  const content = await readFile(file, 'utf8');
  assert.equal(occurrences(content, IGNORE_ENTRY), 1);
});

test('ensureGitignore appends to an existing .gitignore without clobbering it', async () => {
  const dir = await fixture();
  const file = path.join(dir, '.gitignore');
  await writeFile(file, 'node_modules/\ndist/\n', 'utf8');
  const r = await ensureGitignore(file);
  assert.equal(r.action, 'appended');
  const content = await readFile(file, 'utf8');
  assert.ok(content.includes('node_modules/'), 'pre-existing entries survive');
  assert.ok(content.includes('dist/'));
  assert.equal(occurrences(content, IGNORE_ENTRY), 1);
});

test('ensureGitignore is idempotent: three runs leave exactly one entry', async () => {
  const dir = await fixture();
  const file = path.join(dir, '.gitignore');
  await writeFile(file, 'coverage/\n', 'utf8');
  const first = await ensureGitignore(file);
  const second = await ensureGitignore(file);
  const third = await ensureGitignore(file);
  assert.equal(first.action, 'appended');
  assert.equal(second.action, 'already-present');
  assert.equal(third.action, 'already-present');
  const content = await readFile(file, 'utf8');
  assert.equal(occurrences(content, IGNORE_ENTRY), 1);
});

test('a file with no trailing newline is not corrupted by the append', async () => {
  const dir = await fixture();
  const file = path.join(dir, '.gitignore');
  await writeFile(file, 'dist/', 'utf8');
  await ensureGitignore(file);
  const content = await readFile(file, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  assert.ok(lines.includes('dist/'), `dist/ survived intact: ${JSON.stringify(lines)}`);
  assert.equal(occurrences(content, IGNORE_ENTRY), 1);
});

test('equivalent ignore forms are recognised, so init does not duplicate them', () => {
  for (const form of ['seamline-out/', 'seamline-out', '/seamline-out', '/seamline-out/', './seamline-out']) {
    assert.equal(hasIgnoreEntry(`${form}\n`, IGNORE_ENTRY), true, `recognised: ${form}`);
    assert.equal(appendIgnoreEntry(`${form}\n`, IGNORE_ENTRY), undefined, `no append for: ${form}`);
  }
});

test('a comment mentioning the path is not an ignore entry', () => {
  assert.equal(hasIgnoreEntry('# seamline-out/ is not committed\n', IGNORE_ENTRY), false);
  assert.notEqual(appendIgnoreEntry('# seamline-out/\n', IGNORE_ENTRY), undefined);
});

test('a negation does not count as ignoring the path', () => {
  assert.equal(ignoresEntry('!seamline-out/', IGNORE_ENTRY), false);
  assert.notEqual(appendIgnoreEntry('!seamline-out/\n', IGNORE_ENTRY), undefined);
});

test('an unrelated entry with the same prefix does not satisfy the check', () => {
  assert.equal(hasIgnoreEntry('seamline-output/\n', IGNORE_ENTRY), false);
  assert.equal(hasIgnoreEntry('my-seamline-out/\n', IGNORE_ENTRY), false);
});
