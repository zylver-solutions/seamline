// SPDX-License-Identifier: Apache-2.0
/** Native namespace eligibility, never execution of inspected modules. */
import type * as TS from 'typescript';
import { WriteUnknown, type WriteSource } from './write-source.ts';
import { lexicalBinding, literalKeys, writtenThrough } from './write-syntax.ts';

// Static union read from Node22.13.0 and24.22.0 builtinModules on the isolated
// verification host. A host-dependent table would change extraction by runtime.
const NATIVE_MODULES: ReadonlySet<string> = new Set([
  "_http_agent",
  "_http_client",
  "_http_common",
  "_http_incoming",
  "_http_outgoing",
  "_http_server",
  "_stream_duplex",
  "_stream_passthrough",
  "_stream_readable",
  "_stream_transform",
  "_stream_wrap",
  "_stream_writable",
  "_tls_common",
  "_tls_wrap",
  "assert",
  "assert/strict",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "dns/promises",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "inspector/promises",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "readline/promises",
  "repl",
  "sea",
  "sqlite",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "test",
  "test/reporters",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);
// Eligibility only: metadataLoads and the whole client proof must still establish
// private immutable createRequire used for package JSON, and readonly path uses.
const REVIEWED_NATIVE_NAMESPACES = new Set(['module', 'path']);

export function assertNativeCapabilitySummary(specifier: string, node: TS.Node): void {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if ((specifier.startsWith('node:') || NATIVE_MODULES.has(name)) && !REVIEWED_NATIVE_NAMESPACES.has(name))
    throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', node);
}

const PROCESS_DATA = new Set(['env', 'argv', 'execArgv', 'execPath', 'pid', 'ppid',
  'platform', 'arch', 'version', 'versions', 'release']);

/** A process capability or an escaping namespace has no readonly data summary. */
export function assertProcessCapabilitySummary(project: WriteSource, node: TS.Node): void {
  const ts = project.ts;
  if (!ts.isIdentifier(node) || node.text !== 'process' || lexicalBinding(ts, node) !== undefined) return;
  const use = node.parent;
  if ((ts.isPropertyAccessExpression(use) && use.name === node) ||
      (ts.isPropertyAssignment(use) && use.name === node)) return;
  const keys = ts.isPropertyAccessExpression(use) && use.expression === node ? [use.name.text] :
    ts.isElementAccessExpression(use) && use.expression === node ? literalKeys(project, use.argumentExpression) : undefined;
  if (keys === undefined || writtenThrough(ts, node) || keys.some(key => !PROCESS_DATA.has(key) && key !== 'cwd'))
    throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', node);
  if (keys.includes('cwd') && (!ts.isCallExpression(use.parent) || use.parent.expression !== use ||
      use.parent.arguments.length !== 0 || use.parent.questionDotToken !== undefined || use.parent.typeArguments !== undefined))
    throw new WriteUnknown('WRITE_NEXT_METHOD_INVOCATION_UNKNOWN', node);
}
