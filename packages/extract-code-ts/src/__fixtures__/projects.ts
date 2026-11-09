/**
 * Fixture projects, held as file maps rather than as real files on disk.
 *
 * Two reasons this is not a checked-in directory tree of `.ts` files:
 * a fixture must be materializable **twice, at two different absolute paths**
 * to prove no absolute path leaks into the output, and the rename test needs
 * the same project laid out under a different filename. A file map does both
 * with no filesystem juggling, and keeps the fixtures out of the package's own
 * compilation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

export type FileMap = Readonly<Record<string, string>>;

const PACKAGE_JSON = JSON.stringify({ name: '@fixture/app', version: '1.0.0', type: 'module' }, null, 2);

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      experimentalDecorators: true,
      allowImportingTsExtensions: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['src'],
  },
  null,
  2,
);

const MODELS_USER = `export interface Identifiable {
  id: string;
}

export abstract class BaseEntity implements Identifiable {
  id = '';
}

/** The field shapes this extractor's CodeField output is asserted against. */
export class User extends BaseEntity implements Identifiable {
  email = '';
  nickname?: string;
  deletedAt: Date | null = null;
  readonly createdAt: Date = new Date();
  loginCount = 0;
  isActive = true;
  tags: string[] = [];
  status: 'active' | 'banned' = 'active';
  profile?: Profile;
  private secret = 'hidden';
  static tableName = 'users';

  get displayName(): string {
    return this.nickname ?? this.email;
  }

  rename(next: string): void {
    this.nickname = next;
  }
}

export interface Profile {
  bio?: string;
  avatarUrl: string | null;
}

export type UserPatch = {
  email?: string;
  nickname?: string | null;
};
`;

const MODELS_BARREL = `export { User, BaseEntity } from './user.ts';
export type { Identifiable, Profile, UserPatch } from './user.ts';
`;

const DECORATORS = `export function Controller(prefix: string): ClassDecorator {
  return () => {
    void prefix;
  };
}

export function Get(path: string): MethodDecorator {
  return () => {
    void path;
  };
}

export function Column(): PropertyDecorator {
  return () => {};
}
`;

const SERVICE = `import { User } from './models/index.ts';
import type { UserPatch } from './models/index.ts';

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export class UserService {
  findById(id: string): User | null {
    const sql = 'SELECT id, email FROM users WHERE id = $1';
    void sql;
    void id;
    return null;
  }

  apply(target: User, patch: UserPatch): User {
    target.email = normalizeEmail(patch.email ?? target.email);
    return target;
  }

  create(): User {
    const created = new User();
    const sql = 'INSERT INTO public.users (email) VALUES ($1)';
    void sql;
    return created;
  }
}
`;

const CONTROLLER = `import { Controller, Get } from './decorators.ts';
import { UserService } from './service.ts';
import { User } from './models/index.ts';

@Controller('accounts')
export class UserController {
  private readonly service = new UserService();

  @Get(':id')
  show(id: string): User | null {
    return this.service.findById(id);
  }
}
`;

const ROUTES = `import { UserService } from './service.ts';

interface Router {
  get(path: string, handler: (id: string) => unknown): void;
  post(path: string, handler: (id: string) => unknown): void;
}

declare const app: Router;

const service = new UserService();

export function getUser(id: string): unknown {
  return service.findById(id);
}

