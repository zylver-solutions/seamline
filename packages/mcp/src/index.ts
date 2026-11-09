/**
 * `@seamline/mcp` — the Seamline MCP server.
 *
 * Serves graph context to AI coding agents over stdio, with parameterized
 * tools only. Wiring: construct `McpDeps` with a `GraphSource` implementation
 * and call `createServer`, then `serveStdio(server, nodeStdio())`.
 */

export { createServer, LATEST_PROTOCOL_VERSION, SERVER_INSTRUCTIONS, SUPPORTED_PROTOCOL_VERSIONS, toolResult } from './server.ts';
export type { SeamlineMcpServer } from './server.ts';
export { nodeStdio, serveStdio } from './stdio.ts';
export type { ServeOptions, StdioStreams } from './stdio.ts';
export {
  DEFAULT_BOUNDS,
  resolveBounds,
} from './ports.ts';
export type { AuditEvent, Bounds, DetectionReport, GraphSource, McpDeps, UnknownDetection } from './ports.ts';
export {
  capDepth,
  capList,
  capString,
  fitToByteBudget,
  mergeTruncation,
  NOT_TRUNCATED,
  truncation,
} from './bounds.ts';
export type { Truncation, TruncationReason, TruncationState } from './bounds.ts';
export {
  attemptedEscape,
  makeNonce,
  NEUTRALIZED,
  neutralize,
  UNTRUSTED_CLOSE_TOKEN,
  UNTRUSTED_OPEN_TOKEN,
  UNTRUSTED_PREAMBLE,
  wrapUntrusted,
} from '@seamline/security';
export { BYTES_PER_TOKEN, estimateTokens, MAX_TOKEN_BUDGET, MIN_TOKEN_BUDGET } from './budget.ts';
export { toJsonSchema, validateParams } from './validate.ts';
export type { ParamSchema, ParamSpec, ValidationResult } from './validate.ts';
export {
  bfs,
  containerOf,
  CONTEXT_EDGE_KINDS,
  IMPACT_EDGE_KINDS,
  LINEAGE_EDGE_KINDS,
  LINEAGE_TARGET_KINDS,
  neighbours,
  resolveNode,
  summarizeEdge,
  summarizeNode,
  renderContext,
} from './graph.ts';
export type { EdgeSummary, NodeSummary, RenderContext } from './graph.ts';
export { envelope, toolError, unknownScopes } from './result.ts';
export type { ToolEnvelope, UnknownScope } from './result.ts';
export { contextTool, contradictionsTool, explainTool, findTool, impactTool, lineageTool, TOOL_NAMES, TOOLS } from './tools/index.ts';
export type { Released, ToolContext, ToolDefinition } from './tools/registry.ts';
export {
  encode,
  failure,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  LineFramer,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  parseMessage,
  result,
} from './jsonrpc.ts';
export type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from './jsonrpc.ts';
