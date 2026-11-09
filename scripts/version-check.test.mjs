// SPDX-License-Identifier: Apache-2.0
//
// Tests for scripts/version-check.mjs. They run the script as a process on a
// throwaway workspace and assert the exit code: equal versions pass, and one
// drifting package, a stale VERSION constant, a wrong --expect or a missing
// CLI each fail.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'version-check.mjs');
const dirs = [];

const SLOT_FILES = {
  cli: 'cli/src/version.ts',
  server: 'mcp/src/server.ts',
  bin: 'mcp/src/bin.ts',
};
const producer = {
  cli: (version) => `export const VERSION = '${version}';\n`,
  server: (version) => `export function createServer(deps: { serverVersion?: string }) {\n` +
    `  const serverVersion = deps.serverVersion ?? '${version}';\n  return serverVersion;\n}\n`,
  bin: (version) => `import { createServer } from './server.ts';\n` +
    `const server = createServer({ serverVersion: '${version}' });\n`,
};

function workspace(versions, {
  constant = '1.2.3', mcpConstant = '1.2.3', mcpServerConstant = mcpConstant,
  mcpBinConstant = mcpConstant, skipCli = false, sources: sourceOverrides = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'version-check-'));
  dirs.push(root);
  for (const [name, spec] of Object.entries(versions)) {
    if (skipCli && name === 'cli') continue;
    const dir = join(root, 'packages', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    const manifest = typeof spec === 'string' ? { version: spec } : spec;
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@seamline/${name}`, ...manifest }));
  }
  const sources = {
    [SLOT_FILES.cli]: producer.cli(constant),
    [SLOT_FILES.server]: producer.server(mcpServerConstant),
    [SLOT_FILES.bin]: producer.bin(mcpBinConstant),
    ...sourceOverrides,
  };
  for (const [path, text] of Object.entries(sources)) {
    mkdirSync(dirname(join(root, 'packages', path)), { recursive: true });
    writeFileSync(join(root, 'packages', path), text);
  }
  return root;
}

function run(root, ...extra) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function slotResult(slot, text) {
  return run(workspace({ cli: '1.2.3', core: '1.2.3', mcp: '1.2.3' }, {
    sources: { [SLOT_FILES[slot]]: text },
  }));
}

function refusedSlot(slot, text, compiled = 'null') {
  const r = slotResult(slot, text);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`${SLOT_FILES[slot]} carries version ${compiled}, expected 1.2.3`), r.stderr);
  // A missing TypeScript installation or a subprocess error is not a semantic refusal.
  assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find package/);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('version-check', () => {
  it('passes when every published package and VERSION agree', () => {
    const r = run(workspace({ cli: '1.2.3', core: '1.2.3', mcp: '1.2.3' }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /3 published packages .* all at 1\.2\.3/);
  });

  it('fails and names the one package that drifted', () => {
    const r = run(workspace({ cli: '1.2.3', core: '1.2.3', mcp: '1.2.4' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /@seamline\/mcp is at "1\.2\.4", expected 1\.2\.3/);
    assert.doesNotMatch(r.stderr, /@seamline\/core/);
  });

  it('fails when the CLI VERSION constant is stale', () => {
    const r = run(workspace({ cli: '1.2.3', core: '1.2.3' }, { constant: '1.2.2' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /version.ts carries version "1\.2\.2", expected 1\.2\.3/);
  });

  it('fails when the MCP server version literal is stale', () => {
    const r = run(workspace({ cli: '1.2.3', mcp: '1.2.3' }, { mcpConstant: '0.0.1' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /server\.ts carries version "0\.0\.1"/);
    assert.match(r.stderr, /bin\.ts carries version "0\.0\.1"/);
  });

  it('fails for server default drift with the bin unchanged', () => {
    const r = run(workspace({ cli: '1.2.3', mcp: '1.2.3' }, { mcpServerConstant: '1.2.2' }));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /server\.ts carries version "1\.2\.2"/);
    assert.doesNotMatch(r.stderr, /bin\.ts carries version/);
  });

  it('fails for bin drift with the server default unchanged', () => {
    const r = run(workspace({ cli: '1.2.3', mcp: '1.2.3' }, { mcpBinConstant: '1.2.2' }));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /bin\.ts carries version "1\.2\.2"/);
    assert.doesNotMatch(r.stderr, /server\.ts carries version/);
  });

  it('ignores private packages', () => {
    const r = run(workspace({ cli: '1.2.3', eval: { version: '0.0.1', private: true } }));
    assert.equal(r.status, 0, r.stderr);
  });

  it('fails when --expect differs from the workspace version', () => {
    const r = run(workspace({ cli: '1.2.3', core: '1.2.3' }), '--expect', '1.2.4');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /expected 1\.2\.4/);
  });

  it('fails when the CLI package is absent', () => {
    const r = run(workspace({ core: '1.2.3' }, { skipCli: true }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /@seamline\/cli is not a published workspace package/);
  });

  for (const slot of Object.keys(SLOT_FILES)) {
    // These are inert source text. Only the checker process executes; the
    // inspected TypeScript modules are never imported or evaluated.
    const decoy = {
      cli: "export const VERSION = '1.2.3';",
      server: "const serverVersion = deps.serverVersion ?? '1.2.3';",
      bin: "serverVersion: '1.2.3'",
    }[slot];
    it(`${slot}: a commented correct version cannot hide an active stale literal`, () => {
      refusedSlot(slot, `/* ${decoy} */\n${producer[slot]('1.2.2')}`, '"1.2.2"');
    });
    it(`${slot}: a string correct version cannot hide an active stale literal`, () => {
      refusedSlot(slot, `const decoy = ${JSON.stringify(decoy)};\n${producer[slot]('1.2.2')}`, '"1.2.2"');
    });
    it(`${slot}: decoy-only source has no active slot`, () => {
      refusedSlot(slot, `/* ${decoy} */\nconst decoy = ${JSON.stringify(decoy)};\n`);
    });
    it(`${slot}: healthy comments and quoted punctuation do not affect the literal`, () => {
      const r = slotResult(slot, `/* ' ; } ?? : \" */\nconst note = "' }; ?? :";\n${producer[slot]('1.2.3')}`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /3 published packages .* all at 1\.2\.3/);
    });
    it(`${slot}: parse-invalid source cannot use an otherwise matching literal`, () => {
      refusedSlot(slot, `${producer[slot]('1.2.3')}\nconst broken = ;\n`);
    });
    it(`${slot}: equivalent double-quoted version literals are accepted`, () => {
      const r = slotResult(slot, producer[slot]('1.2.3').replace("'1.2.3'", '"1.2.3"'));
      assert.equal(r.status, 0, r.stderr);
    });
    it(`${slot}: inspected module effects are not executed`, () => {
      const r = slotResult(slot, `throw new Error('INSPECTED_MODULE_EXECUTED');\n${producer[slot]('1.2.3')}`);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /INSPECTED_MODULE_EXECUTED/);
    });
  }

  const unsupported = [
    ['cli', 'duplicate active VERSION declarations', producer.cli('1.2.3') + producer.cli('1.2.2')],
    ['cli', 'dynamic initializer', "export const VERSION = chooseVersion();\n"],
    ['cli', 'mutable declaration', "export let VERSION = '1.2.3';\n"],
    ['cli', 'non-exported declaration', "const VERSION = '1.2.3';\n"],
    ['cli', 'nested declaration', "function decoy() { const VERSION = '1.2.3'; }\n"],
    ['cli', 'template expression', 'export const VERSION = `1.2.3`;\n'],
    ['server', 'duplicate defaults', producer.server('1.2.3') + producer.server('1.2.2')],
    ['server', 'wrong dependency receiver', producer.server('1.2.3').replace('deps.serverVersion', 'other.serverVersion')],
    ['server', 'dynamic fallback', producer.server('1.2.3').replace("'1.2.3'", 'chooseVersion()')],
    ['server', 'wrong operator', producer.server('1.2.3').replace('??', '||')],
    ['server', 'default in unrelated function', producer.server('1.2.3').replace('createServer(', 'decoy(')],
    ['server', 'nested matching default', "export function createServer(deps: object) { function nested() { const serverVersion = deps.serverVersion ?? '1.2.3'; } }\n"],
    ['server', 'computed dependency lookup', producer.server('1.2.3').replace('deps.serverVersion', "deps['serverVersion']")],
    ['bin', 'duplicate version properties', producer.bin('1.2.3').replace("serverVersion: '1.2.3'", "serverVersion: '1.2.3', serverVersion: '1.2.2'")],
    ['bin', 'duplicate server declarations', producer.bin('1.2.3') + "const server = createServer({ serverVersion: '1.2.3' });\n"],
    ['bin', 'dynamic version property', producer.bin('1.2.3').replace("'1.2.3'", 'chooseVersion()')],
    ['bin', 'version in unrelated call', producer.bin('1.2.3').replace('const server = createServer(', 'const server = otherServer(')],
    ['bin', 'computed property', producer.bin('1.2.3').replace('serverVersion:', "['serverVersion']: ")],
    ['bin', 'spread overwrite', producer.bin('1.2.3').replace("serverVersion: '1.2.3'", "serverVersion: '1.2.3', ...other")],
    ['bin', 'shorthand property', producer.bin('1.2.3').replace("serverVersion: '1.2.3'", 'serverVersion')],
    ['bin', 'local wrapper hiding a stale real server version',
      "import { createServer as actualServer } from './server.ts';\n" +
      "function createServer(_advertised) { return actualServer({ serverVersion: '1.2.2' }); }\n" +
      "const server = createServer({ serverVersion: '1.2.3' });\n"],
    ['bin', 'wrong import module', producer.bin('1.2.3').replace("'./server.ts'", "'./other.ts'")],
    ['bin', 'type-only import clause', producer.bin('1.2.3').replace('import {', 'import type {')],
    ['bin', 'type-only import specifier', producer.bin('1.2.3').replace('{ createServer }', '{ type createServer }')],
    ['bin', 'missing value import', "const server = createServer({ serverVersion: '1.2.3' });\n"],
    ['bin', 'aliased producer binding', producer.bin('1.2.3').replace('{ createServer }', '{ createServer as aliased }').replace('= createServer(', '= aliased(')],
    ['bin', 'different export renamed to createServer', producer.bin('1.2.3').replace('{ createServer }', '{ other as createServer }')],
    ['bin', 'duplicate local function binding', producer.bin('1.2.3') + 'function createServer() { return null; }\n'],
    ['bin', 'parameter shadow binding', producer.bin('1.2.3') + 'function decoy(createServer) { return createServer; }\n'],
    ['bin', 'namespace import binding', producer.bin('1.2.3').replace('import { createServer }', 'import * as createServer')],
    ['bin', 'dynamic import binding',
      "const { createServer } = await import('./server.ts');\n" +
      "const server = createServer({ serverVersion: '1.2.3' });\n"],
  ];
  for (const [slot, label, text] of unsupported) {
    it(`${slot}: refuses ${label}`, () => refusedSlot(slot, text));
  }
});
