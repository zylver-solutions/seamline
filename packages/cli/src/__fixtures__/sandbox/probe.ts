/**
 * A purpose-built extractor for the sandbox tests.
 *
 * It does one thing per run, chosen by `ctx.options.mode`, and reports what
 * happened as diagnostics on an otherwise well-formed PASS result. Each mode is
 * something a real extractor must not be able to do (or, for `ok`, must be
 * able to do). The same module is run twice by the tests: directly, in the
 * test process, to show the capability exists, and through the sandbox host,
 * to show the host takes it away.
 */

import childProcess, { spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createHash, pbkdf2, pbkdf2Sync } from 'node:crypto';
import type { ExtractContext, ExtractorOutput } from '../../ports.ts';

type Opts = Readonly<Record<string, unknown>>;

/** Who the probe says it is, and the scope it claims. Both can be set per run to stand in for a real extractor. */
let identity = { name: 'probe', scope: 'probe' };

function result(diagnostics: ReadonlyArray<string>, nodeCount = 0, edgeCount = 0) {
  return {
    extractor: identity.name,
    version: '0.0.1',
    status: 'PASS' as const,
    authoritative: [{ scope: identity.scope, kinds: ['File' as const] }],
    nodeCount,
    edgeCount,
    durationMs: 0,
    diagnostics: [...diagnostics],
  };
}

function report(findings: Record<string, string>): ExtractorOutput {
  return { result: result(Object.entries(findings).map(([k, v]) => `${k}=${v}`)), nodes: [], edges: [] };
}

function node(id: string, provenance: 'EXTRACTED' | 'INFERRED', props: Record<string, string> = {}) {
  return {
    id: id as never,
    kind: 'File' as const,
    name: id,
    sensitivity: 'internal' as const,
    provenance,
    confidence: 1,
    props,
    firstSeenRun: 'run-1',
    lastSeenRun: 'run-1',
    deletedAt: null,
  };
}

function outcome(fn: () => unknown): string {
  try {
    const v = fn();
    return typeof v === 'string' ? `got:${v.trim()}` : 'ok';
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { detail?: string };
    return `threw:${err.name === 'SandboxViolation' ? (err as unknown as { code: string }).code : (err.code ?? err.name)}`;
  }
}

async function outcomeAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    const v = await fn();
    return typeof v === 'string' ? `got:${v.trim()}` : 'ok';
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return `threw:${err.name === 'SandboxViolation' ? (err as unknown as { code: string }).code : (err.code ?? err.name)}`;
  }
}

function strings(opts: Opts, key: string): string[] {
  const v = opts[key];
  return Array.isArray(v) ? v.map(String) : [];
}

