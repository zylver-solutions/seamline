#!/usr/bin/env node
/**
 * The `seamline-mcp` binary: the protocol surface with no store behind it.
 *
 * The release entry point that serves a real store is `seamline mcp --profile
 * <name>` in `@seamline/cli`, which is where the store, the detectors and the
 * export profile are wired (the CLI is the one production composition root
 * for the store, per ADR-0011).
 *
 * Run standalone, this binary serves the protocol over an empty graph: it
 * answers `initialize` and `tools/list` correctly, and every tool call returns
 * a well-formed response whose `unknown` section says the graph is empty. That
 * is deliberate: an agent must never read "server not wired" as "nothing
 * exists in your codebase".
 */

import { PUBLIC_PROFILE } from '@seamline/core';
import type { GraphView, NodeId, NodeKind, RunRecord, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import type { GraphSource } from './ports.ts';
import { createServer } from './server.ts';
import { nodeStdio, serveStdio, terminalLog } from './stdio.ts';

const emptyView: GraphView = {
  nodesByKind: (_kind: NodeKind): ReadonlyArray<SeamlineNode> => [],
  node: (_id: NodeId): SeamlineNode | undefined => undefined,
  edgesFrom: (): ReadonlyArray<SeamlineEdge> => [],
  edgesTo: (): ReadonlyArray<SeamlineEdge> => [],
  // Not PASS: an unwired server has not verified anything.
  scopeStatus: () => 'UNAVAILABLE',
};

const unwiredRun: RunRecord = {
  runId: 'unwired',
  repo: 'unknown',
  commit: null,
  startedAt: '1970-01-01T00:00:00.000Z',
  finishedAt: null,
  ontologyVersion: '1.0.0',
  results: [
    {
      extractor: 'none',
      version: '0.0.0',
      status: 'UNAVAILABLE',
      authoritative: [{ scope: 'all', kinds: [] }],
      nodeCount: 0,
      edgeCount: 0,
      durationMs: 0,
      diagnostics: [
        'No graph store is wired into this build of seamline-mcp. Every answer is UNKNOWN, not empty. ' +
          'To serve an extracted repository, run `seamline mcp --profile <name>` from @seamline/cli.',
      ],
    },
  ],
};

const graph: GraphSource = {
  view: () => Promise.resolve(emptyView),
  latestRun: () => Promise.resolve(unwiredRun),
};

// The server is default-deny and requires a profile. The graph here is empty,
// so the narrowest shipped profile is the honest choice.
const server = createServer({
  graph,
  profile: PUBLIC_PROFILE,
  serverName: 'seamline',
  serverVersion: '0.1.0',
  // stderr is never a protocol channel, so internal-error detail may go there.
  log: terminalLog((text) => process.stderr.write(text)),
});
await serveStdio(server, nodeStdio());
