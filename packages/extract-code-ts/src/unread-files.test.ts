/**
 * The scan of files in no loaded project (`unread-files.ts`): what it reads, and what it must not.
 *
 * It reads text from the filesystem, so the bounds on that read are asserted here directly:
 * nothing outside the repository root, and no file larger than the cap.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { after, test } from 'node:test';
import type { OrmNames } from './data-model.ts';
import { scanUnreadFiles, UNREAD_MAX_BYTES } from './unread-files.ts';

const NAMES: OrmNames = {
  delegates: new Map(),
  exports: new Map(),
  exact: new Map([['User', ['User']]]),
  folded: new Map(),
};

const dirs: string[] = [];

function scratch(): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seamline-unread-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const WRITER = 'await client.query(\'INSERT INTO "User" (id) VALUES (1)\');\n';

test('a file in the repository that holds a write marker and a table name withholds the table', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  fs.writeFileSync(nodePath.join(root, 'scripts', 'seed.js'), WRITER);
  const scan = scanUnreadFiles(root, ['scripts/seed.js'], NAMES);
  assert.equal(scan.failure, null);
  assert.deepEqual([...scan.tables], [['User', 'scripts/seed.js']]);
});

test('a symlink to a file outside the repository root is not read', () => {
  const root = scratch();
  const outside = scratch();
  fs.writeFileSync(nodePath.join(outside, 'secret.js'), WRITER);
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  fs.symlinkSync(nodePath.join(outside, 'secret.js'), nodePath.join(root, 'scripts', 'link.js'));
  const inspected: string[] = [];
  const scan = scanUnreadFiles(root, ['scripts/link.js'], NAMES, undefined, (rel) => inspected.push(rel));
  assert.match(
    scan.failure ?? '',
    /^scripts\/link\.js resolves to a path outside the repository root/,
  );
  assert.ok(!(scan.failure ?? '').includes(root), 'no absolute path in the failure');
  assert.deepEqual([...scan.tables], [], 'text outside the root must not reach the output');
  assert.equal(scan.markedFiles, 0);
  assert.deepEqual(inspected, [], 'source inspection never receives text outside the root');
});

test('a symlink to a directory outside the root is not followed either', () => {
  const root = scratch();
  const outside = scratch();
  fs.writeFileSync(nodePath.join(outside, 'seed.js'), WRITER);
  fs.symlinkSync(outside, nodePath.join(root, 'linked'), 'dir');
  const scan = scanUnreadFiles(root, ['linked/seed.js'], NAMES);
  assert.match(scan.failure ?? '', /^linked\/seed\.js resolves to a path outside/);
  assert.deepEqual([...scan.tables], []);
});

test('a symlink that stays inside the root is read as the file it points at', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  fs.writeFileSync(nodePath.join(root, 'scripts', 'seed.js'), WRITER);
  fs.symlinkSync('seed.js', nodePath.join(root, 'scripts', 'alias.js'));
  const scan = scanUnreadFiles(root, ['scripts/alias.js'], NAMES);
  assert.equal(scan.failure, null);
  assert.deepEqual([...scan.tables], [['User', 'scripts/alias.js']]);
});

test('an in-root source alias cannot open a target outside declared reads', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  fs.mkdirSync(nodePath.join(root, 'private'));
  fs.writeFileSync(nodePath.join(root, 'private', 'secret.conformance-canary'), WRITER);
  fs.symlinkSync('../private/secret.conformance-canary', nodePath.join(root, 'scripts', 'alias.js'));
  const inspected: string[] = [];
  const scan = scanUnreadFiles(root, ['scripts/alias.js'], NAMES, undefined, (rel) => inspected.push(rel));
  assert.equal(scan.failure, 'scripts/alias.js or its resolved target matches no declared reads glob and was not read');
  assert.equal(scan.markedFiles, 0);
  assert.deepEqual([...scan.tables], []);
  assert.deepEqual(inspected, []);
  assert.ok(!scan.failure.includes(root), 'the refusal contains no absolute path');
});

test('an undeclared alias cannot open a declared source target', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  fs.writeFileSync(nodePath.join(root, 'scripts', 'seed.js'), WRITER);
  fs.symlinkSync('seed.js', nodePath.join(root, 'scripts', 'alias.conformance-canary'));
  const inspected: string[] = [];
  const scan = scanUnreadFiles(root, ['scripts/alias.conformance-canary'], NAMES, undefined, (rel) => inspected.push(rel));
  assert.equal(scan.failure, 'scripts/alias.conformance-canary or its resolved target matches no declared reads glob and was not read');
  assert.equal(scan.markedFiles, 0);
  assert.deepEqual([...scan.tables], []);
  assert.deepEqual(inspected, []);
});

test('a file over the size cap fails the scan without being read', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  fs.writeFileSync(nodePath.join(root, 'scripts', 'big.js'), WRITER + 'x'.repeat(2000));
  const inspected: string[] = [];
  const scan = scanUnreadFiles(root, ['scripts/big.js'], NAMES, 1000, (rel) => inspected.push(rel));
  assert.match(scan.failure ?? '', /scripts\/big\.js is \d+ bytes, over the 1000 byte limit/);
  assert.deepEqual([...scan.tables], [], 'a file that was not read lists nothing');
  assert.deepEqual(inspected, [], 'source inspection never receives an oversized file');
});

test('a file at the cap is read, and the default cap is above any hand-written source file', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  const text = WRITER;
  fs.writeFileSync(nodePath.join(root, 'scripts', 'edge.js'), text);
  const scan = scanUnreadFiles(root, ['scripts/edge.js'], NAMES, Buffer.byteLength(text));
  assert.equal(scan.failure, null);
  assert.deepEqual([...scan.tables], [['User', 'scripts/edge.js']]);
  assert.ok(UNREAD_MAX_BYTES >= 1024 * 1024);
});

test('a dangling symlink fails the scan with the code and the relative path, not an absolute path', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts'));
  fs.symlinkSync('missing.js', nodePath.join(root, 'scripts', 'dangling.js'));
  const scan = scanUnreadFiles(root, ['scripts/dangling.js'], NAMES);
  assert.equal(scan.failure, 'scripts/dangling.js could not be read (ENOENT)');
});

test('an unreadable file fails the scan with the code and no absolute path', (t) => {
  const setpriv = spawnSync('setpriv', ['--version']);
  if (process.platform !== 'linux' || setpriv.status !== 0 || process.getuid?.() !== 0) {
    t.skip('needs root and setpriv to read as another user');
    return;
  }
  // Under /tmp, not os.tmpdir(): the other user must be able to traverse every ancestor, and a
  // private TMPDIR (mode 0700 somewhere above) would fail the root before the file.
  const root = fs.mkdtempSync(nodePath.join('/tmp', 'seamline-unread-'));
  dirs.push(root);
  fs.chmodSync(root, 0o755);
  fs.mkdirSync(nodePath.join(root, 'scripts'), { mode: 0o755 });
  const file = nodePath.join(root, 'scripts', 'locked.js');
  fs.writeFileSync(file, WRITER, { mode: 0o600 });
  const probe = `
    import { scanUnreadFiles } from ${JSON.stringify(new URL('./unread-files.ts', import.meta.url).href)};
    const names = { delegates: new Map(), exports: new Map(), exact: new Map([['User', ['User']]]), folded: new Map() };
    console.log(JSON.stringify(scanUnreadFiles(process.argv[1], ['scripts/locked.js'], names).failure));
  `;
  const out = spawnSync(
    'setpriv',
    [
      '--reuid',
      '65534',
      '--regid',
      '65534',
      '--clear-groups',
      process.execPath,
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      probe,
      root,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(out.status, 0, out.stderr);
  const failure: string = JSON.parse(out.stdout);
  assert.equal(failure, 'scripts/locked.js could not be read (EACCES)');
});

test('a directory or a FIFO named like a source file is skipped without failing the scan', () => {
  const root = scratch();
  fs.mkdirSync(nodePath.join(root, 'scripts', 'dir.js'), { recursive: true });
  const fifo = spawnSync('mkfifo', [nodePath.join(root, 'scripts', 'pipe.js')]);
  const paths = ['scripts/dir.js'];
  if (fifo.status === 0) paths.push('scripts/pipe.js');
  const scan = scanUnreadFiles(root, paths, NAMES);
  assert.equal(scan.failure, null);
  assert.equal(scan.markedFiles, 0);
  assert.deepEqual([...scan.tables], []);
});
