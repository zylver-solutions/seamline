/**
 * stdio transport. The only transport in this version.
 *
 * v3 §2.6: MCP in v0.1 is stdio-only, and there is no externally-reachable
 * query surface without a named consumer. There is deliberately no HTTP
 * listener here and no import that could open one.
 *
 * stdout carries protocol frames and nothing else — a stray `console.log`
 * would corrupt the stream — so diagnostics go to stderr.
 */

import { printable } from '@seamline/core';
import { failure, INVALID_REQUEST, LineFramer, encode } from './jsonrpc.ts';
import type { SeamlineMcpServer } from './server.ts';

/**
 * A `log` sink for a terminal: one escaped line per call. Log lines carry
 * internal-error detail that can quote repository text, and stderr is read by
 * a person, so control characters and line breaks are escaped (terminal escaping of repository text).
 */
export function terminalLog(write: (text: string) => void): (line: string) => void {
  return (line) => {
    write(`${printable(line)}\n`);
  };
}

export interface StdioStreams {
  readonly input: AsyncIterable<string | Uint8Array>;
  write(s: string): void;
  writeErr(s: string): void;
}

export function nodeStdio(): StdioStreams {
  process.stdin.setEncoding('utf8');
  return {
    input: process.stdin,
    write: (s) => {
      process.stdout.write(s);
    },
    writeErr: (s) => {
      process.stderr.write(s);
    },
  };
}

export interface ServeOptions {
  readonly maxLineBytes?: number;
}

/**
 * Reads frames until the input ends. Resolves when the peer closes stdin,
 * which is how an MCP client signals shutdown on this transport.
 */
export async function serveStdio(
  server: SeamlineMcpServer,
  streams: StdioStreams,
  opts: ServeOptions = {},
): Promise<void> {
  const framer = new LineFramer(opts.maxLineBytes ?? 1024 * 1024);

  for await (const chunk of streams.input) {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    const { lines, overflow } = framer.push(text);

    if (overflow) {
      streams.write(
        encode(failure(null, INVALID_REQUEST, 'message exceeded the maximum line length and was discarded')),
      );
      streams.writeErr('seamline-mcp: discarded an over-long input line\n');
    }

    for (const line of lines) {
      const reply = await server.handle(line);
      if (reply !== null) streams.write(reply);
    }
  }

  for (const line of framer.flush()) {
    const reply = await server.handle(line);
    if (reply !== null) streams.write(reply);
  }

  await server.close();
}
