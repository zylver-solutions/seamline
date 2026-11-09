// SPDX-License-Identifier: Apache-2.0
/**
 * A host may supply current-run authority without extending the frozen GraphView.
 * Stored liveness alone is insufficient: unread files deliberately retain facts.
 */
import type { GraphView, SeamlineNode } from '@seamline/ontology';

export type CurrentObservation = (scope: string, node?: SeamlineNode) => boolean;

interface ObservedGraph extends GraphView {
  readonly currentObservation: CurrentObservation | undefined;
}

export function observationView(g: GraphView, currentObservation?: CurrentObservation): GraphView {
  return {
    nodesByKind: (kind) => g.nodesByKind(kind),
    node: (id) => g.node(id),
    edgesFrom: (id, kind) => g.edgesFrom(id, kind),
    edgesTo: (id, kind) => g.edgesTo(id, kind),
    scopeStatus: (scope) => g.scopeStatus(scope),
    currentObservation,
  } as ObservedGraph;
}

export function currentlyObserved(g: GraphView, scope: string, node?: SeamlineNode): boolean {
  const observe = (g as Partial<ObservedGraph>).currentObservation;
  return typeof observe === 'function' && observe(scope, node) === true;
}
