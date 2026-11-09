/**
 * A fixture pair for every detector: one graph that fires it, one that does not.
 *
 * v3 section 5 requires this and section 7 makes it a test deliverable, for a
 * reason worth restating: a detector that never fires and a detector that
 * always fires are equally useless and equally invisible. Only the pair makes
 * either failure detectable, and only the meta-test over `CONTRADICTION_CODES`
 * makes a missing pair detectable.
 *
 * Each `clean` graph is the `firing` graph with the **single fact** that
 * disagrees changed, and nothing else. That is what makes the pair evidence
 * about the detector rather than about the fixture: if the clean graph differed
 * in five ways, a passing test would not tell you which one mattered.
 */

import type { ContradictionCode } from '@seamline/ontology';
import { replayFixtureNodes } from './__fixtures__/replay.ts';

import { graph, type GraphSpec, type MemoryGraph, type NodeSpec } from './graph-memory.ts';
import type { CurrentObservation } from './observation.ts';

export interface FixturePair {
  /** Explicit unit-fixture run authority; never real-corpus or independent-label evidence. */
  readonly currentObservation?: CurrentObservation;
  /** What the two disagreeing facts are, in one sentence. */
  readonly firingClaim: string;
  /** The single fact changed to make the disagreement go away. */
  readonly cleanedBy: string;
  readonly firing: () => MemoryGraph;
  readonly clean: () => MemoryGraph;
}

/* ---------------------------------------------------------------- X1 ---- */

