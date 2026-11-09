/**
 * OpenAPI 3.x extraction (YAML and JSON).
 *
 * Emits one `Contract`, one `Operation` per `(method, path)`, and one
 * `SchemaProperty` per declared property and parameter.
 */

import { isRecord, pointerAppend } from './json-pointer.ts';
import { walkSchemaTree, emitProperty, type WalkContext } from './schema-walk.ts';
import type { DocumentLoader, LoadedDocument } from './document.ts';
import type {
  AuthMode, AuthSource, ContractFact, DeclaredAuth, DocumentFacts,
  ExtractLimits, OperationFact, PropertyFact,
} from './types.ts';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const DEFAULT_SCHEMA_DIALECT = 'https://spec.openapis.org/oas/3.1/dialect/base';

function emptySchemaPolicy(root: Record<string, unknown>): WalkContext['emptySchemaNullability'] {
  const version = root['openapi'];
  if (!Object.prototype.hasOwnProperty.call(root, 'openapi') || typeof version !== 'string' ||
      !/^3\.1\.(0|[1-9][0-9]*)$/.test(version)) return undefined;
  return !Object.prototype.hasOwnProperty.call(root, 'jsonSchemaDialect') || root['jsonSchemaDialect'] === DEFAULT_SCHEMA_DIALECT
    ? 'allow-null' : 'unobserved';
}

/** Every existing OpenAPI schema entry is independent; nested walking cannot reset opacity. */
function schemaContext(ctx: WalkContext, schema: unknown): WalkContext {
  let policy = ctx.emptySchemaNullability;
  if (policy === undefined) return ctx;
  if (isRecord(schema) && Object.prototype.hasOwnProperty.call(schema, '$schema')) {
    policy = schema['$schema'] === DEFAULT_SCHEMA_DIALECT ? 'allow-null' : 'unobserved';
  }
  return { ...ctx, emptySchemaNullability: policy, emptySchemaRoot: true };
}

/** `true` when this parsed document is an OpenAPI 3.x description. */
export function isOpenApiDocument(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const v = value['openapi'];
  return (typeof v === 'string' || typeof v === 'number') && String(v).startsWith('3');
}

/**
 * Resolve the effective security requirement for one operation.
 *
 * The four modes are kept apart because X6 (PII reachable without auth) is
 * the only `critical` detector, and it must never fire on `unknown`:
 *
 *   `security: []`                 -> none      (explicitly public)
 *   `security: [{}]`               -> none      (explicitly public)
 *   `security: [{}, {bearer: []}]` -> optional  (anonymous admitted)
 *   `security: [{bearer: []}]`     -> required
 *   no `security` anywhere         -> unknown   (we could not tell)
 *
 * The OpenAPI specification's own default for an omitted root `security` is
 * "no security", but treating an omission as an assertion of publicness is
 * precisely what manufactures false criticals, so it is reported as unknown.
 */
export function resolveAuth(operationSecurity: unknown, documentSecurity: unknown): DeclaredAuth {
  let list: unknown[] | null = null;
  let source: AuthSource = 'absent';
  if (Array.isArray(operationSecurity)) {
    list = operationSecurity;
    source = 'operation';
  } else if (Array.isArray(documentSecurity)) {
    list = documentSecurity;
    source = 'document';
  }
  if (list === null) return { mode: 'unknown', source: 'absent', schemes: [], scopes: [] };

  const named = list.filter((r): r is Record<string, unknown> => isRecord(r) && Object.keys(r).length > 0);
  const anonymous = list.some((r) => isRecord(r) && Object.keys(r).length === 0);

  const schemes = new Set<string>();
  const scopes = new Set<string>();
  for (const req of named) {
    for (const scheme of Object.keys(req)) {
      schemes.add(scheme);
      const s = req[scheme];
      if (Array.isArray(s)) for (const sc of s) if (typeof sc === 'string') scopes.add(`${scheme}:${sc}`);
    }
  }

  let mode: AuthMode;
  if (named.length === 0) mode = 'none';
  else if (anonymous) mode = 'optional';
  else mode = 'required';

  return {
    mode,
    source,
    schemes: [...schemes].sort(),
    scopes: [...scopes].sort(),
  };
}