export async function run(ctx: ExtractContext): Promise<ExtractorOutput> {
  const opts = ctx.options;
  identity = {
    name: typeof opts['name'] === 'string' ? opts['name'] : 'probe',
    scope: typeof opts['scope'] === 'string' ? opts['scope'] : 'probe',
  };
  switch (opts['mode']) {
    case 'ok': {
      // Reads one declared file and derives a node from it: output that depends on the read.
      const path = String(opts['path'] ?? 'src/a.txt');
      const text = fs.readFileSync(path, 'utf8');
      const digest = createHash('sha256').update(text).digest('hex').slice(0, 12);
      return {
        result: result(['read a declared file'], 1, 0),
        nodes: [node(`probe:File:${path}`, 'EXTRACTED', { digest })],
        edges: [],
      };
    }

    case 'env': {
      const names = strings(opts, 'names');
      const seen: Record<string, string> = {};
      for (const name of names) seen[`env.${name}`] = process.env[name] ?? 'undefined';
      seen['env.keys'] = Object.keys(process.env).sort().join(',');
      return report(seen);
    }

    case 'read': {
      const found: Record<string, string> = {};
      for (const path of strings(opts, 'paths')) {
        found[`readFileSync:${path}`] = outcome(() => fs.readFileSync(path, 'utf8'));
      }
      return report(found);
    }

    case 'saturate': {
      // Many distinct looks at names under a directory that is a link out of the repo, each one a
      // refusal that fails the run, and then one read of a file outside it. The guard keeps a bounded
      // log; the read must not be the entry it drops.
      const dir = String(opts['dir']);
      const count = Number(opts['count']);
      for (let i = 0; i < count; i += 1) outcome(() => fs.statSync(`${dir}/a${i}`));
      const path = String(opts['path']);
      return report({ [`readFileSync:${path}`]: outcome(() => fs.readFileSync(path, 'utf8')) });
    }

    case 'list': {
      // Looks at directories: what a walker does before it reads anything.
      const found: Record<string, string> = {};
      for (const path of strings(opts, 'paths')) {
        found[`readdirSync:${path}`] = outcome(() => fs.readdirSync(path).sort().join(','));
        found[`statSync:${path}`] = outcome(() => (fs.statSync(path).isDirectory() ? 'directory' : 'other'));
        found[`promises.readdir:${path}`] = await outcomeAsync(async () =>
          (await fs.promises.readdir(path)).sort().join(','),
        );
      }
      return report(found);
    }

    case 'read-apis': {
      // Every way of opening a file for reading, against one path.
      const path = String(opts['path']);
      const found: Record<string, string> = {};
      found['readFileSync'] = outcome(() => fs.readFileSync(path, 'utf8'));
      found['openSync'] = outcome(() => {
        const fd = fs.openSync(path, 'r');
        const text = fs.readFileSync(fd, 'utf8');
        fs.closeSync(fd);
        return text;
      });
      found['promises.readFile'] = await outcomeAsync(() => fs.promises.readFile(path, 'utf8'));
      found['promises.open'] = await outcomeAsync(async () => {
        const handle = await fs.promises.open(path, 'r');
        try {
          return await handle.readFile('utf8');
        } finally {
          await handle.close();
        }
      });
      found['readFile(cb)'] = await outcomeAsync(
        () =>
          new Promise((resolve, reject) => {
            try {
              fs.readFile(path, 'utf8', (err, data) => (err ? reject(err) : resolve(data)));
            } catch (e) {
              reject(e);
            }
          }),
      );
      found['createReadStream'] = await outcomeAsync(
        () =>
          new Promise((resolve, reject) => {
            try {
              const chunks: Buffer[] = [];
              fs.createReadStream(path)
                .on('data', (c) => chunks.push(c as Buffer))
                .on('error', reject)
                .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
              reject(e);
            }
          }),
      );
      return report(found);
    }

    case 'probe-outside': {
      // Looks at things outside the repo, the way a tool walking up a directory tree does, and carries on.
      const target = String(opts['path']);
      const found: Record<string, string> = {};
      found['existsSync'] = String(fs.existsSync(target));
      found['statSync'] = outcome(() => fs.statSync(target).isFile());
      found['readdirSync'] = outcome(() => fs.readdirSync(target).length);
      found['realpathSync'] = outcome(() => fs.realpathSync(target));
      return report(found);
    }

    case 'swallow': {
      // Tries a forbidden read, hides the error, and reports a clean PASS anyway.
      try {
        fs.readFileSync(String(opts['path']), 'utf8');
      } catch {
        // swallowed
      }
      return report({ outcome: 'looked fine from in here' });
    }

    case 'write': {
      const found: Record<string, string> = {};
      found['writeFileSync'] = outcome(() => fs.writeFileSync(String(opts['path']), 'x'));
      found['mkdirSync'] = outcome(() => fs.mkdirSync(String(opts['dir']), { recursive: true }));
      return report(found);
    }

    case 'net': {
      const port = Number(opts['port']);
      const found: Record<string, string> = {};
      found['net.connect'] = await outcomeAsync(
        () =>
          new Promise((resolve, reject) => {
            const socket = net.connect({ host: '127.0.0.1', port }, () => {
              socket.destroy();
              resolve('connected');
            });
            socket.on('error', reject);
          }),
      );
      found['fetch'] = await outcomeAsync(async () => (await fetch(`http://127.0.0.1:${port}/`)).status);
      found['http.get'] = await outcomeAsync(
        () =>
          new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port }, (res) => {
              res.resume();
              resolve(`status ${res.statusCode}`);
            }).on('error', reject);
          }),
      );
      found['dns.lookup'] = await outcomeAsync(
        () =>
          new Promise((resolve, reject) => {
            dns.lookup('localhost', (err, address) => (err ? reject(err) : resolve(address)));
          }),
      );
      found['dns.promises.lookup'] = await outcomeAsync(() => dns.promises.lookup('localhost'));
      return report(found);
    }

    case 'exec': {
      const found: Record<string, string> = {};
      // A PATH of the call's own, which a lookup by bare name would search instead of the child's.
      const callPath = typeof opts['callPath'] === 'string' ? opts['callPath'] : undefined;
      for (const cmd of strings(opts, 'commands')) {
        found[`spawnSync:${cmd}`] = outcome(() => {
          const r = spawnSync(cmd, ['--version'], {
            encoding: 'utf8',
            ...(callPath === undefined ? {} : { env: { PATH: callPath } }),
          });
          if (r.error) throw r.error;
          return r.status === 0 ? 'ran' : `exit ${String(r.status)}`;
        });
      }
      if (opts['shell'] === true) {
        found['spawnSync:shell'] = outcome(() => {
          const r = spawnSync('echo hi', { shell: true, encoding: 'utf8' });
          if (r.error) throw r.error;
          return 'ran';
        });
      }
      return report(found);
    }

    case 'shell-getter': {
      // The options object answers "no shell" the first time it is asked and "a shell" every time
      // after, so a check that reads it and a start that reads it again do not see the same thing.
      // `; echo SHELLRAN` is run only by a shell.
      const found: Record<string, string> = {};
      for (const cmd of strings(opts, 'commands')) {
        let reads = 0;
        found[`spawnSync:${cmd}`] = outcome(() => {
          const r = spawnSync(cmd, ['--version', '; echo SHELLRAN'], {
            encoding: 'utf8',
            get shell() {
              reads += 1;
              return reads > 1;
            },
          });
          if (r.error) throw r.error;
          return String(r.stdout).includes('SHELLRAN') ? 'through-a-shell' : 'no-shell';
        });
      }
      return report(found);
    }

    case 'execve': {
      // Replaces this process with the program. Where it is not refused, nothing comes back.
      const execve = (process as { execve?: (file: string, args: string[], env: object) => void })
        .execve;
      if (typeof execve !== 'function') return report({ execve: 'absent' });
      const found: Record<string, string> = {};
      for (const cmd of strings(opts, 'commands')) {
        found[`execve:${cmd}`] = outcome(() => {
          execve.call(process, cmd, [cmd, '--version'], {});
          return 'returned';
        });
      }
      return report(found);
    }

    case 'promisify': {
      // `util.promisify` finds its hook on the function it is given, so it shows whether a wrapper kept it.
      const found: Record<string, string> = {};
      for (const cmd of strings(opts, 'commands')) {
        found[`promisify(execFile):${cmd}`] = await outcomeAsync(async () => {
          const r: unknown = await promisify(childProcess.execFile)(cmd, ['--version']);
          if (typeof r === 'string') return 'resolved a string';
          const both = r as { stdout?: unknown; stderr?: unknown };
          return typeof both.stdout === 'string' && typeof both.stderr === 'string'
            ? 'resolved stdout and stderr'
            : 'resolved something else';
        });
      }
      if (opts['exec'] === true) {
        found['promisify(exec)'] = await outcomeAsync(async () => {
          await promisify(childProcess.exec)('git --version');
          return 'ran';
        });
      }
      return report(found);
    }

    case 'exit-background-gc': {
      /*
       * Diagnostic scenario adapted from nodejs/node#66171 (MIT):
       * https://github.com/nodejs/node/blob/58e671dc67095b1525bec332de62538c4636a3b2/test/parallel/test-process-exit-background-gc.js
       *
       * Copyright Node.js contributors. All rights reserved.
       *
       * Permission is hereby granted, free of charge, to any person obtaining a copy
       * of this software and associated documentation files (the "Software"), to
       * deal in the Software without restriction, including without limitation the
       * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
       * sell copies of the Software, and to permit persons to whom the Software is
       * furnished to do so, subject to the following conditions:
       *
       * The above copyright notice and this permission notice shall be included in
       * all copies or substantial portions of the Software.
       *
       * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
       * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
       * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
       * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
       * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
       * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
       * IN THE SOFTWARE.
       */
      // Schedule libuv work and allocate before forced exit. The test-only V8
      // stress flag can strand a worker in the unmitigated runtime; the sandbox
      // mitigation disables V8 background tasks, including that stress mode.
      const retained = Array.from({ length: 100_000 }, (_, index) => ({ index }));
      const started = process.hrtime.bigint();
      pbkdf2Sync('shutdown-probe', 'salt', 100_000, 64, 'sha512');
      const nsPerIteration = Number(process.hrtime.bigint() - started) / 100_000;
      const iterations = Math.ceil(1e9 / nsPerIteration);
      await new Promise((resolve) => setTimeout(resolve, 300));
      pbkdf2('shutdown-probe', 'salt', iterations, 64, 'sha512', () => {
        if (retained.length !== 100_000) process.exitCode = 1;
      });
      for (let index = 0; index < 50; index += 1) new Array<number>(100_000).fill(index);
      return report({ shutdownProbe: String(retained.length) });
    }

    case 'exit-wait': {
      // A complete response cannot justify PASS while the process is still alive.
      process.once('exit', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
      return {
        result: result(['response before blocked exit'], 1, 0),
        nodes: [node('probe:File:src/a.txt', 'EXTRACTED')],
        edges: [],
      };
    }

    case 'busy':
      if (typeof opts['stderr'] === 'string') process.stderr.write(opts['stderr']);
      fs.writeSync(4, '[seamline-child-phase:injected]\n');
      for (;;) {
        // never yields: only a kill from outside can end this
      }

    case 'alloc': {
      // Retains arrays of numbers until `sizeMb` megabytes are held, then reports success.
      const sizeMb = Number(opts['sizeMb']);
      const held: number[][] = [];
      for (let mb = 0; mb < sizeMb; mb += 8) held.push(new Array<number>(1_000_000).fill(mb));
      return report({ allocated: `${held.length * 8}MB` });
    }

    case 'buffer': {
      // Off-heap memory the V8 heap cap does not see. Touched, so it counts as resident.
      const sizeMb = Number(opts['sizeMb']);
      const held: Buffer[] = [];
      for (let mb = 0; mb < sizeMb; mb += 32) {
        const chunk = Buffer.alloc(32 * 1024 * 1024, 1);
        held.push(chunk);
        // Give the host's sampler time to see it; a real runaway extractor would be busy too.
        const until = Date.now() + 15;
        while (Date.now() < until) {
          // spin
        }
      }
      return report({ allocated: `${held.length * 32}MB` });
    }

    case 'ceiling': {
      const provenance: 'EXTRACTED' | 'INFERRED' = opts['provenance'] === 'INFERRED' ? 'INFERRED' : 'EXTRACTED';
      if (opts['on'] === 'edge') {
        const edge = {
          kind: 'IMPORTS' as const,
          src: 'probe:File:a' as never,
          dst: 'probe:File:b' as never,
          provenance,
          confidence: 1,
          props: {},
          firstSeenRun: 'run-1',
          lastSeenRun: 'run-1',
          deletedAt: null,
        };
        return { result: result([`emitted a ${provenance} edge`], 0, 1), nodes: [], edges: [{ scope: 'probe', edges: [edge] }] };
      }
      return {
        result: result([`emitted a ${provenance} node`], 1, 0),
        nodes: [node('probe:File:a', provenance)],
        edges: [],
      };
    }

    case 'scope':
      return {
        result: { ...result(['claimed someone else\'s scope']), authoritative: [{ scope: 'code.ts', kinds: ['File'] }] },
        nodes: [],
        edges: [],
      };

    case 'probe-then-read': {
      // Looks at a path and then reads it, swallowing both refusals, and reports a clean PASS.
      const target = String(opts['path']);
      return report({
        statSync: outcome(() => fs.statSync(target).isFile()),
        readFileSync: outcome(() => fs.readFileSync(target, 'utf8')),
      });
    }

    case 'big':
      // A result of about `bytes` bytes.
      return report({ filler: 'x'.repeat(Number(opts['bytes'] ?? 0)) });

    case 'kind': {
      // A node of a kind the manifest does not produce (the manifest in the tests produces File only).
      const kind = String(opts['kind'] ?? 'Table');
      return {
        result: result([`emitted a ${kind} node`], 1, 0),
        nodes: [{ ...node(`probe:${kind}:a`, 'EXTRACTED'), kind } as never],
        edges: [],
      };
    }

    case 'canonical':
      return {
        result: { ...result(['canonical authority'], 2), authoritative: [
          { scope: identity.scope, kinds: ['File'], selector: String(opts['selector']) },
        ] },
        nodes: ['src/a.txt', 'src/b.txt'].map(path => ({ ...node(`probe:File:${path}`, 'EXTRACTED'), path })),
        edges: [],
      };

    case 'selector':
      // The scope it does produce, with whatever selector it likes: the selector bounds a PASS's tombstoning.
      return {
        result: {
          ...result(['claimed a selector']),
          authoritative: [{ scope: identity.scope, kinds: ['File'], selector: String(opts['selector']) }],
        },
        nodes: [],
        edges: [],
      };

    case 'malformed':
      return { result: { status: 'GREAT' } } as unknown as ExtractorOutput;

    case 'exit':
      process.exit(Number(opts['code'] ?? 7));
    // falls through never: process.exit does not return
    case 'throw':
      throw new Error(String(opts['message'] ?? 'boom'));

    case 'chatty': {
      // Writes to stdout and stderr, which must never be mistaken for a result.
      process.stdout.write('{"v":1,"ok":true,"output":{"forged":true},"denials":[]}\n');
      process.stderr.write('some noise on stderr\n');
      return report({ outcome: 'quiet result' });
    }

    default:
      throw new Error(`unknown probe mode ${String(opts['mode'])}`);
  }
}