const x1 = (nullable: boolean): MemoryGraph =>
  graph({
    nodes: [
      { kind: 'Table', name: 'users', canonical: 'db.public.users' },
      {
        kind: 'Column',
        name: 'email',
        canonical: 'db.public.users.email',
        sourceRef: 'db/schema.sql:12',
        props: { type: 'text', nullable, hasDefault: false },
      },
      { kind: 'Contract', name: 'usersApi', canonical: 'openapi.usersApi', props: { unreadStructuredDocuments: 0 } },
      {
        kind: 'SchemaProperty',
        name: 'email',
        canonical: 'openapi.usersApi#/User/email',
        sourceRef: 'openapi.yaml:44',
        props: { type: 'string', required: true, nullable: false, direction: 'response' },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.users', dst: 'db.public.users.email' },
      { kind: 'CONTAINS', src: 'openapi.usersApi', dst: 'openapi.usersApi#/User/email' },
      {
        kind: 'BACKED_BY',
        src: 'openapi.usersApi#/User/email',
        dst: 'db.public.users.email',
        provenance: 'INFERRED',
        confidence: 0.9,
        sourceRef: 'infer-join: exact name and type match',
      },
    ],
  });

/* ---------------------------------------------------------------- X2 ---- */

const x2 = (fieldType: string): MemoryGraph =>
  graph({
    nodes: [
      { kind: 'Table', name: 'users', canonical: 'db.public.users' },
      {
        kind: 'Column',
        name: 'age',
        canonical: 'db.public.users.age',
        sourceRef: 'db/schema.sql:19',
        props: { type: 'integer', nullable: false, hasDefault: false },
      },
      { kind: 'Contract', name: 'usersApi', canonical: 'openapi.usersApi' },
      {
        kind: 'SchemaProperty',
        name: 'age',
        canonical: 'openapi.usersApi#/User/age',
        sourceRef: 'src/models/user.ts:8',
        props: { type: fieldType, direction: 'response' },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.users', dst: 'db.public.users.age' },
      { kind: 'CONTAINS', src: 'openapi.usersApi', dst: 'openapi.usersApi#/User/age' },
      {
        kind: 'EXPOSED_AS',
        src: 'db.public.users.age',
        dst: 'openapi.usersApi#/User/age',
        provenance: 'INFERRED',
        confidence: 0.9,
      },
    ],
  });

/* ---------------------------------------------------------------- X3 ---- */

const x3 = (validatorMaxLength: number): MemoryGraph =>
  graph({
    nodes: [
      { kind: 'Table', name: 'users', canonical: 'db.public.users' },
      {
        kind: 'Column',
        name: 'display_name',
        canonical: 'db.public.users.display_name',
        sourceRef: 'db/schema.sql:14',
        props: { type: 'varchar(50)', nullable: false, maxLength: 50 },
      },
      {
        kind: 'Symbol',
        name: 'displayNameSchema',
        canonical: 'src/validation/user.ts#displayNameSchema',
        sourceRef: 'src/validation/user.ts:21',
        props: { maxLength: validatorMaxLength, required: true },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.users', dst: 'db.public.users.display_name' },
      {
        kind: 'VALIDATED_BY',
        src: 'db.public.users.display_name',
        dst: 'src/validation/user.ts#displayNameSchema',
        provenance: 'INFERRED',
        confidence: 0.85,
      },
    ],
  });

/* ---------------------------------------------------------------- X4 ---- */

const x4 = (backDiscountLabel: boolean): MemoryGraph =>
  graph({
    nodes: [
      { kind: 'Table', name: 'orders', canonical: 'db.public.orders' },
      {
        kind: 'Column',
        name: 'id',
        canonical: 'db.public.orders.id',
        sourceRef: 'db/schema.sql:30',
        props: { type: 'uuid', nullable: false },
      },
      {
        kind: 'Column',
        name: 'total',
        canonical: 'db.public.orders.total',
        sourceRef: 'db/schema.sql:31',
        props: { type: 'numeric', nullable: false },
      },
      {
        kind: 'Column',
        name: 'discount_label',
        canonical: 'db.public.orders.discount_label',
        sourceRef: 'db/schema.sql:32',
        props: { type: 'text', nullable: false },
      },
      { kind: 'Contract', name: 'orderApi', canonical: 'openapi.orderApi' },
      {
        kind: 'SchemaProperty',
        name: 'id',
        canonical: 'openapi.orderApi#/Order/id',
        sourceRef: 'openapi.yaml:70',
        props: { type: 'string', format: 'uuid', required: true, direction: 'response' },
      },
      {
        kind: 'SchemaProperty',
        name: 'total',
        canonical: 'openapi.orderApi#/Order/total',
        sourceRef: 'openapi.yaml:73',
        props: { type: 'number', required: true, direction: 'response' },
      },
      {
        kind: 'SchemaProperty',
        name: 'discountLabel',
        canonical: 'openapi.orderApi#/Order/discountLabel',
        sourceRef: 'openapi.yaml:76',
        props: { type: 'string', required: true, direction: 'response' },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.orders', dst: 'db.public.orders.id' },
      { kind: 'CONTAINS', src: 'db.public.orders', dst: 'db.public.orders.total' },
      { kind: 'CONTAINS', src: 'db.public.orders', dst: 'db.public.orders.discount_label' },
      { kind: 'CONTAINS', src: 'openapi.orderApi', dst: 'openapi.orderApi#/Order/id' },
      { kind: 'CONTAINS', src: 'openapi.orderApi', dst: 'openapi.orderApi#/Order/total' },
      { kind: 'CONTAINS', src: 'openapi.orderApi', dst: 'openapi.orderApi#/Order/discountLabel' },
      {
        kind: 'BACKED_BY',
        src: 'openapi.orderApi#/Order/id',
        dst: 'db.public.orders.id',
        provenance: 'INFERRED',
        confidence: 0.95,
      },
      {
        kind: 'BACKED_BY',
        src: 'openapi.orderApi#/Order/total',
        dst: 'db.public.orders.total',
        provenance: 'INFERRED',
        confidence: 0.95,
      },
      ...(backDiscountLabel
        ? [
            {
              kind: 'BACKED_BY' as const,
              src: 'openapi.orderApi#/Order/discountLabel',
              dst: 'db.public.orders.discount_label',
              provenance: 'INFERRED' as const,
              confidence: 0.95,
            },
          ]
        : []),
    ],
  });

/* ---------------------------------------------------------------- X5 ---- */

/**
 * The repository-wide facts that say the extractors saw every writer: the counts
 * of 5.2 at zero and an empty, measured `unknownWriterTables`. A graph without
 * them is one X5 cannot answer for (a missing prop is not zero), so a test that
 * wants X5 to run clean on an otherwise empty graph adds these.
 */
export const SQL_SLICE_FACTS: ReadonlyArray<NodeSpec> = [
  {
    kind: 'Repo',
    name: 'repo',
    canonical: 'repo',
    props: { untracedWriteCalls: 0, writeHooks: 0, runtimeDdl: 0, unknownWriterTables: '' },
  },
  { kind: 'DataSource', name: 'db', canonical: 'db', props: { dynamicDdl: 0 } },
];

/** What the X5 fixture graph is made of. An `undefined` value leaves the prop off, which is how a fact is absent. */
export interface X5Options {
  /** `insertColumns` of the one insert edge. */
  readonly insertColumns?: string | undefined;
  /** `insertComplete` of that edge; absent leaves the edge without the prop. Defaults to `true`. */
  readonly insertComplete?: boolean | undefined;
  /** `operation` of that edge. Defaults to `insert`. */
  readonly operation?: string | undefined;
  readonly insertOrm?: boolean | undefined;
  /** The edge's own confidence. Defaults to 1. */
  readonly confidence?: number;
  /** `defaultSite` of the required column `tenant_id`. Defaults to `none`. */
  readonly defaultSite?: string | undefined;
  readonly declarations?: number | undefined;
  readonly insertTrigger?: boolean | undefined;
  readonly untracedWriteCalls?: number | undefined;
  readonly writeHooks?: number | undefined;
  readonly runtimeDdl?: number | undefined;
  readonly unknownWriterTables?: string | undefined;
  readonly dynamicDdl?: number | undefined;
  /** A second writer symbol and its edge, besides the first. */
  readonly second?: {
    readonly operation: string;
    readonly insertColumns?: string;
    readonly insertComplete?: boolean;
    readonly insertOrm?: boolean;
    readonly confidence?: number;
  };
}

type Bag = Record<string, string | number | boolean>;

const defined = (o: Record<string, string | number | boolean | undefined>): Bag =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Bag;

/** The option when the caller set it (even to `undefined`), else the default. */
const pick = <K extends keyof X5Options>(
  o: X5Options,
  k: K,
  fallback: X5Options[K],
): X5Options[K] => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : fallback);

/**
 * `accounts(id, tenant_id NOT NULL, label)` and one insert into it, with the
 * repository-wide counts that say the extractors saw every writer. Each option
 * changes exactly one fact; `undefined` removes it.
 */
export const x5Spec = (o: X5Options = {}): GraphSpec => ({
  nodes: [
    {
      kind: 'Repo',
      name: 'repo',
      canonical: 'repo',
      props: defined({
        untracedWriteCalls: pick(o, 'untracedWriteCalls', 0),
        writeHooks: pick(o, 'writeHooks', 0),
        runtimeDdl: pick(o, 'runtimeDdl', 0),
        unknownWriterTables: pick(o, 'unknownWriterTables', ''),
      }),
    },
    {
      kind: 'DataSource',
      name: 'db',
      canonical: 'db',
      props: defined({ dynamicDdl: pick(o, 'dynamicDdl', 0) }),
    },
    {
      kind: 'Table',
      name: 'accounts',
      canonical: 'db.public.accounts',
      props: defined({
        declarations: pick(o, 'declarations', 1),
        insertTrigger: pick(o, 'insertTrigger', false),
      }),
    },
    {
      kind: 'Column',
      name: 'id',
      canonical: 'db.public.accounts.id',
      sourceRef: 'db/schema.sql:40',
      props: { type: 'uuid', nullable: false, hasDefault: true, defaultSite: 'db' },
    },
    {
      kind: 'Column',
      name: 'tenant_id',
      canonical: 'db.public.accounts.tenant_id',
      sourceRef: 'db/schema.sql:41',
      props: defined({
        type: 'uuid',
        nullable: false,
        hasDefault: pick(o, 'defaultSite', 'none') !== 'none',
        defaultSite: pick(o, 'defaultSite', 'none'),
      }),
    },
    {
      kind: 'Column',
      name: 'label',
      canonical: 'db.public.accounts.label',
      sourceRef: 'db/schema.sql:42',
      props: { type: 'text', nullable: true, hasDefault: false, defaultSite: 'none' },
    },
    {
      kind: 'Symbol',
      name: 'createAccount',
      canonical: 'src/repo/accounts.ts#createAccount',
      sourceRef: 'src/repo/accounts.ts:17',
    },
    ...(o.second === undefined
      ? []
      : [
          {
            kind: 'Symbol' as const,
            name: 'importAccount',
            canonical: 'src/repo/import.ts#importAccount',
            sourceRef: 'src/repo/import.ts:5',
          },
        ]),
  ],
  edges: [
    { kind: 'CONTAINS', src: 'db.public.accounts', dst: 'db.public.accounts.id' },
    { kind: 'CONTAINS', src: 'db.public.accounts', dst: 'db.public.accounts.tenant_id' },
    { kind: 'CONTAINS', src: 'db.public.accounts', dst: 'db.public.accounts.label' },
    {
      kind: 'QUERIES',
      src: 'src/repo/accounts.ts#createAccount',
      dst: 'db.public.accounts',
      confidence: o.confidence ?? 1,
      props: defined({
        operation: pick(o, 'operation', 'insert'),
        insertColumns: pick(o, 'insertColumns', 'id,label'),
        insertComplete: pick(o, 'insertComplete', true),
        insertOrm: o.insertOrm,
      }),
      sourceRef: 'src/repo/accounts.ts:19',
    },
    ...(o.second === undefined
      ? []
      : [
          {
            kind: 'QUERIES' as const,
            src: 'src/repo/import.ts#importAccount',
            dst: 'db.public.accounts',
            confidence: o.second.confidence ?? 1,
            props: defined({
              operation: o.second.operation,
              insertColumns: o.second.insertColumns,
              insertComplete: o.second.insertComplete,
              insertOrm: o.second.insertOrm,
            }),
            sourceRef: 'src/repo/import.ts:7',
          },
        ]),
  ],
});

const x5 = (writtenColumns: string): MemoryGraph =>
  graph(x5Spec({ insertColumns: writtenColumns }));

/* ---------------------------------------------------------------- X6 ---- */

const x6 = (auth: string): MemoryGraph =>
  graph({
    nodes: [
      { kind: 'Contract', name: 'publicApi', canonical: 'openapi.publicApi' },
      {
        kind: 'Operation',
        name: 'GET /profile',
        canonical: 'openapi.publicApi#get:/profile',
        sourceRef: 'openapi.yaml:10',
        props: { auth, method: 'GET', path: '/profile' },
      },
      { kind: 'RouteHandler', name: 'GET /profile', canonical: 'route:GET:/profile' },
      {
        kind: 'Symbol',
        name: 'getProfile',
        canonical: 'src/routes/profile.ts#getProfile',
        sourceRef: 'src/routes/profile.ts:9',
      },
      { kind: 'Table', name: 'people', canonical: 'db.public.people' },
      {
        kind: 'Column',
        name: 'ssn',
        canonical: 'db.public.people.ssn',
        sourceRef: 'db/schema.sql:60',
        props: { type: 'text', pii: 'high' },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'openapi.publicApi', dst: 'openapi.publicApi#get:/profile' },
      { kind: 'CONTAINS', src: 'db.public.people', dst: 'db.public.people.ssn' },
      { kind: 'IMPLEMENTED_BY', src: 'openapi.publicApi#get:/profile', dst: 'route:GET:/profile' },
      { kind: 'HANDLES_ROUTE', src: 'src/routes/profile.ts#getProfile', dst: 'route:GET:/profile' },
      {
        kind: 'QUERIES',
        src: 'src/routes/profile.ts#getProfile',
        dst: 'db.public.people',
        props: { writes: false },
        sourceRef: 'src/routes/profile.ts:14',
      },
    ],
  });

/* ---------------------------------------------------------------- X7 ---- */

const x7 = (inputMaxLength: number | undefined): MemoryGraph =>
  graph({
    nodes: [
      { kind: 'Table', name: 'profiles', canonical: 'db.public.profiles', path: 'db/schema.prisma', props: { ormModel: 'Profile' } },
      {
        kind: 'Column',
        name: 'bio',
        canonical: 'db.public.profiles.bio',
        sourceRef: 'db/schema.sql:81',
        path: 'db/schema.prisma',
        props: { type: 'varchar(280)', typeCategory: 'text', isArray: false, nullable: false, maxLength: 280 },
      },
      { kind: 'Contract', name: 'profileInput', path: 'app/profile/route.ts' },
      {
        kind: 'SchemaProperty',
        name: 'bio',
        canonical: 'profileInput#/properties/bio',
        path: 'app/profile/route.ts',
        sourceRef: 'app/profile/route.ts:6',
        props: { contract: 'profileInput', type: 'string', typeCategory: 'text', isArray: false,
          required: true, direction: 'request', valueRole: 'validated-write-input', writeBindingComplete: true,
          successfulParse: true, unchangedForwarding: true, modelBindingComplete: true,
          storageTable: 'repo:Table:db.public.profiles', storageModel: 'Profile', storageField: 'bio',
          lengthUpperState: inputMaxLength === undefined ? 'unbounded' : 'bounded',
          ...(inputMaxLength === undefined ? {} : { maxLength: inputMaxLength }) },
      },
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.profiles', dst: 'db.public.profiles.bio' },
      { kind: 'CONTAINS', src: 'profileInput', dst: 'profileInput#/properties/bio' },
      {
        kind: 'BACKED_BY',
        src: 'profileInput#/properties/bio',
        dst: 'db.public.profiles.bio',
        provenance: 'INFERRED',
        confidence: 0.9,
      },
    ],
  });

/* ---------------------------------------------------------------- X8 ---- */

const x8 = (guarded: boolean): MemoryGraph => graph({ nodes: replayFixtureNodes(guarded) });

/* ---------------------------------------------------------------- X9 ---- */

const x9 = (implementCreate: boolean): MemoryGraph =>
  graph({
    nodes: [
      {
        kind: 'Contract',
        name: 'petstore',
        canonical: 'openapi.petstore',
        props: { unreadStructuredDocuments: 0 },
      },
      {
        kind: 'Operation',
        name: 'GET /pets',
        canonical: 'openapi.petstore#get:/pets',
        sourceRef: 'openapi.yaml:4',
        props: { unreadStructuredDocuments: 0 },
      },
      {
        kind: 'Operation',
        name: 'GET /pets/{id}',
        canonical: 'openapi.petstore#get:/pets/{id}',
        sourceRef: 'openapi.yaml:14',
        props: { unreadStructuredDocuments: 0 },
      },
      {
        kind: 'Operation',
        name: 'DELETE /pets/{id}',
        canonical: 'openapi.petstore#delete:/pets/{id}',
        sourceRef: 'openapi.yaml:24',
        props: { unreadStructuredDocuments: 0 },
      },
      {
        kind: 'Operation',
        name: 'POST /pets',
        canonical: 'openapi.petstore#post:/pets',
        sourceRef: 'openapi.yaml:34',
        props: { unreadStructuredDocuments: 0 },
      },
      { kind: 'RouteHandler', name: 'GET /pets', canonical: 'route:GET:/pets' },
      { kind: 'RouteHandler', name: 'GET /pets/{id}', canonical: 'route:GET:/pets/{id}' },
      { kind: 'RouteHandler', name: 'DELETE /pets/{id}', canonical: 'route:DELETE:/pets/{id}' },
      ...(implementCreate
        ? [{ kind: 'RouteHandler' as const, name: 'POST /pets', canonical: 'route:POST:/pets' }]
        : []),
    ],
    edges: [
      { kind: 'CONTAINS', src: 'openapi.petstore', dst: 'openapi.petstore#get:/pets' },
      { kind: 'CONTAINS', src: 'openapi.petstore', dst: 'openapi.petstore#get:/pets/{id}' },
      { kind: 'CONTAINS', src: 'openapi.petstore', dst: 'openapi.petstore#delete:/pets/{id}' },
      { kind: 'CONTAINS', src: 'openapi.petstore', dst: 'openapi.petstore#post:/pets' },
      { kind: 'IMPLEMENTED_BY', src: 'openapi.petstore#get:/pets', dst: 'route:GET:/pets' },
      {
        kind: 'IMPLEMENTED_BY',
        src: 'openapi.petstore#get:/pets/{id}',
        dst: 'route:GET:/pets/{id}',
      },
      {
        kind: 'IMPLEMENTED_BY',
        src: 'openapi.petstore#delete:/pets/{id}',
        dst: 'route:DELETE:/pets/{id}',
      },
      ...(implementCreate
        ? [
            {
              kind: 'IMPLEMENTED_BY' as const,
              src: 'openapi.petstore#post:/pets',
              dst: 'route:POST:/pets',
            },
          ]
        : []),
    ],
  });

/* --------------------------------------------------------------- X10 ---- */

const x10 = (testTheWrite: boolean): MemoryGraph =>
  graph({
    nodes: [
      { kind: 'Table', name: 'customers', canonical: 'db.public.customers' },
      {
        kind: 'Column',
        name: 'email',
        canonical: 'db.public.customers.email',
        sourceRef: 'db/schema.sql:100',
        props: { type: 'text', nullable: true, pii: 'high' },
      },
      { kind: 'File', name: 'src/repo/customers.ts', canonical: 'src/repo/customers.ts' },
      {
        kind: 'Symbol',
        name: 'updateCustomerEmail',
        canonical: 'src/repo/customers.ts#updateCustomerEmail',
        sourceRef: 'src/repo/customers.ts:44',
      },
      {
        kind: 'Symbol',
        name: 'getCustomer',
        canonical: 'src/repo/customers.ts#getCustomer',
        sourceRef: 'src/repo/customers.ts:12',
      },
      {
        kind: 'TestCase',
        name: 'reads a customer',
        canonical: 'test/customers.test.ts#reads a customer',
        sourceRef: 'test/customers.test.ts:6',
      },
      ...(testTheWrite
        ? [
            {
              kind: 'TestCase' as const,
              name: 'updates a customer email',
              canonical: 'test/customers.test.ts#updates a customer email',
              sourceRef: 'test/customers.test.ts:20',
            },
          ]
        : []),
    ],
    edges: [
      { kind: 'CONTAINS', src: 'db.public.customers', dst: 'db.public.customers.email' },
      {
        kind: 'CONTAINS',
        src: 'src/repo/customers.ts',
        dst: 'src/repo/customers.ts#updateCustomerEmail',
      },
      { kind: 'CONTAINS', src: 'src/repo/customers.ts', dst: 'src/repo/customers.ts#getCustomer' },
      {
        kind: 'QUERIES',
        src: 'src/repo/customers.ts#updateCustomerEmail',
        dst: 'db.public.customers',
        props: { writes: true, columns: 'email' },
        sourceRef: 'src/repo/customers.ts:47',
      },
      {
        kind: 'TESTS',
        src: 'test/customers.test.ts#reads a customer',
        dst: 'src/repo/customers.ts#getCustomer',
      },
      ...(testTheWrite
        ? [
            {
              kind: 'TESTS' as const,
              src: 'test/customers.test.ts#updates a customer email',
              dst: 'src/repo/customers.ts#updateCustomerEmail',
            },
          ]
        : []),
    ],
  });

/* ------------------------------------------------------------------------ */

export const FIXTURES: Readonly<Record<ContradictionCode, FixturePair>> = {
  X1_NULLABILITY: {
    firingClaim: 'users.email is NULL-able while the contract declares the property non-nullable',
    cleanedBy: 'the column becomes NOT NULL',
    firing: () => x1(true),
    clean: () => x1(false),
  },
  X2_TYPE: {
    firingClaim: 'users.age is integer while the response property is typed string',
    cleanedBy: 'the response property is typed number',
    firing: () => x2('string'),
    clean: () => x2('number'),
  },
  X3_CONSTRAINT: {
    firingClaim: 'display_name is varchar(50) while its validator accepts 255 characters',
    cleanedBy: 'the validator accepts 50',
    firing: () => x3(255),
    clean: () => x3(50),
  },
  X4_UNBACKED_PROPERTY: {
    firingClaim:
      'the order response returns discountLabel, which nothing produces, while its siblings resolve',
    cleanedBy: 'discountLabel is backed by orders.discount_label',
    firing: () => x4(false),
    clean: () => x4(true),
  },
  X5_UNWRITTEN_COLUMN: {
    firingClaim:
      'accounts.tenant_id is NOT NULL with no default and the only traced write omits it',
    cleanedBy: 'the traced write includes tenant_id',
    firing: () => x5('id,label'),
    clean: () => x5('id,label,tenant_id'),
  },
  X6_PII_UNAUTHENTICATED: {
    firingClaim: 'GET /profile declares auth "none" and reaches people.ssn',
    cleanedBy: 'the operation declares auth "session"',
    firing: () => x6('none'),
    clean: () => x6('session'),
  },
  X7_VALIDATOR_DIVERGENCE: {
    firingClaim:
      'the completely bound bio request accepts unbounded strings while its column declares maxLength=280',
    cleanedBy: 'the request validator declares maxLength=280',
    currentObservation: (_scope, node) => node === undefined || node.lastSeenRun === 'run-fixture',
    firing: () => x7(undefined),
    clean: () => x7(280),
  },
  X8_ORPHANED_MIGRATION: {
    firingClaim: 'migration 001_ref requires users before its local creation in 002_create',
    cleanedBy: 'IF EXISTS guards the reference on the absent-table path',
    firing: () => x8(false),
    clean: () => x8(true),
  },
  X9_CONTRACT_DRIFT: {
    firingClaim: 'petstore declares POST /pets with no route handler while three siblings resolve',
    cleanedBy: 'a route handler implements POST /pets',
    firing: () => x9(false),
    clean: () => x9(true),
  },
  X10_UNTESTED_PII_WRITE: {
    firingClaim: 'updateCustomerEmail writes customers.email (pii=high) and no test reaches it',
    cleanedBy: 'a test case tests updateCustomerEmail',
    firing: () => x10(false),
    clean: () => x10(true),
  },
};