app.get('/users/:id', getUser);
app.post('/users/', (id: string) => service.findById(id));
`;

const ENTRY = `export { User } from './models/index.ts';
export { UserService, normalizeEmail } from './service.ts';
export { UserController } from './controller.ts';
export { getUser } from './routes.ts';
`;

/** The main fixture: a barrel, heritage, decorators, routes, and SQL. */
export const APP_PROJECT: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'tsconfig.json': TSCONFIG,
  'src/models/user.ts': MODELS_USER,
  'src/models/index.ts': MODELS_BARREL,
  'src/decorators.ts': DECORATORS,
  'src/service.ts': SERVICE,
  'src/controller.ts': CONTROLLER,
  'src/routes.ts': ROUTES,
  'src/index.ts': ENTRY,
});

/**
 * `APP_PROJECT` after `git mv src/models/user.ts src/domain/account.ts`.
 *
 * Every declaration is byte-identical; only the file's location and the
 * barrel's specifier change. Any symbol id that differs between the two is the
 * path-in-identity defect this design was blocked for.
 */
export const APP_PROJECT_RENAMED: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'tsconfig.json': TSCONFIG,
  'src/domain/account.ts': MODELS_USER,
  'src/models/index.ts': MODELS_BARREL.replace(/'\.\/user\.ts'/g, "'../domain/account.ts'"),
  'src/decorators.ts': DECORATORS,
  'src/service.ts': SERVICE,
  'src/controller.ts': CONTROLLER,
  'src/routes.ts': ROUTES,
  'src/index.ts': ENTRY,
});

const WORKSPACE_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
};

/**
 * A solution-style workspace: the root `tsconfig.json` resolves no files of its
 * own and only lists `references`. This is the normal shape of a pnpm/npm
 * monorepo, and an extractor that reports UNAVAILABLE on it is useless on most
 * real repositories.
 */
export const WORKSPACE_PROJECT: FileMap = Object.freeze({
  'package.json': JSON.stringify({ name: '@fixture/workspace', private: true, type: 'module' }, null, 2),
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: WORKSPACE_COMPILER_OPTIONS,
      files: [],
      references: [{ path: './packages/api' }, { path: './packages/core' }],
    },
    null,
    2,
  ),
  'packages/core/package.json': JSON.stringify({ name: '@fixture/core', type: 'module' }, null, 2),
  'packages/core/tsconfig.json': JSON.stringify(
    { compilerOptions: WORKSPACE_COMPILER_OPTIONS, include: ['src'] },
    null,
    2,
  ),
  'packages/core/src/index.ts': `export interface Money {
  amount: number;
  currency: string;
}
`,
  'packages/api/package.json': JSON.stringify({ name: '@fixture/api', type: 'module' }, null, 2),
  'packages/api/tsconfig.json': JSON.stringify(
    { compilerOptions: WORKSPACE_COMPILER_OPTIONS, include: ['src'] },
    null,
    2,
  ),
  'packages/api/src/index.ts': `import type { Money } from '../../core/src/index.ts';

export class Invoice {
  total: Money = { amount: 0, currency: 'USD' };
  paidAt: Date | null = null;
}
`,
});

/**
 * A tsconfig that includes only `src/`, beside a loose `tools/x.ts` that no
 * tsconfig reaches. `dist/` is the project's own `outDir` and `node_modules/`
 * is a dependency: neither is source, so neither may be reported as unread.
 */
export const LOOSE_FILE_PROJECT: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'tsconfig.json': JSON.stringify(
    { compilerOptions: { ...WORKSPACE_COMPILER_OPTIONS, outDir: 'dist' }, include: ['src'] },
    null,
    2,
  ),
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a.ts';\n\nexport const b = a + 1;\n",
  'tools/x.ts': 'export const x = 1;\n',
  'dist/a.js': 'export const a = 1;\n',
  'node_modules/dep/index.js': 'module.exports = {};\n',
});

/**
 * Validation-library values next to look-alike type declarations. None of the
 * libraries is installed: the `library` prop must come from the import
 * declaration alone, not from resolving the package.
 */
export const VALIDATION_PROJECT: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'tsconfig.json': TSCONFIG,
  'src/helpers.ts': `export function buildSchema(): unknown {
  return {};
}
`,
  'src/row.ts': `import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import * as yup from 'yup';
import { object, string } from 'superstruct';
import { Type } from '@sinclair/typebox';
import { buildSchema } from './helpers.ts';

export interface Row {
  nullable: boolean;
}

export interface RowConstraints {
  nullable: boolean;
}

export type RowShape = { nullable: boolean };

