# @seamline/extract-contracts

> **No measured precision or recall; do not rely on Seamline as a gate.** This is an early release. The one recorded measurement was made on a draft source tree: it produced zero findings and detected 0 of 11 injected mutants. Details are in the [repository README](https://github.com/zylver-solutions/seamline#what-works-today-and-what-does-not).

API-contract facts at provenance `EXTRACTED`: OpenAPI 3.x (YAML and JSON), standalone JSON Schema, and Zod schemas in TypeScript source, emitted as `Contract`, `Operation`, `SchemaProperty`, and `RouteHandler` nodes.

## Install

```bash
npm install @seamline/extract-contracts
```

Requires Node.js 22.13 or later. Most users should not install or import this directly: `seamline extract` in `@seamline/cli` runs it as part of the normal pipeline. Import it directly only if you are building a tool that needs to run this extractor standalone. `typescript` is an optional peer dependency.

## Usage

```js
import { extractContracts } from '@seamline/extract-contracts';

const { result, nodes, edges } = extractContracts({
  repoRoot: process.cwd(),
  repo: 'my-repo',
  runId: 'run-1',
});
console.log(result.status, nodes.length, edges.length);
```

From `seamline.config.json`, this extractor's `options` accept `files`: explicit repo-relative POSIX paths to consider. When it is omitted the extractor discovers candidates under the repository root.

Main exports:

- `extractContracts`, and the `ContractsExtraction` type: the extractor entry point.
- `MANIFEST`, `CONTRACTS_SCOPE`, `EXTRACTOR_NAME`, `EXTRACTOR_VERSION` — the extractor manifest.
- `TYPE_CATEGORIES`, `AUTH_MODES`, `AUTH_SOURCES`, `CONTRACT_DIALECTS`, `DEFAULT_LIMITS`, and the `TypeCategory`, `AuthMode`, `AuthSource`, `ContractDialect`, `DeclaredAuth`, `ExtractLimits`, `ExtractOptions`, `ContractFact`, `OperationFact`, `PropertyFact` types.
- `categorizeJsonType`, `unifyCategories`, `readTypeField` — JSON Schema type normalization.
- `resolveAuth`, `readHandler`, `isOpenApiDocument`, `openApiPathToRouteParams` — OpenAPI-specific handling.
- `isJsonSchemaDocument` — JSON Schema document detection.
- `mentionsZod` — Zod schema detection in TypeScript source.
- `contractCanonicalName`, `operationCanonicalName`, `schemaPropertyCanonicalName`, `routeHandlerCanonicalName`, `InvalidEdgeError` — identity construction and edge validation.
- `isRemoteReference`, `toRepoRelativePosix`, `REFUSAL_REMOTE`, `REFUSAL_ESCAPE`, `REFUSAL_TOO_LARGE` — safe file resolution, refusing remote `$ref`s, path escapes, and oversized documents.

**Unsupported Zod degrades per schema, not per scope.** A Zod construct the static lowering cannot read makes exactly the facts it hides unknown, never absent and never defaulted. If it hides one property's type, enum members or presence (an unrecognised modifier on a scalar, a masked `partial`, `z.nativeEnum`), the property is still emitted and the unknown facet props are left off the node. If it hides the schema's property set (an expression, mutation, reference, cycle, shape, lazy, parse or depth/work-limit failure, or a modifier on something with nested properties), the contract and its properties are not emitted at all. Neither fails the scope. In the second case the `contracts` claim carries a `selector` naming only the contract sources the run read to the end (`dir/**` for a directory with no unvouched file beneath it, file by file otherwise, sorted), so a contract an earlier run read from a file that is now unreadable is not tombstoned. Two declarations of one contract name never merge: both are withheld, with a `CONTRACT_NAME_COLLISION` diagnostic, and their files leave the claim, because identity is path-free. OpenAPI and JSON documents named as contracts (or listed explicitly) keep their all-or-nothing behavior, since operations are read by detectors that reason from absence; a discovered document under another name that cannot be read or parsed is left out of the claim, even when no contract header survives. JSON documents, including config files, accept line and block comments as whitespace; their values still use the JSON grammar, so trailing commas and YAML syntax are refused. A filename never exempts a document from contract detection. Malformed config files still produce conservative partial coverage notices. See [the input boundary](https://github.com/zylver-solutions/seamline/blob/main/docs/design/json-document-comments.md). Every emitted Contract and Operation records the count as `unreadStructuredDocuments`, including zero. X9 reports UNKNOWN when that coverage is missing, invalid or incomplete, because unread documents may declare operations. A file that leaves the claim keeps what an earlier run read from it: those facts stay live, without being re-observed, until a run reads the file again, so a finding can rest on them in the meantime. `seamline check` and `seamline why` flag this with a partial coverage notice naming the number of files not read. The reasoning, the per-reason classification and the known limits are in [`docs/design/zod-composition-coverage.md`](https://github.com/zylver-solutions/seamline/blob/main/docs/design/zod-composition-coverage.md).

**Bounded local validated writes.** In eligible Next 16.2.6 App Router method declarations, the extractor can read a function-local immutable Zod object when source summaries prove successful request-body parsing and unchanged forwarding into one Prisma scalar model field. It emits request `SchemaProperty` facts with `lengthUpperState`, binding flags, storage identity and a repository-relative `bindingWitness`. A plain string, optionally nullable or optional, is positively unbounded; one literal `max` or `length` is bounded. Refinements, transforms, regexes, dynamic limits and unsupported ancestors are unknown. A missing constraint is never evidence of an unbounded validator.

The source grammar resolves relative imports, barrels and single-target tsconfig paths. It inspects JavaScript for alias and cache-write completeness, without executing source, generated clients, install hooks or database requests. The fixed budgets are 32 resolved modules, 64 resolutions per module and 10000 syntax nodes per binding. A complete inventory is required to prove a singleton's source writers. Unknown bindings and duplicate natural keys withhold contracts and remove their files from deletion authority. See [the design](https://github.com/zylver-solutions/seamline/blob/main/docs/design/x7-upper-length.md) for the exact grammar, reviewed library summaries and acceptance requirements. These facts describe inspected source, not arbitrary external runtime state.

X7 additionally requires current successful extraction authority for its endpoint facts. Retained live facts outside the latest claim cannot justify an X7 finding, even when a deterministic run id repeats. The standalone top-level Zod producer and its identities keep their existing behavior.

**Stability tier: library surface.** Published, importable, documented as unstable below 1.0.

See the [repository README](https://github.com/zylver-solutions/seamline#readme) and [design v3](https://github.com/zylver-solutions/seamline/blob/main/docs/design/v3.md). License: Apache-2.0 ([LICENSE](https://github.com/zylver-solutions/seamline/blob/main/LICENSE)).