function normalizeHandler(ref: string): string {
  return ref.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * Convert OpenAPI's `{paramName}` path-templating syntax to the colon syntax
 * every framework `extract-code-ts` supports actually uses (`:paramName`),
 * and collapse repeated/trailing slashes the same way that package's own
 * `normalizeRoutePath` does. This is what lets a `RouteHandler` built from an
 * operation's `method` + `path` land on the exact same canonical name as the
 * `RouteHandler` `extract-code-ts` builds for the same real route, so the two
 * extractors' nodes converge into one instead of leaving `IMPLEMENTED_BY` and
 * `HANDLES_ROUTE` pointing at two different node ids for the same route.
 *
 * Duplicated rather than imported -- extractors do not depend on each other
 * (each runs under its own capability manifest, v3 §2.7) -- so
 * `packages/integration` asserts the two implementations agree, the same
 * pattern `contradictions/src/scopes.ts` already uses for its own duplicated
 * constants.
 */
export function openApiPathToRouteParams(path: string): string {
  const paramified = path.replace(/\{([^}]+)\}/g, ':$1');
  const collapsed = `/${paramified}`.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return trimmed.length === 0 ? '/' : trimmed;
}

/**
 * A declared handler binding, or null. This is provenance (which vendor
 * extension named a binding target, if any), not identity: the
 * `RouteHandler` node itself is always keyed by `method` + `path` (see
 * `buildGraph`), because that is the OpenAPI document's own unambiguous
 * statement of what route an operation is, independent of whether any vendor
 * extension is present. A bare `operationId` still does not count here; it is
 * a name, not a binding.
 */
export function readHandler(
  operation: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operationId: string | null,
): string | null {
  const direct = operation['x-seamline-handler'];
  if (typeof direct === 'string' && direct.trim() !== '') return normalizeHandler(direct);

  const controller = operation['x-openapi-router-controller'] ?? pathItem['x-openapi-router-controller'];
  if (typeof controller === 'string' && controller.trim() !== '' && operationId !== null) {
    return `${normalizeHandler(controller)}.${operationId}`;
  }
  const eov = operation['x-eov-operation-handler'] ?? pathItem['x-eov-operation-handler'];
  if (typeof eov === 'string' && eov.trim() !== '') {
    const eovId = operation['x-eov-operation-id'];
    const id = typeof eovId === 'string' ? eovId : operationId;
    return id === null ? normalizeHandler(eov) : `${normalizeHandler(eov)}.${id}`;
  }
  return null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Derive the contract name. `info.title` wins; the file stem is the fallback,
 * and only then does the name depend on the file name (ADR-0016 item 4).
 */
export function openApiContractName(doc: LoadedDocument): string {
  const root = isRecord(doc.value) ? doc.value : {};
  const info = isRecord(root['info']) ? root['info'] : {};
  const title = info['title'];
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  return fileStem(doc.relPosix);
}

export function fileStem(relPosix: string): string {
  const base = relPosix.slice(relPosix.lastIndexOf('/') + 1);
  return base.replace(/\.(ya?ml|json|ts|tsx|mts|cts)$/i, '');
}

export function extractOpenApi(
  loader: DocumentLoader,
  doc: LoadedDocument,
  limits: ExtractLimits,
): DocumentFacts {
  const root = isRecord(doc.value) ? doc.value : {};
  const info = isRecord(root['info']) ? root['info'] : {};
  const contract = openApiContractName(doc);

  const properties: PropertyFact[] = [];
  const policy = emptySchemaPolicy(root);
  const ctx: WalkContext = { loader, limits, contract, out: properties, emitted: new Set(),
    ...(policy === undefined ? {} : { emptySchemaNullability: policy }) };

  const contractFact: ContractFact = {
    name: contract,
    dialect: 'openapi',
    version: stringOrNull(info['version']),
    title: stringOrNull(info['title']),
    file: doc.relPosix,
  };

  // `components/schemas` is the canonical home of reusable shapes; walking it
  // first means an inline `$ref` to one of them never needs inlining.
  const components = isRecord(root['components']) ? root['components'] : {};
  const schemas = isRecord(components['schemas']) ? components['schemas'] : {};
  for (const name of Object.keys(schemas).sort()) {
    const schema = schemas[name];
    walkSchemaTree(schemaContext(ctx, schema), doc, schema, pointerAppend('', 'components', 'schemas', name), 0, new Set());
  }

  const operations: OperationFact[] = [];
  const paths = isRecord(root['paths']) ? root['paths'] : {};
  const documentSecurity = root['security'];

  for (const rawPath of Object.keys(paths).sort()) {
    const pathItem = paths[rawPath];
    if (!isRecord(pathItem)) continue;
    const pathPointer = pointerAppend('', 'paths', rawPath);

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      const opPointer = pointerAppend(pathPointer, method);
      const operationId = stringOrNull(operation['operationId']);

      operations.push({
        contract,
        method: method.toUpperCase(),
        path: rawPath,
        operationId,
        summary: stringOrNull(operation['summary']),
        deprecated: operation['deprecated'] === true,
        auth: resolveAuth(operation['security'], documentSecurity),
        handler: readHandler(operation, pathItem, operationId),
        file: doc.relPosix,
        jsonPointer: opPointer,
      });

      collectParameters(ctx, doc, pathItem['parameters'], pathPointer);
      collectParameters(ctx, doc, operation['parameters'], opPointer);
      collectBodySchemas(ctx, doc, operation['requestBody'], pointerAppend(opPointer, 'requestBody'));

      const responses = operation['responses'];
      if (isRecord(responses)) {
        for (const status of Object.keys(responses).sort()) {
          collectBodySchemas(ctx, doc, responses[status], pointerAppend(opPointer, 'responses', status));
        }
      }
    }
  }

  return { contracts: [contractFact], operations, properties, diagnostics: [], failed: false };
}