export const RowSchema = z.object({ nullable: z.boolean() }).strict();
export const RowSchemaV4 = (z4.object({ nullable: z4.boolean() }));
export const LegacyRowSchema = yup.object({ nullable: yup.boolean() });
export const StructRow = object({ name: string() });
export const BoxedRow = Type.Object({ nullable: Type.Boolean() });
export const HelperRowSchema = buildSchema();
export const zodAlias = z;
export const plainRowSchema = { nullable: true };
`,
});

/**
 * A solution-style root that references only `src/`, beside an example app
 * whose own `tsconfig.json` nothing references. The config under
 * `node_modules`, the one in a dot-directory, and the one in the referenced
 * project's `outDir` are not projects of this repository; a config that
 * cannot be parsed is reported, not fatal.
 */
export const NESTED_TSCONFIG_PROJECT: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'tsconfig.json': JSON.stringify(
    { compilerOptions: WORKSPACE_COMPILER_OPTIONS, files: [], references: [{ path: './src' }] },
    null,
    2,
  ),
  'src/tsconfig.json': JSON.stringify(
    { compilerOptions: { ...WORKSPACE_COMPILER_OPTIONS, outDir: '../dist' }, include: ['**/*'] },
    null,
    2,
  ),
  'src/a.ts': 'export const a = 1;\n',
  'examples/app/tsconfig.json': JSON.stringify(
    { compilerOptions: WORKSPACE_COMPILER_OPTIONS, include: ['src'] },
    null,
    2,
  ),
  'examples/app/src/order.ts': 'export interface Order {\n  id: string;\n  shippedAt?: Date;\n}\n',
  'examples/broken/tsconfig.json': '{ "include": [',
  'tools/x.ts': 'export const x = 1;\n',
  'dist/tsconfig.json': '{}\n',
  'dist/leak.ts': 'export const leak = 1;\n',
  'node_modules/dep/tsconfig.json': '{}\n',
  'node_modules/dep/index.ts': 'export const dep = 1;\n',
  '.cache/gen/tsconfig.json': '{}\n',
  '.cache/gen/gen.ts': 'export const gen = 1;\n',
});

/** Real TypeScript, no `tsconfig.json`. Must yield UNAVAILABLE, never an empty PASS. */
export const NO_TSCONFIG_PROJECT: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'src/user.ts': 'export class User {\n  email = "";\n}\n',
});

/**
 * A single-package project holding exactly the given files (repo-relative
 * paths, normally under `src/`), with the same manifest and compiler options as
 * the other single-package fixtures.
 */
export function sourceProject(sources: FileMap): FileMap {
  return Object.freeze({ 'package.json': PACKAGE_JSON, 'tsconfig.json': TSCONFIG, ...sources });
}

/**
 * Calls shaped like route registrations (`x.get('/path', ...)`), some on server
 * instances and some not. None of the libraries is installed: whether the
 * receiver is a server must come from its declaration, not from resolving the
 * package.
 *
 * The expected routes are listed in `routes.receiver.test.ts`. Every path below
 * is unique so a stray `RouteHandler` can be traced to the call that made it.
 */
export const ROUTE_RECEIVER_PROJECT: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'tsconfig.json': TSCONFIG,
  'src/app.ts': `import express from 'express';

export const app = express();
`,
  'src/express-routes.ts': `import express, { Router } from 'express';
import type { Express } from 'express';
import { app } from './app.ts';

const router = express.Router();
const bare = Router();

export function listOrders(): unknown {
  return [];
}

export function showOrder(): unknown {
  return {};
}

app.get('/orders', listOrders);
router.get('/orders/:id', showOrder);
bare.post('/orders', (): unknown => ({}));

export function mount(target: Express): void {
  target.delete('/orders/:id', showOrder);
}
`,
  'src/other-frameworks.ts': `import Fastify from 'fastify';
import { Hono } from 'hono';
import KoaRouter from '@koa/router';
import { Elysia } from 'elysia';

const fastify = Fastify();
const hono = new Hono();
const koa = new KoaRouter();

