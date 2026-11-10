# @seamline/ontology

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

The typed contract every Seamline package builds against: node kinds, edge kinds, domain/range restrictions, sensitivity defaults, provenance precedence, and identity rules. This code is the compiled mirror of `ontology/seamline.yaml`, kept in sync by `ontology/lint.mjs` as a release gate.

## Install

```bash
npm install @seamline/ontology
```

Requires Node.js 22.13 or later. It has no dependencies. Most users should not install or import this directly: use `@seamline/cli` or `@seamline/mcp`, which already depend on it. Import it directly only if you are building a new extractor or another tool that needs to construct or validate graph facts against the same contract.

## Usage

```js
import {
  NODE_KINDS,
  EDGE_KINDS,
  nodeId,
  parseNodeId,
  isFact,
  isValidEdge,
} from '@seamline/ontology';

const id = nodeId('shop', 'Column', 'public.orders.shipped_at');
console.log(id); // shop:Column:public.orders.shipped_at
console.log(parseNodeId(id).kind); // Column
console.log(NODE_KINDS.length, EDGE_KINDS.length); // 29 26
console.log(isFact('EXTRACTED'), isFact('INFERRED')); // true false
console.log(isValidEdge('MAPS_TO_FIELD', 'Column', 'CodeField')); // true
```

It exports the full contents of `./contract.ts`: node and edge kind enums (`NODE_KINDS`, `EDGE_KINDS`), domain/range signature tables (`EDGE_SIGNATURES`, `isValidEdge`), sensitivity defaults (`DEFAULT_SENSITIVITY`), provenance ordering (`PROVENANCE_RANK`, `outranks`, `isFact`), the identity helpers (`nodeId`, `parseNodeId`, for ids of the form `{repo}:{kind}:{canonicalName}`) that every other package uses to construct ids, and the types of nodes, edges, runs, extractor manifests and contradictions (`SeamlineNode`, `SeamlineEdge`, `GraphView`, `GraphStore`).

**Stability tier: two tiers live in this one package, and they move independently.**

- The **code** (this package's exports) is **library surface**: published, importable, documented as unstable below 1.0.
- The **specification** it mirrors (`ontology/seamline.yaml`, the canonical SIF serialization, and the contradiction catalog X1–X10) is a separate **specification surface**: CC-BY-4.0, versioned independently of the code, and adoptable without adopting the code at all. Breaking the ontology requires a major bump. The automated evolution test that design v3 §7 specifies to flag a breaking change is not implemented yet, so reviewers apply that rule by hand.

The vocabulary is described in the [ontology README](https://github.com/zylver-solutions/seamline/blob/main/ontology/README.md) and the generated [ontology reference](https://github.com/zylver-solutions/seamline/blob/main/docs/reference/ontology.md); see also the [repository README](https://github.com/zylver-solutions/seamline#readme). License: Apache-2.0 for this code ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)); the specification text it mirrors is CC-BY-4.0.