/**
 * OpenAPI parameters are schema properties with a location. Their presence
 * obligation comes from the parameter's own `required` field, not from a
 * parent `required` array; a `path` parameter is required by specification.
 */
function collectParameters(
  ctx: WalkContext,
  doc: LoadedDocument,
  parameters: unknown,
  pointer: string,
): void {
  if (!Array.isArray(parameters)) return;
  for (let i = 0; i < parameters.length; i += 1) {
    const parameter = parameters[i];
    if (!isRecord(parameter)) continue;
    const name = parameter['name'];
    if (typeof name !== 'string') continue;
    const location = typeof parameter['in'] === 'string' ? parameter['in'] : null;
    const required = parameter['required'] === true || location === 'path';
    const paramPointer = pointerAppend(pointer, 'parameters', String(i));
    const schema = parameter['schema'];
    const schemaCtx = schemaContext(ctx, schema);
    emitProperty(
      schemaCtx, doc, schema, pointerAppend(paramPointer, 'schema'), name,
      location === null ? { required } : { required, in: location },
      0, new Set(),
    );
    walkSchemaTree(schemaCtx, doc, schema, pointerAppend(paramPointer, 'schema'), 1, new Set());
  }
}

/** Walk every media type's schema under a requestBody / response object. */
function collectBodySchemas(
  ctx: WalkContext,
  doc: LoadedDocument,
  body: unknown,
  pointer: string,
): void {
  if (!isRecord(body)) return;
  const content = body['content'];
  if (!isRecord(content)) return;
  for (const mediaType of Object.keys(content).sort()) {
    const media = content[mediaType];
    if (!isRecord(media)) continue;
    const schema = media['schema'];
    walkSchemaTree(
      schemaContext(ctx, schema), doc, schema,
      pointerAppend(pointer, 'content', mediaType, 'schema'),
      1, new Set(),
    );
  }
}