fastify.get('/fastify/items', async (): Promise<unknown[]> => []);
hono.get('/hono/items', (c: unknown): unknown => c);
koa.get('/koa/items', async (ctx: unknown): Promise<unknown> => ctx);
new Elysia().get('/elysia/items', 'static body');
`,
  'src/default-app.ts': `import express from 'express';

export default express();
`,
  'src/commonjs.ts': `declare const require: (id: string) => any;

const express = require('express');
const server = express();

export function registerCommonjs(): void {
  server.get('/commonjs/items', (): unknown => []);
}
`,
  'src/receiver-shapes.ts': `import express from 'express';
import type { Express } from 'express';
import type { FastifyInstance } from 'fastify';
import defaultApp from './default-app.ts';

declare const loose: unknown;

export function registerShapes(): void {
  const chained = express();
  chained.get('/shapes/first', (): unknown => 1).get('/shapes/second', (): unknown => 2);
  defaultApp.get('/shapes/default', (): unknown => 3);
  (loose as Express).get('/shapes/cast', (): unknown => 4);
}

export class Gateway {
  private readonly server: FastifyInstance;

  constructor(server: FastifyInstance) {
    this.server = server;
  }

  register(): void {
    this.server.get('/shapes/property', (): unknown => 5);
  }
}
`,
  'src/clients.ts': `import axios from 'axios';
import request from 'supertest';
import type { Router } from 'client-sdk';

const api = axios.create({ baseURL: 'https://example.invalid' });
const http = { get: (path: string): string => path };
const cache = new Map<string, string>();
declare const $: { get(url: string, done: (data: unknown) => void): void };

api.post('/startup', { ready: true });

export async function loadUsers(): Promise<unknown> {
  return api.get('/users');
}

export function readThrough(): string | undefined {
  return cache.get('/key');
}

export function ping(): string {
  return http.get('/health');
}

export function legacy(): void {
  $.get('/legacy/users', (data: unknown): void => {
    void data;
  });
}

export function probe(server: unknown): unknown {
  return request(server).get('/probe');
}

export function navigate(sdk: Router): void {
  sdk.get('/lookalike', (): void => undefined);
}
`,
});

/**
 * The same question with the packages installed, as stubs: a server instance
 * that is only reachable through the checker (a contextually typed parameter),
 * next to a client library that declares a type with a router-like name.
 */
export const ROUTE_RECEIVER_INSTALLED_PROJECT: FileMap = Object.freeze({
  'package.json': PACKAGE_JSON,
  'tsconfig.json': TSCONFIG,
  'node_modules/fastify/package.json': JSON.stringify(
    { name: 'fastify', version: '0.0.0', type: 'module', types: 'index.d.ts' },
    null,
    2,
  ),
  'node_modules/fastify/index.d.ts': `export interface FastifyInstance {
  get(path: string, handler: (request: unknown) => unknown): FastifyInstance;
}
export type FastifyPluginAsync = (instance: FastifyInstance) => Promise<void>;
`,
  'node_modules/client-sdk/package.json': JSON.stringify(
    { name: 'client-sdk', version: '0.0.0', type: 'module', types: 'index.d.ts' },
    null,
    2,
  ),
  'node_modules/client-sdk/index.d.ts': `export interface Router {
  get(path: string, handler: (response: unknown) => unknown): void;
}
export declare function connect(): Router;
`,
  'src/plugin.ts': `import type { FastifyPluginAsync } from 'fastify';
import { connect } from 'client-sdk';

export const plugin: FastifyPluginAsync = async (instance) => {
  instance.get('/plugin/items', (): unknown => []);
};

const sdk = connect();

export function warm(): void {
  sdk.get('/sdk/items', (): unknown => []);
}
`,
});

/** Write a file map into a fresh temporary directory and return its absolute path. */
export function materialize(files: FileMap, label: string): string {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), `seamline-${label}-`));
  for (const rel of Object.keys(files).sort()) {
    const abs = nodePath.join(root, rel);
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel] ?? '', 'utf8');
  }
  return root;
}

/** Remove a materialized fixture. Safe to call on a path that is already gone. */
export function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
