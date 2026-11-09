/**
 * JSON-RPC 2.0 over newline-delimited stdio.
 *
 * Implemented directly rather than with an SDK: the framing is one line of
 * JSON per message, the method set is five tools plus lifecycle, and v3 §2.7
 * and §10 make every runtime dependency supply-chain surface this project has
 * publicly committed to minimizing. There is no HTTP listener in this version
 * (v3 §2.6: stdio-only, no externally-reachable query surface).
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorBody;
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

export function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } };
}

/**
 * Parses one line. Returns a `JsonRpcResponse` when the line is unusable, so
 * the caller can reply without a second code path for error shapes.
 */
export function parseMessage(line: string): { request: JsonRpcRequest } | { response: JsonRpcResponse } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return { response: failure(null, PARSE_ERROR, `invalid JSON: ${(e as Error).message}`) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { response: failure(null, INVALID_REQUEST, 'a JSON-RPC message must be a JSON object') };
  }
  const rec = parsed as Record<string, unknown>;
  const id = isId(rec['id']) ? (rec['id'] as JsonRpcId) : null;
  if (rec['jsonrpc'] !== '2.0') {
    return { response: failure(id, INVALID_REQUEST, 'jsonrpc must be exactly "2.0"') };
  }
  if (typeof rec['method'] !== 'string' || rec['method'].length === 0) {
    return { response: failure(id, INVALID_REQUEST, 'method must be a non-empty string') };
  }
  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: rec['method'],
    ...(rec['id'] === undefined ? {} : { id }),
    ...(rec['params'] === undefined ? {} : { params: rec['params'] }),
  };
  return { request };
}

function isId(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || v === null;
}

/** A notification carries no `id` and must receive no reply. */
export function isNotification(r: JsonRpcRequest): boolean {
  return r.id === undefined;
}

/** Serializes to exactly one line: embedded newlines would break the framing. */
export function encode(message: JsonRpcResponse): string {
  return `${JSON.stringify(message).replace(/\r?\n/g, ' ')}\n`;
}

/**
 * Splits a byte stream into lines.
 *
 * `maxLineBytes` bounds the buffer: without it a peer that never sends a
 * newline grows the process's memory without limit. An over-long line is
 * reported once and the buffer is dropped, rather than being silently split
 * into two invalid messages.
 */
export class LineFramer {
  private buffer = '';
  readonly maxLineBytes: number;

  constructor(maxLineBytes = 1024 * 1024) {
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: string): { lines: readonly string[]; overflow: boolean } {
    this.buffer += chunk;
    let overflow = false;
    const lines: string[] = [];

    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length > 0) lines.push(line);
    }

    if (this.buffer.length > this.maxLineBytes) {
      overflow = true;
      this.buffer = '';
    }
    return { lines, overflow };
  }

  /** Any trailing partial line, for a peer that closed without a newline. */
  flush(): readonly string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? [rest] : [];
  }
}
