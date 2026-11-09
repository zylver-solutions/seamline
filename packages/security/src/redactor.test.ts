/**
 * Redactor tests.
 *
 * The load-bearing test is the canary corpus: one planted secret per pattern
 * rule plus high-entropy strings, planted across every free-text field of
 * a graph, with the assertion that **not one of them appears anywhere in the
 * serialised output**. That is an authoritative-outcome assertion, not a
 * presence check: it fails if a rule regresses, if a new field is added to the
 * node shape and not scanned, or if span resolution drops a match.
 *
 * Identity and locator fields (ids, endpoints, paths) are never rewritten, so
 * they are tested separately: a closed-format canary there is refused.
 */

import { deepStrictEqual, doesNotMatch, match, notStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nodeId } from '@seamline/ontology';
import type { NodeId, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { loadSecretCanaries } from './corpus.ts';
import type { SecretCanary } from './corpus.ts';
import { ENTROPY_RULE_ID, RedactionError, createRedactor, redactionRef } from './redactor.ts';
import { SECRET_RULES } from './patterns.ts';
import { classifyToken, shannonEntropy } from './entropy.ts';

// Synthetic credentials are assembled at run time. The bytes the redactor sees are the same as
// if they were written out, but a scanner that reads this source (a secret scanner, push
// protection) finds no credential-shaped literal in it.
const SYNTHETIC_AWS_KEY_ID = 'AKIA' + 'QWERTYUIOPASDFGH';
const SYNTHETIC_GITHUB_TOKEN = 'ghp_' + '1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ01';

// ---------------------------------------------------------------------------
// Canary corpus: one planted, non-live secret per rule, loaded from
// corpus/secrets.json (the public injection corpus). The free-text entries are
// the ones planted here; the identity entries are exercised in conformance.test.ts.
// ---------------------------------------------------------------------------

const CANARIES: ReadonlyArray<SecretCanary> = loadSecretCanaries().filter(
  (c) => c.surface === 'free-text',
);

// ---------------------------------------------------------------------------
// False-positive corpus: must survive byte-identical.
// ---------------------------------------------------------------------------

const FALSE_POSITIVES: ReadonlyArray<string> = [
  '550e8400-e29b-41d4-a716-446655440000',
  'urn:uuid:f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
  'commit 3f2b1c8e9a7d6f5e4c3b2a1908f7e6d5c4b3a291',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'image@sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'packages/core/src/security/export-policy.ts',
  'node_modules/@seamline/ontology/dist/contract.d.ts',
  'export function getUserAccountBalanceByIdentifier() {}',
  'const webpackJsonpCallbackNamespace1234 = [];',
  'MIGRATION_0032_add_org_id_to_projects_table_v2',
  'test_case_should_reject_traversal_when_path_escapes_repo_root',
  "const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';",
  '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==">',
  '<script integrity="sha384-47DEQpj8HBSaplus0G5DcVJvE9k5PjIabcdefghijklmnopqrstuv"></script>',
  'X-Amzn-Trace-Id: Root=1-5759e988-bd862e3fe1be46a994272793',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'https://github.com/zylver-solutions/seamline/blob/main/docs/design/v3.md',
  '!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?t(exports):"function"==typeof define&&define.amd?define(["exports"],t):t(e.lib={})}(this,function(e){"use strict";var n=Object.prototype.hasOwnProperty,r=/^[a-zA-Z_$][a-zA-Z0-9_$]*$/;function o(e,t){return n.call(e,t)}e.get=o});',
  'org.apache.commons.lang3.builder.ReflectionToStringBuilder',
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'SELECT id, created_at FROM public.user_accounts WHERE org_id = $1 ORDER BY id',
  '2026-08-29T14:32:11.482Z_run_00000000000001',
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN = 'run-0001';

function node(id: NodeId, over: Partial<SeamlineNode> = {}): SeamlineNode {
  return {
    id,
    kind: 'File',
    name: 'file.ts',
    sensitivity: 'internal',
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
    ...over,
  };
}

function edge(src: NodeId, dst: NodeId, over: Partial<SeamlineEdge> = {}): SeamlineEdge {
  return {
    kind: 'IMPORTS',
    src,
    dst,
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
    ...over,
  };
}

/**
 * Plant every canary across every free-text field of a small graph: a node's
 * `name`, node props, and edge props.
 *
 * Identity and locator fields (a node id, an edge's endpoints, `path`,
 * `sourceRef`, `srcFile`, `dstFile`) are deliberately not in this graph. They
 * are never rewritten, so a secret there is refused instead of replaced; that
 * contract has its own tests under "redactor / identity and locator fields".
 */
function plantedGraph(): { nodes: SeamlineNode[]; edges: SeamlineEdge[] } {
  const nodes: SeamlineNode[] = [];
  const edges: SeamlineEdge[] = [];
  CANARIES.forEach((c, i) => {
    const id = nodeId('repo', 'File', `planted-${String(i).padStart(2, '0')}.ts`);
    // Every canary lands in both free-text fields of a node, so a scanner that
    // misses one field fails the corpus rather than passing on the other.
    nodes.push(
      node(id, {
        name: c.text,
        props: { detail: c.text, port: 5432, live: true, nothing: null },
      }),
    );
  });
  const a = nodeId('repo', 'File', 'a.ts');
  const b = nodeId('repo', 'File', 'b.ts');
  nodes.push(node(a), node(b));
  CANARIES.forEach((c) => {
    edges.push(edge(a, b, { kind: 'IMPORTS', props: { note: c.text } }));
  });
  return { nodes, edges };
}

// ---------------------------------------------------------------------------

describe('redactor / canary corpus', () => {
  it('covers every shipped pattern rule', () => {
    const covered = new Set(CANARIES.map((c) => c.rule));
    const uncovered = SECRET_RULES.map((r) => r.id).filter((id) => !covered.has(id));
    deepStrictEqual(uncovered, [], `pattern rules with no canary: ${uncovered.join(', ')}`);
  });

  it('lets not one planted secret reach the output', () => {
    const { nodes, edges } = plantedGraph();
    const r = createRedactor();
    const out = r.redactGraph(nodes, edges);
    const serialised = JSON.stringify({ nodes: out.nodes, edges: out.edges });
    for (const c of CANARIES) {
      ok(
        !serialised.includes(c.secret),
        `secret planted for rule ${c.rule} survived redaction: ${c.secret.slice(0, 24)}...`,
      );
    }
  });

  it('never writes a planted secret into the report either', () => {
    const { nodes, edges } = plantedGraph();
    const out = createRedactor().redactGraph(nodes, edges);
    const serialised = JSON.stringify(out.report);
    for (const c of CANARIES) {
      ok(!serialised.includes(c.secret), `rule ${c.rule} leaked its value into redactionReport()`);
    }
  });

  it('attributes each canary to the rule that caught it', () => {
    for (const c of CANARIES) {
      const r = createRedactor();
      r.redactString(c.text, 'canary', 'text');
      const rules = r.redactionReport().findings.map((f) => f.rule);
      ok(
        rules.includes(c.rule),
        `expected rule ${c.rule} to fire, got [${rules.join(', ')}] for ${JSON.stringify(c.text.slice(0, 60))}`,
      );
    }
  });

  it('replaces with a distinguishing reference, not a mask', () => {
    const r = createRedactor();
    const a = r.redactString('key AKIAIOSFODNN7EXAMPLE here');
    const b = r.redactString(`key ${SYNTHETIC_AWS_KEY_ID} here`);
    match(a, /«redacted:sha256:[0-9a-f]{8}»/);
    notStrictEqual(a, b, 'two different secrets must not collapse to the same reference');
  });

  it('gives the same reference to the same secret in two places', () => {
    const r = createRedactor();
    const a = r.redactString('AKIAIOSFODNN7EXAMPLE');
    const b = r.redactString('see also AKIAIOSFODNN7EXAMPLE');
    ok(b.includes(a));
    strictEqual(r.redactionReport().distinctSecrets, 1);
  });
});

describe('redactor / false positives', () => {
  it('passes ordinary hashes, UUIDs, paths, media and minified code through unchanged', () => {
    for (const text of FALSE_POSITIVES) {
      const r = createRedactor();
      const out = r.redactString(text, 'fp', 'text');
      strictEqual(
        out,
        text,
        `false positive: ${JSON.stringify(text.slice(0, 70))} caught by ${r.redactionReport().findings.map((f) => f.rule).join(', ')}`,
      );
    }
  });

  it('does not redact an indirection or a non-value', () => {
    const r = createRedactor();
    for (const text of [
      'password: ${DB_PASSWORD}',
      'api_key = process.env.API_KEY',
      'client_secret: null',
      'token: sops://secrets/domains/example.enc.env',
      'password = "changeme"',
    ]) {
      strictEqual(r.redactString(text), text, `non-value redacted: ${text}`);
    }
  });
});

describe('redactor / determinism', () => {
  it('produces identical output across two independent runs', () => {
    const a = plantedGraph();
    const b = plantedGraph();
    const first = createRedactor().redactGraph(a.nodes, a.edges);
    const second = createRedactor().redactGraph(b.nodes, b.edges);
    strictEqual(JSON.stringify(first.nodes), JSON.stringify(second.nodes));
    strictEqual(JSON.stringify(first.edges), JSON.stringify(second.edges));
    strictEqual(JSON.stringify(first.report), JSON.stringify(second.report));
  });

  it('pins the reference to a fixed value, so output is stable across machines', () => {
    strictEqual(redactionRef('AKIAIOSFODNN7EXAMPLE'), '«redacted:sha256:6f728d6e»');
    strictEqual(redactionRef('postgresPassw0rd'), '«redacted:sha256:8dad59a0»');
  });

  it('is idempotent: redacting an already-redacted graph changes nothing', () => {
    const g = plantedGraph();
    const once = createRedactor().redactGraph(g.nodes, g.edges);
    const twice = createRedactor().redactGraph(once.nodes, once.edges);
    strictEqual(JSON.stringify(twice.nodes), JSON.stringify(once.nodes));
    strictEqual(JSON.stringify(twice.edges), JSON.stringify(once.edges));
    strictEqual(twice.report.totalFindings, 0, 'a second pass found something to redact');
  });

  it('sorts props keys so serialisation is byte-stable', () => {
    const id = nodeId('repo', 'File', 'x.ts');
    const out = createRedactor().redactNode(node(id, { props: { z: '1', a: '2', m: '3' } }));
    deepStrictEqual(Object.keys(out.props), ['a', 'm', 'z']);
  });
});

describe('redactor / identity', () => {
  it('fails closed when the repo segment itself is credential-shaped', () => {
    const bad = nodeId('AKIAIOSFODNN7EXAMPLE', 'File', 'a.ts');
    throws(
      () => createRedactor().redactNode(node(bad)),
      (e: unknown) => e instanceof RedactionError && e.field === 'id.repo',
    );
  });
});

// ---------------------------------------------------------------------------
// Identity and locator fields: a node id, an edge's endpoints, and the
// repository-path fields (`path`, `sourceRef`, `srcFile`, `dstFile`, and the
// path-valued props). They are never rewritten, because rewriting an id breaks
// path-free identity and every join keyed on it.
// ---------------------------------------------------------------------------

/**
 * Real repository paths from this repository's own tree that the entropy
 * heuristic used to replace with `«redacted:sha256:...»` when they appeared as
 * a node id (`extract-change` emits a `File` per touched path), a `path`, a
 * `sourceRef`, or an edge's `srcFile`/`dstFile` (the `.sql` migrations in the
 * dogfood baseline). Each is 42..79 characters and 4.2..4.4 bits/char over its
 * `/`-joined token, which is above the 4.2 threshold.
 */
const FORMERLY_HASHED_PATHS: ReadonlyArray<string> = [
  'docs/adr/ADR-0002-path-free-natural-key-identity.md',
  'docs/adr/ADR-0003-run-lifecycle-tombstones-status.md',
  'docs/adr/ADR-0008-oss-github-actions-exception.md',
  'docs/adr/ADR-0012-extensible-semantic-foundation.md',
  'docs/audit/2026-08-29-license-verification.md',
  'examples/harbor-books/db/migrations/0014_orders_shipping.sql',
  'packages/extract-data/src/__fixtures__/sql-migrations/db/migrations/10_tighten.sql',
  'packages/extract-data/src/__fixtures__/sql-migrations/db/migrations/1_init.sql',
  'packages/extract-data/src/__fixtures__/sql-migrations/db/migrations/2_add_phone.sql',
];

/**
 * The only pattern rules that run over identity and locator fields: closed
 * token formats (fixed prefix, fixed charset), precise enough that a repository
 * path or a symbol name does not collide with them. Anything looser stays on
 * free text only, because refusing a record on a false positive is worse than
 * the false positive was.
 */
const STRUCTURAL_RULE_IDS: ReadonlyArray<string> = [
  'age-secret-key',
  'aws-access-key-id',
  'github-fine-grained-pat',
  'github-token',
  'gitlab-token',
  'google-api-key',
  'jwt',
  'npm-token',
  'private-key-pem',
  'slack-token',
  'slack-webhook',
  'stripe-secret-key',
];

type AnyRedactor = ReturnType<typeof createRedactor>;

const FILE_A = nodeId('repo', 'File', 'a.ts');
const FILE_B = nodeId('repo', 'File', 'b.ts');

/** Where a secret can sit in a structural field, and the field name a refusal reports. */
const STRUCTURAL_PLACEMENTS: ReadonlyArray<{
  readonly field: string;
  readonly run: (redactor: AnyRedactor, planted: string) => void;
}> = [
  {
    field: 'id.canonicalName',
    run: (r, s) =>
      void r.redactNode(node(nodeId('repo', 'Symbol', `cfg/${s}`), { kind: 'Symbol', name: 'x' })),
  },
  {
    field: 'path',
    run: (r, s) => void r.redactNode(node(FILE_A, { path: `cfg/${s}.json` })),
  },
  {
    field: 'sourceRef',
    run: (r, s) => void r.redactNode(node(FILE_A, { sourceRef: `cfg/${s}.json:3` })),
  },
  {
    field: 'props.entry',
    run: (r, s) =>
      void r.redactNode(
        node(nodeId('repo', 'Module', 'm'), { kind: 'Module', props: { entry: `cfg/${s}.ts` } }),
      ),
  },
  {
    field: 'src',
    run: (r, s) => void r.redactGraph([], [edge(nodeId('repo', 'File', `cfg/${s}`), FILE_B)]),
  },
  {
    field: 'dst',
    run: (r, s) => void r.redactGraph([], [edge(FILE_A, nodeId('repo', 'File', `cfg/${s}`))]),
  },
  {
    field: 'srcFile',
    run: (r, s) => void r.redactGraph([], [edge(FILE_A, FILE_B, { srcFile: `cfg/${s}.json` })]),
  },
  {
    field: 'dstFile',
    run: (r, s) => void r.redactGraph([], [edge(FILE_A, FILE_B, { dstFile: `cfg/${s}.json` })]),
  },
  {
    field: 'sourceRef',
    run: (r, s) => void r.redactGraph([], [edge(FILE_A, FILE_B, { sourceRef: `cfg/${s}.json:3` })]),
  },
  {
    field: 'props.specifier',
    run: (r, s) =>
      void r.redactGraph([], [edge(FILE_A, FILE_B, { props: { specifier: `./${s}.ts` } })]),
  },
];

describe('redactor / identity and locator fields', () => {
  it('keeps every repository path the entropy heuristic used to hash, in each identity and path field', () => {
    for (const p of FORMERLY_HASHED_PATHS) {
      // The shapes extractors emit: a File whose id, name and path are the
      // path; a Column located in a file; and the MIGRATED_BY edge between a
      // Column and a Migration, carrying the file on both ends.
      const file = node(nodeId('seamline', 'File', p), { name: p, path: p, sourceRef: `${p}:3` });
      const column = node(nodeId('seamline', 'Column', 'public.orders.id'), {
        kind: 'Column',
        name: 'id',
        path: p,
        sourceRef: `${p}:6`,
        props: { column: 'id', dialect: 'postgres' },
      });
      const migrated = edge(column.id, nodeId('seamline', 'Migration', '0014_orders_shipping'), {
        kind: 'MIGRATED_BY',
        srcFile: p,
        dstFile: p,
        sourceRef: `${p}:6`,
        props: { version: '0014_orders_shipping' },
      });
      const r = createRedactor();
      const out = r.redactGraph([file, column], [migrated]);
      deepStrictEqual(out.nodes, [file, column], `a node field for ${p} was rewritten`);
      deepStrictEqual(out.edges, [migrated], `an edge field for ${p} was rewritten`);
      deepStrictEqual(
        out.report.findings.map((f) => `${f.rule} ${f.field}`),
        [],
        `a rule fired on the repository path ${p}`,
      );
    }
  });

  it('keeps a long path in a path-valued prop, by key, and still scans the other props', () => {
    const p = FORMERLY_HASHED_PATHS[7] ?? '';
    const n = node(nodeId('seamline', 'Module', 'pkg'), {
      kind: 'Module',
      props: {
        entry: p,
        path: p,
        file: p,
        declaredHandler: `${p}#getPet`,
        jsonPointer: '/components/schemas/Thing/properties/protocolRelative',
        note: 'see AKIAIOSFODNN7EXAMPLE',
      },
    });
    const out = createRedactor().redactNode(n);
    strictEqual(out.props['entry'], p);
    strictEqual(out.props['path'], p);
    strictEqual(out.props['file'], p);
    strictEqual(out.props['declaredHandler'], `${p}#getPet`);
    strictEqual(out.props['jsonPointer'], '/components/schemas/Thing/properties/protocolRelative');
    strictEqual(out.props['note'], `see ${redactionRef('AKIAIOSFODNN7EXAMPLE')}`);
  });

  it('refuses a closed-format credential in an identity or locator field instead of rewriting it', () => {
    const canaries = CANARIES.filter((c) => STRUCTURAL_RULE_IDS.includes(c.rule));
    deepStrictEqual(
      [...new Set(canaries.map((c) => c.rule))].sort(),
      [...STRUCTURAL_RULE_IDS].sort(),
      'every structural rule needs a canary in the corpus',
    );
    for (const c of canaries) {
      for (const placement of STRUCTURAL_PLACEMENTS) {
        const r = createRedactor();
        throws(
          () => placement.run(r, c.secret),
          (e: unknown) => {
            ok(
              e instanceof RedactionError,
              `${c.rule} in ${placement.field} did not raise a RedactionError`,
            );
            strictEqual(e.field, placement.field);
            strictEqual(e.rule, c.rule);
            ok(
              !e.message.includes(c.secret),
              `the refusal for ${c.rule} in ${placement.field} quotes the secret`,
            );
            return true;
          },
          `${c.rule} placed in ${placement.field} was not refused`,
        );
        ok(
          !JSON.stringify(r.redactionReport()).includes(c.secret),
          `the report for ${c.rule} in ${placement.field} holds the secret`,
        );
      }
    }
  });

  it('runs only the closed-format rules over structure', () => {
    deepStrictEqual(
      SECRET_RULES.filter((r) => r.closedFormat === true)
        .map((r) => r.id)
        .sort(),
      [...STRUCTURAL_RULE_IDS].sort(),
    );
  });

  it('neither refuses nor rewrites structure that merely resembles an assignment or a key prefix', () => {
    // Each of these was rewritten before: `secret-assignment` read the `:` as an
    // assignment, `openai-key` read `sk-` plus a kebab-case word as a key, and
    // `github-fine-grained-pat` read a snake_case name as a token. The last one
    // reaches a structural rule and is let through because it is three or more
    // lower-case words of letters only; a digit anywhere keeps the refusal.
    const lookalikes = [
      'POST /v1/tokens:refresh',
      'POST /v1/secrets:rotate',
      'src/credentials.ts#getCredential:forUser',
      'docs/sk-learn-integration-guide.md',
      'src/auth/password-reset.ts:1234567',
      'src/github_pat_is_valid_for_repository.ts',
    ];
    for (const v of lookalikes) {
      const kind = v.startsWith('POST') ? 'Operation' : 'File';
      const n = node(nodeId('app', kind, v), { kind, name: v, path: v, sourceRef: v });
      const e = edge(n.id, n.id, { srcFile: v, dstFile: v, sourceRef: v });
      const r = createRedactor();
      const out = r.redactGraph([n], [e]);
      deepStrictEqual(out.nodes, [n], `a field of ${v} was rewritten`);
      deepStrictEqual(out.edges, [e], `an edge field of ${v} was rewritten`);
      strictEqual(r.redactionReport().totalFindings, 0, `${v} produced a finding`);
    }
  });

  it('refuses an entirely lower-case token whose random part has digits', () => {
    // Built at run time so the source holds no complete token. Legacy Slack user,
    // session and bot tokens are lower case throughout: digits, then hex.
    const hex = '0123456789abcdef0123456789abcdef';
    const tokens = [
      ['xoxp', '2345678901', '2345678901', '2345678901', hex].join('-'),
      ['xoxs', '2345678901', '2345678901', '2345678901', hex].join('-'),
      ['xoxb', '2345678901', '2345678901', 'abcdefghij0123456789abcd'].join('-'),
    ];
    for (const token of tokens) {
      for (const placement of STRUCTURAL_PLACEMENTS) {
        const r = createRedactor();
        throws(
          () => placement.run(r, token),
          (e: unknown) =>
            e instanceof RedactionError &&
            e.field === placement.field &&
            e.rule === 'slack-token' &&
            !e.message.includes(token),
          `${token.slice(0, 5)} in ${placement.field} was not refused`,
        );
      }
    }
  });

  it('refuses a URL with an inline password in a locator prop, and keeps one without', () => {
    const withPassword = ['postgres://app', 'S3cr3tPassw0rd@db.internal:5432/orders'].join(':');
    const r = createRedactor();
    throws(
      () =>
        r.redactGraph(
          [],
          [edge(FILE_A, FILE_B, { kind: 'IMPORTS', props: { specifier: withPassword } })],
        ),
      (e: unknown) =>
        e instanceof RedactionError &&
        e.field === 'props.specifier' &&
        e.rule === 'connection-string-password' &&
        !e.message.includes('S3cr3tPassw0rd'),
    );
    const plain = edge(FILE_A, FILE_B, {
      kind: 'IMPORTS',
      props: { specifier: 'https://registry.example.com/lib/mod.ts' },
    });
    deepStrictEqual(createRedactor().redactGraph([], [plain]).edges, [plain]);
  });

  it('does not report replacements from a batch it refused', () => {
    const aws = CANARIES.find((c) => c.rule === 'aws-access-key-id');
    const github = CANARIES.find((c) => c.rule === 'github-token');
    ok(aws !== undefined && github !== undefined);
    const good = node(nodeId('repo', 'Table', 'public.a'), {
      kind: 'Table',
      name: 'a',
      props: { note: aws.text },
    });
    const bad = node(nodeId('repo', 'File', `cfg/${github.secret}`), { name: 'x' });
    const r = createRedactor();
    throws(() => r.redactGraph([good, bad], []), RedactionError);
    strictEqual(r.redactionReport().totalFindings, 0);
    r.redactGraph([good], []);
    strictEqual(r.redactionReport().totalFindings, 1);
  });

  it('keeps identity and path while still redacting canaries in the free-text fields of the same record', () => {
    const p = FORMERLY_HASHED_PATHS[5] ?? '';
    const aws = CANARIES.find((c) => c.rule === 'aws-access-key-id');
    const entropy = CANARIES.find((c) => c.rule === ENTROPY_RULE_ID);
    ok(aws !== undefined && entropy !== undefined);
    const col = node(nodeId('seamline', 'Column', 'public.orders.id'), {
      kind: 'Column',
      name: aws.text,
      path: p,
      sourceRef: `${p}:6`,
      props: { comment: entropy.text, defaultExpr: aws.text },
    });
    const e = edge(col.id, nodeId('seamline', 'Migration', '0014_orders_shipping'), {
      kind: 'MIGRATED_BY',
      srcFile: p,
      dstFile: p,
      props: { note: aws.text },
    });
    const r = createRedactor();
    const out = r.redactGraph([col], [e]);
    const n = out.nodes[0];
    const oe = out.edges[0];
    ok(n !== undefined && oe !== undefined);
    strictEqual(n.id, col.id);
    strictEqual(n.path, p);
    strictEqual(n.sourceRef, `${p}:6`);
    strictEqual(oe.srcFile, p);
    strictEqual(oe.dstFile, p);
    for (const text of [
      n.name,
      String(n.props['comment']),
      String(n.props['defaultExpr']),
      String(oe.props['note']),
    ]) {
      ok(
        !text.includes(aws.secret) && !text.includes(entropy.secret),
        `a canary survived in ${text}`,
      );
      match(text, /«redacted:sha256:[0-9a-f]{8}»/);
    }
    deepStrictEqual(out.report.findings.map((f) => `${f.field}=${f.rule}`).sort(), [
      'name=aws-access-key-id',
      'props.comment=high-entropy-string',
      'props.defaultExpr=aws-access-key-id',
      'props.note=aws-access-key-id',
    ]);
  });

  it('documents the accepted residual: structure carries no entropy heuristic', () => {
    // An opaque, unrecognised-format token used as a path segment is kept. This
    // is the decided trade (see ADR-0013): a path or an id is structure, the
    // entropy heuristic cannot tell a content-hashed bundle name from a secret,
    // and refusing a record on that guess would cost more than it protects. The
    // same token in a free-text field is still redacted (canary corpus above).
    const opaque = 'assets/Xk7Rp2Wq9Zv4Nb1Tc6Hs3Ym8Ld0Gf5Jaeu.js';
    const n = node(nodeId('app', 'File', opaque), { name: opaque, path: opaque });
    const r = createRedactor();
    deepStrictEqual(r.redactNode(n), n);
    strictEqual(r.redactionReport().totalFindings, 0);
  });
});

describe('redactor / entropy heuristic', () => {
  it('rejects hex by arithmetic, not by luck: no hex string can reach the threshold', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    ok(shannonEntropy(hex) <= 4.0);
    strictEqual(classifyToken(hex).rejectedBy, 'hex-or-uuid');
  });

  it('names the guard that rejected each false-positive shape', () => {
    strictEqual(classifyToken('short').rejectedBy, 'below-floor');
    strictEqual(classifyToken('a'.repeat(200)).rejectedBy, 'above-ceiling');
    strictEqual(classifyToken('550e8400-e29b-41d4-a716-446655440000').rejectedBy, 'hex-or-uuid');
    strictEqual(
      classifyToken('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQ').rejectedBy,
      'known-encoding-prefix',
    );
    strictEqual(classifyToken('abcdefghijklmnopqrstuvwxyzabcdefgh').rejectedBy, 'single-char-class');
    strictEqual(
      classifyToken('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789').rejectedBy,
      'sequential-alphabet',
    );
    strictEqual(
      classifyToken('MIGRATION_0032_add_org_id_to_projects_table_v2').rejectedBy,
      'cased-identifier',
    );
  });

  it('accepts a random 40-character base64 secret', () => {
    const v = classifyToken('b7HkQ2xVn9LpR4tYwZ6mA3sD8fG1jC5eN0uI7oPq');
    ok(v.isSecret, `expected a catch, got ${String(v.rejectedBy)} at ${v.entropy}`);
    ok(v.entropy >= 4.2);
  });

  it('the entropy rule is disableable without disturbing pattern rules', () => {
    const r = createRedactor({ entropyEnabled: false });
    const text = 'handle Xk7Rp2Wq9Zv4Nb1Tc6Hs3Ym8Ld0Gf5Jaeu and key AKIAIOSFODNN7EXAMPLE';
    const out = r.redactString(text);
    ok(out.includes('Xk7Rp2Wq9Zv4Nb1Tc6Hs3Ym8Ld0Gf5Jaeu'));
    ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  });
});

describe('redactor / report', () => {
  it('names the rule and the field path for every finding, and never the value', () => {
    const id = nodeId('repo', 'File', 'cfg.ts');
    const r = createRedactor();
    r.redactNode(node(id, { props: { dsn: 'postgres://u:Tr0ub4dor3Horse@h:5432/d' } }));
    const report = r.redactionReport();
    strictEqual(report.totalFindings, 1);
    const f = report.findings[0];
    ok(f !== undefined);
    strictEqual(f.rule, 'connection-string-password');
    strictEqual(f.field, 'props.dsn');
    strictEqual(f.target, String(id));
    strictEqual(f.length, 'Tr0ub4dor3Horse'.length);
    doesNotMatch(JSON.stringify(report), /Tr0ub4dor3Horse/);
  });

  it('summarises by rule with a human-readable description', () => {
    const r = createRedactor();
    r.redactString(`AKIAIOSFODNN7EXAMPLE and ${SYNTHETIC_AWS_KEY_ID}`);
    const byRule = r.redactionReport().byRule;
    strictEqual(byRule.length, 1);
    strictEqual(byRule[0]?.rule, 'aws-access-key-id');
    strictEqual(byRule[0]?.count, 2);
    ok((byRule[0]?.description.length ?? 0) > 0);
  });

  it('records the threshold in force, so a report from a tuned run is interpretable', () => {
    strictEqual(createRedactor({ entropyThreshold: 4.9 }).redactionReport().entropyThreshold, 4.9);
  });
});

describe('guardStructural: identity and locator strings of other consumers', () => {
  const TOKEN = SYNTHETIC_GITHUB_TOKEN;

  it('returns an ordinary id or path unchanged', () => {
    const r = createRedactor();
    strictEqual(
      r.guardStructural('seamline:align:RUNTIME_FLOOR:runtime:node', 'id'),
      'seamline:align:RUNTIME_FLOOR:runtime:node',
    );
    strictEqual(r.guardStructural('docs/toolchain.md', 'path'), 'docs/toolchain.md');
    strictEqual(r.guardStructural('', 'path'), '');
  });

  it('refuses a closed-format credential, names the field, and never repeats the credential', () => {
    const r = createRedactor();
    throws(
      () => r.guardStructural(`docs/${TOKEN}.md`, 'inputs.docs[].path'),
      (e: unknown) => {
        ok(e instanceof RedactionError);
        match(e.message, /inputs\.docs\[\]\.path/);
        doesNotMatch(e.message, new RegExp(TOKEN));
        return true;
      },
    );
  });

  it('applies the rule redactGraph applies to a node path: the two agree on what is refused', () => {
    const r = createRedactor();
    const path = `src/${TOKEN}.ts`;
    throws(() => r.guardStructural(path, 'path'), RedactionError);
    const node: SeamlineNode = {
      id: nodeId('r', 'File', 'src/a.ts'),
      kind: 'File',
      name: 'a.ts',
      path,
      sensitivity: 'internal',
      provenance: 'EXTRACTED',
      confidence: 1,
      props: {},
      firstSeenRun: 'x',
      lastSeenRun: 'x',
      deletedAt: null,
    };
    throws(() => r.redactGraph([node], []), RedactionError);
  });
});
