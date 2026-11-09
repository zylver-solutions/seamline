/**
 * HTTP route detection.
 *
 * A `RouteHandler`'s natural name is `METHOD /path` — the route as the network
 * sees it. That is already path-free of the filesystem, so moving the file that
 * registers the route does not change the node, which is the same identity
 * property symbols have.
 *
 * Two shapes are recognised, both common enough to be worth the code:
 *
 *  - **router calls** — `app.get('/users/:id', handler)`, which covers Express,
 *    Fastify, Hono, Koa-router, and Elysia. The call shape alone (a method name
 *    plus a `/`-prefixed literal) is not enough, because an HTTP client has the
 *    same shape: `api.get('/users')` is a request, not an endpoint. A router call
 *    is a route only when its receiver is a server router or app, which
 *    `receiver.ts` decides from the receiver's declaration.
 *  - **method decorators** — `@Get(':id')` inside `@Controller('users')`, which
 *    covers NestJS and its imitators. A decorator is declarative, so it needs no
 *    receiver evidence.
 *
 * Anything cleverer (a route table built at runtime, a filesystem router) is
 * deliberately not guessed at. A missed route is a scope gap the status envelope
 * can express; an invented route is a false fact.
 */

const HTTP_METHODS = ['all', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put'] as const;
export type HttpMethodName = (typeof HTTP_METHODS)[number];

const METHOD_SET: ReadonlySet<string> = new Set<string>(HTTP_METHODS);

/** `@Get`, `@Post`, ... — the decorator spelling of the same set. */
const DECORATOR_METHODS: ReadonlyMap<string, string> = new Map(
  HTTP_METHODS.map((m) => [m.charAt(0).toUpperCase() + m.slice(1), m.toUpperCase()]),
);

export interface DetectedRoute {
  /** Upper-case HTTP method, or `ALL`. */
  readonly method: string;
  /** Route pattern, always starting with `/`, with duplicate and trailing slashes removed. */
  readonly path: string;
  readonly style: 'router-call' | 'decorator';
}

/** True when `name` is a router method such as `get` or `post`. */
export function isRouterMethod(name: string): boolean {
  return METHOD_SET.has(name);
}

/** Map a decorator name (`Get`) to its HTTP method (`GET`), or `null`. */
export function decoratorHttpMethod(decoratorName: string): string | null {
  return DECORATOR_METHODS.get(decoratorName) ?? null;
}

/**
 * Normalize a route pattern: leading slash, no duplicate slashes, no trailing
 * slash (except the root). Without this, `/users` and `/users/` are two nodes
 * for one endpoint and every downstream join double-counts.
 */
export function normalizeRoutePath(raw: string): string {
  const collapsed = `/${raw}`.replace(/\/{2,}/g, '/');
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return trimmed.length === 0 ? '/' : trimmed;
}

/** Join a controller base path and a method path into one normalized route. */
export function joinRoute(base: string, sub: string): string {
  return normalizeRoutePath(`${base}/${sub}`);
}

/**
 * True when a router-call argument is a plausible route literal.
 *
 * Requiring a leading `/` is a cheap first filter that drops `emitter.on('ready',
 * ...)` and `cache.get('key')`. It is not sufficient on its own, since
 * `cache.get('/key')` and `api.get('/users')` pass it; the receiver check in
 * `receiver.ts` is what separates a server from a client.
 */
export function isRouteLiteral(text: string): boolean {
  return text.startsWith('/');
}
