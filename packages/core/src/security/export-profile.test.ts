/**
 * The export profile format: one parser, one schema file, one corpus.
 *
 * Three claims are asserted here, each by outcome:
 *
 * 1. every validation rule has a fixture that is accepted and one that is
 *    rejected with a precise message (the corpus in `__fixtures__`);
 * 2. the JSON Schema file under `docs/reference/` and the parser agree on the
 *    whole corpus, and the schema's vocabulary is the live vocabulary, so a new
 *    node kind in the contract fails here until the schema file is regenerated;
 * 3. the shipped profiles are parsed by the same parser and keep releasing what
 *    they released before provenance and untrusted text became profile fields.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DEFAULT_SENSITIVITY,
  EDGE_KINDS,
  NODE_KINDS,
  PROVENANCE,
  SENSITIVITY,
  nodeId,
} from '@seamline/ontology';
import type { SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import {
  PROFILES,
  applyProfile,
  getProfile,
  parseDeclaredProfiles,
  profileNames,
  profileView,
} from './export-policy.ts';
import {
  EXPORT_PROFILE_FIELDS,
  EXPORT_PROFILE_VERSION,
  ExportPolicyError,
  FORMAT_DOC_URL,
  PROFILE_DESCRIPTION_MAX,
  RECORD_FIELDS,
  parseExportProfile,
} from './export-profile.ts';
import { CASES, VALID } from './__fixtures__/export-profile-cases.ts';

const SCHEMA_URL = new URL(
  '../../../../docs/reference/export-profile.schema.json',
  import.meta.url,
);
const schema = JSON.parse(readFileSync(SCHEMA_URL, 'utf8')) as Schema;

type Schema = { [key: string]: unknown };

/**
 * The few JSON Schema keywords the schema file uses, and no more. If the file
 * grows a keyword this does not know, `unsupported` fails the test rather than
 * silently accepting everything.
 */
function validates(root: Schema, node: Schema, value: unknown): boolean {
  const supported = new Set([
    '$schema',
    '$id',
    '$ref',
    '$defs',
    'title',
    'description',
    'x-seamline-rules',
    'type',
    'const',
    'enum',
    'pattern',
    'maxLength',
    'minLength',
    'minItems',
    'maxItems',
    'uniqueItems',
    'items',
    'prefixItems',
    'required',
    'properties',
    'additionalProperties',
    'propertyNames',
    'oneOf',
  ]);
  for (const key of Object.keys(node)) {
    if (!supported.has(key)) throw new Error(`the schema checker does not know the keyword ${key}`);
  }
  if (typeof node['$ref'] === 'string') {
    const target = (node['$ref'] as string).replace('#/$defs/', '');
    return validates(root, (root['$defs'] as Record<string, Schema>)[target] as Schema, value);
  }
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if ('const' in node && !same(node['const'], value)) return false;
  if ('enum' in node && !(node['enum'] as unknown[]).some((e) => same(e, value))) return false;
  const type = node['type'];
  if (type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value)))
    return false;
  if (type === 'array' && !Array.isArray(value)) return false;
  if (type === 'string' && typeof value !== 'string') return false;
  if (type === 'boolean' && typeof value !== 'boolean') return false;
  if (typeof value === 'string') {
    // JSON Schema counts characters as Unicode code points, not UTF-16 units.
    const length = [...value].length;
    if (typeof node['maxLength'] === 'number' && length > node['maxLength']) return false;
    if (typeof node['minLength'] === 'number' && length < node['minLength']) return false;
    if (typeof node['pattern'] === 'string' && !new RegExp(node['pattern']).test(value))
      return false;
  }
  if (Array.isArray(value)) {
    if (typeof node['minItems'] === 'number' && value.length < node['minItems']) return false;
    if (typeof node['maxItems'] === 'number' && value.length > node['maxItems']) return false;
    if (node['uniqueItems'] === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) return false;
    }
    const prefix = (node['prefixItems'] as Schema[] | undefined) ?? [];
    for (let i = 0; i < value.length; i += 1) {
      const item = prefix[i] ?? (node['items'] as Schema | undefined);
      if (item !== undefined && !validates(root, item, value[i])) return false;
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of (node['required'] as string[] | undefined) ?? []) {
      if (!Object.hasOwn(record, key)) return false;
    }
    const properties = (node['properties'] as Record<string, Schema> | undefined) ?? {};
    for (const [key, v] of Object.entries(record)) {
      if (
        node['propertyNames'] !== undefined &&
        !validates(root, node['propertyNames'] as Schema, key)
      )
        return false;
      const declared = properties[key];
      if (declared !== undefined) {
        if (!validates(root, declared, v)) return false;
      } else if (node['additionalProperties'] === false) {
        return false;
      } else if (typeof node['additionalProperties'] === 'object') {
        if (!validates(root, node['additionalProperties'] as Schema, v)) return false;
      }
    }
  }
  if (Array.isArray(node['oneOf'])) {
    const matches = (node['oneOf'] as Schema[]).filter((s) => validates(root, s, value));
    if (matches.length !== 1) return false;
  }
  return true;
}

function parserAccepts(declared: unknown): { ok: true } | { ok: false; message: string } {
  try {
    parseDeclaredProfiles({ fixture: declared });
    return { ok: true };
  } catch (e) {
    if (e instanceof ExportPolicyError) return { ok: false, message: e.message };
    throw e;
  }
}

describe('export profile / the corpus: every case is accepted or refused with its precise message', () => {
  for (const c of CASES) {
    it(`${c.expect === 'accepted' ? 'accepts' : 'rejects'}: ${c.rule} (${c.label})`, () => {
      const verdict = parserAccepts(c.input);
      if (c.expect === 'accepted') {
        ok(verdict.ok, verdict.ok ? '' : `expected acceptance, got: ${verdict.message}`);
      } else {
        ok(!verdict.ok, 'expected the parser to reject this profile');
        if (!verdict.ok) {
          ok(
            c.message?.test(verdict.message) === true,
            `message ${JSON.stringify(verdict.message)} should match ${String(c.message)}`,
          );
          ok(
            verdict.message.startsWith("export profile 'fixture': "),
            'the message names the profile',
          );
        }
      }
    });
  }
});

describe('export profile / name, copy and canonical form', () => {
  const named = (over: Record<string, unknown> = {}): unknown => ({
    ...VALID,
    name: 'fixture',
    ...over,
  });

  it('accepts a conforming name and rejects the rest', () => {
    strictEqual(parseExportProfile(named()).name, 'fixture');
    for (const bad of [
      '',
      ' x',
      '-x',
      'a b',
      'a/b',
      'x'.repeat(65),
      '\u001b[31mred',
      7,
      undefined,
    ]) {
      throws(
        () => parseExportProfile(named({ name: bad })),
        (e: unknown) =>
          e instanceof ExportPolicyError && /needs a `name` of 1 to 64 characters/.test(e.message),
        `name ${String(bad)}`,
      );
    }
  });

  it('rejects anything that is not a plain object', () => {
    for (const bad of ['team', 7, null, [], undefined]) {
      throws(() => parseExportProfile(bad), /must be a JSON object/);
    }
    throws(
      () => parseExportProfile({ ...(named() as object), allowProps: () => '*' }),
      /plain data/,
    );
    throws(() => parseExportProfile(new Map()), /must be a JSON object/);
  });

  it('returns a deep-frozen copy that the caller cannot change afterwards', () => {
    const source = { ...(named() as Record<string, unknown>), allowProps: { File: ['loc'] } } as {
      allowProps: { File: string[] };
    };
    const parsed = parseExportProfile(source);
    source.allowProps.File.push('secret');
    deepStrictEqual(parsed.allowProps.File, ['loc']);
    ok(
      Object.isFrozen(parsed) && Object.isFrozen(parsed.allow) && Object.isFrozen(parsed.allow[0]),
    );
    throws(() => {
      (parsed.allowEdges as string[]).push('CONTAINS');
    }, TypeError);
  });

  it('reads an accessor once, so a getter cannot show validation one thing and the server another', () => {
    let reads = 0;
    const shifty = { ...(named({ allowProps: {} }) as object) } as Record<string, unknown>;
    Object.defineProperty(shifty, 'allow', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? [['File', 'internal']] : [['Owner', 'restricted']];
      },
    });
    const parsed = parseExportProfile(shifty);
    deepStrictEqual(parsed.allow, [['File', 'internal']]);
    strictEqual(parsed.allow[0]?.[0], 'File');
    strictEqual(reads, 1);
  });

  it('gives two files that say the same thing the same value, whatever order they list it in', () => {
    const a = parseExportProfile(
      named({
        allow: [
          ['Column', 'confidential'],
          ['File', 'internal'],
        ],
        allowEdges: ['IMPORTS', 'CONTAINS'],
        allowProps: { File: ['b', 'a'], Column: '*' },
        allowEdgeProps: {},
        allowFields: ['sourceRef', 'path', 'props'],
        allowProvenance: ['DECLARED', 'EXTRACTED'],
      }),
    );
    const b = parseExportProfile(
      named({
        allow: [
          ['File', 'internal'],
          ['Column', 'confidential'],
        ],
        allowEdges: ['CONTAINS', 'IMPORTS'],
        allowProps: { Column: '*', File: ['a', 'b'] },
        allowEdgeProps: {},
        allowFields: ['path', 'sourceRef', 'props'],
        allowProvenance: ['EXTRACTED', 'DECLARED'],
      }),
    );
    deepStrictEqual(a, b);
    strictEqual(JSON.stringify(a), JSON.stringify(b), 'byte-identical when serialized');
    deepStrictEqual(
      Object.keys(a),
      EXPORT_PROFILE_FIELDS.filter((f) => f !== 'packets'),
      'packets is left out of the canonical form when absent',
    );
  });

  it('does not let a hostile key through: __proto__ and constructor are unknown, not inherited', () => {
    const hostile = JSON.parse(
      `{"version":1,"__proto__":{"allow":[]},"description":"","allow":[["File","internal"]],"allowEdges":[],"allowProps":{},"allowEdgeProps":{},"allowFields":[],"allowProvenance":["EXTRACTED"],"includeUntrusted":false,"name":"h"}`,
    );
    throws(() => parseExportProfile(hostile), /unknown field "__proto__"/);
    throws(
      () => parseExportProfile(named({ allowProps: { constructor: '*' } })),
      /unknown node kind "constructor"/,
    );
  });
});

describe('export profile / declared profiles and name resolution', () => {
  const declaredForm = { ...VALID };

  it('parses every declared profile, naming each by its key', () => {
    const declared = parseDeclaredProfiles({ zeta: declaredForm, alpha: declaredForm });
    deepStrictEqual(Object.keys(declared), ['alpha', 'zeta']);
    strictEqual(declared['alpha']?.name, 'alpha');
    deepStrictEqual(parseDeclaredProfiles({}), {});
  });

  it('refuses a declared profile that reuses a shipped name, so `team` means one thing everywhere', () => {
    for (const shipped of Object.keys(PROFILES)) {
      throws(
        () => parseDeclaredProfiles({ [shipped]: declaredForm }),
        (e: unknown) =>
          e instanceof ExportPolicyError &&
          /is a shipped profile; choose another name/.test(e.message),
      );
    }
  });

  it('refuses a non-object `exportProfiles`', () => {
    for (const bad of [null, [], 'team', 3])
      throws(() => parseDeclaredProfiles(bad), /must be an object of profile name to profile/);
  });

  it('names the offending key when it is not a valid profile name, and does not talk about a `name` field', () => {
    const keys: Array<[string, RegExp]> = [
      ['two words', /^export profile "two words": the key under `exportProfiles`/],
      ['', /^export profile "": the key under `exportProfiles`/],
      ['.hidden', /^export profile "\.hidden": the key/],
      ['x'.repeat(65), /^export profile "x{65}": the key/],
      ['__proto__', /^export profile "__proto__": the key/],
      ['\u001b[31mred', /^export profile "\\u001b\[31mred": the key/],
    ];
    for (const [key, pattern] of keys) {
      // `__proto__` only survives as an own key when the object comes from JSON.parse.
      const input = JSON.parse(JSON.stringify({ [key]: declaredForm }));
      throws(
        () => parseDeclaredProfiles(input),
        (e: unknown) =>
          e instanceof ExportPolicyError &&
          pattern.test(e.message) &&
          !/needs a `name`/.test(e.message),
        `key ${JSON.stringify(key)}`,
      );
    }
  });

  it('names the key when a profile is not a JSON object', () => {
    const shapes: Array<[unknown, string]> = [
      ['team', 'a string'],
      [7, 'a number'],
      [null, 'null'],
      [[], 'an array'],
      [true, 'a boolean'],
    ];
    for (const [value, found] of shapes) {
      throws(
        () => parseDeclaredProfiles({ mine: value }),
        (e: unknown) =>
          e instanceof ExportPolicyError &&
          e.message ===
            `export profile 'mine': an export profile must be a JSON object, found ${found}`,
        `value ${JSON.stringify(value)}`,
      );
    }
  });

  it('resolves a shipped name, then a declared one, and never falls back', () => {
    const declared = parseDeclaredProfiles({ mine: declaredForm });
    strictEqual(getProfile('team', declared), PROFILES['team']);
    strictEqual(getProfile('mine', declared), declared['mine']);
    deepStrictEqual(profileNames(declared), ['audit', 'mine', 'public', 'team']);
    for (const bad of [
      'everything',
      '',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
    ]) {
      throws(
        () => getProfile(bad, declared),
        (e: unknown) =>
          e instanceof ExportPolicyError &&
          /default-deny and there is no default profile/.test(e.message),
        `'${bad}' is not a profile`,
      );
    }
  });
});

describe('export profile / the JSON Schema file and the parser agree', () => {
  it('agrees on every fixture in the corpus', () => {
    for (const c of CASES) {
      const bySchema = validates(schema, schema, c.input);
      const byParser = parserAccepts(c.input).ok;
      strictEqual(byParser, c.expect === 'accepted', `parser: ${c.rule} (${c.label})`);
      strictEqual(bySchema, c.expect !== 'rejected', `schema: ${c.rule} (${c.label})`);
    }
  });

  it('describes exactly the fields the parser reads, and requires all but the name', () => {
    deepStrictEqual(
      Object.keys(schema['properties'] as object).sort(),
      EXPORT_PROFILE_FIELDS.filter((f) => f !== 'name').sort(),
    );
    deepStrictEqual(
      [...(schema['required'] as string[])].sort(),
      EXPORT_PROFILE_FIELDS.filter((f) => f !== 'name' && f !== 'packets').sort(),
      'every field but the name and the optional packets is required',
    );
    strictEqual(schema['additionalProperties'], false);
    strictEqual(
      (schema['properties'] as Record<string, Schema>)['version']?.['const'],
      EXPORT_PROFILE_VERSION,
    );
    strictEqual(
      (schema['properties'] as Record<string, Schema>)['description']?.['maxLength'],
      PROFILE_DESCRIPTION_MAX,
    );
  });

  it('carries the live vocabulary, so a new kind in the contract fails here until the schema is regenerated', () => {
    const defs = schema['$defs'] as Record<string, { enum?: string[] }>;
    deepStrictEqual(defs['nodeKind']?.enum, [...NODE_KINDS]);
    deepStrictEqual(defs['edgeKind']?.enum, [...EDGE_KINDS]);
    deepStrictEqual(defs['sensitivity']?.enum, [...SENSITIVITY]);
    deepStrictEqual(defs['provenance']?.enum, [...PROVENANCE]);
    const fields = (schema['properties'] as Record<string, { items?: { enum?: string[] } }>)[
      'allowFields'
    ];
    deepStrictEqual(fields?.items?.enum, [...RECORD_FIELDS]);
  });

  it('accepts every shipped profile, written out as a declared profile', () => {
    for (const p of Object.values(PROFILES)) {
      const { name: _name, ...declared } = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
      ok(validates(schema, schema, declared), `schema accepts '${p.name}'`);
      deepStrictEqual(parseDeclaredProfiles({ [`x-${p.name}`]: declared })[`x-${p.name}`], {
        ...p,
        name: `x-${p.name}`,
      });
    }
  });
});

describe('export profile / provenance and untrusted text are profile fields', () => {
  const RUN = 'run-0001';
  const mk = (
    kind: SeamlineNode['kind'],
    name: string,
    over: Partial<SeamlineNode> = {},
  ): SeamlineNode => ({
    id: nodeId('repo', kind, name),
    kind,
    name,
    sensitivity: DEFAULT_SENSITIVITY[kind],
    provenance: 'EXTRACTED',
    confidence: 1,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
    ...over,
  });
  const link = (
    src: SeamlineNode,
    dst: SeamlineNode,
    provenance: SeamlineEdge['provenance'] = 'EXTRACTED',
  ): SeamlineEdge => ({
    kind: 'IMPORTS',
    src: src.id,
    dst: dst.id,
    provenance,
    confidence: 1,
    props: {},
    firstSeenRun: RUN,
    lastSeenRun: RUN,
    deletedAt: null,
  });
  const strict = parseExportProfile({
    ...VALID,
    name: 'strict',
    allow: [['File', 'internal']],
    allowProps: {},
    allowEdgeProps: {},
    allowProvenance: ['EXTRACTED'],
  });

  const a = mk('File', 'a');
  const guessed = mk('File', 'guess', { provenance: 'INFERRED' });
  const tainted = mk('File', 'tainted', { untrusted: true });
  const edges = [link(a, a), link(a, guessed, 'INFERRED')];

  it('withholds a node whose provenance the profile does not list, and says why', () => {
    const out = applyProfile([a, guessed], [], strict);
    deepStrictEqual(
      out.nodes.map((n) => n.id),
      [a.id],
    );
    strictEqual(out.withheld.items[0]?.reason, 'provenance-not-allowed');
    ok(
      !/guess/.test(out.withheld.items[0]?.detail ?? ''),
      'the detail names no value of the withheld item',
    );
  });

  it('withholds an untrusted node unless includeUntrusted is true', () => {
    const out = applyProfile([a, tainted], [], strict);
    deepStrictEqual(
      out.nodes.map((n) => n.id),
      [a.id],
    );
    strictEqual(out.withheld.items[0]?.reason, 'untrusted-not-allowed');
    const open = parseExportProfile({
      ...VALID,
      name: 'open',
      allow: [['File', 'internal']],
      allowProps: {},
      allowEdgeProps: {},
      allowFields: ['id', 'untrusted'],
      includeUntrusted: true,
    });
    const released = applyProfile([tainted], [], open).nodes;
    deepStrictEqual(released, [{ id: tainted.id, untrusted: true }]);
  });

  it('withholds an edge whose provenance the profile does not list', () => {
    const out = applyProfile(
      [a, guessed],
      edges,
      parseExportProfile({
        ...strict,
        allowEdges: ['IMPORTS'],
        allowProvenance: ['EXTRACTED', 'INFERRED'],
      }),
    );
    strictEqual(out.edges.length, 2);
    const onlyExtracted = applyProfile(
      [a, guessed],
      edges,
      parseExportProfile({ ...strict, allowEdges: ['IMPORTS'], allowProvenance: ['EXTRACTED'] }),
    );
    strictEqual(onlyExtracted.edges.length, 1);
    strictEqual(
      onlyExtracted.withheld.items.find((w) => w.item === 'edge')?.reason,
      'provenance-not-allowed',
    );
  });

  it('applies the same decisions to a live view as to an export', () => {
    const view = {
      nodesByKind: (k: string) => [a, guessed, tainted].filter((n) => n.kind === k),
      node: (id: string) => [a, guessed, tainted].find((n) => n.id === id),
      edgesFrom: (id: string) => edges.filter((e) => e.src === id),
      edgesTo: (id: string) => edges.filter((e) => e.dst === id),
      scopeStatus: () => 'PASS' as const,
    };
    const profile = parseExportProfile({ ...strict, allowEdges: ['IMPORTS'], allowEdgeProps: {} });
    const pv = profileView(view as never, profile);
    deepStrictEqual(
      pv.nodesByKind('File').map((n) => n.id),
      applyProfile([a, guessed, tainted], edges, profile).nodes.map((n) => n.id),
    );
    strictEqual(pv.node(guessed.id), undefined);
    strictEqual(pv.node(tainted.id), undefined);
    strictEqual(
      pv.edgesFrom(a.id).length,
      1,
      'the INFERRED edge to a withheld node is not a side channel',
    );
  });

  it('keeps every shipped profile releasing inferred and untrusted nodes, as before the format had those fields', () => {
    const corpus = [
      mk('Repo', 'r', { provenance: 'LLM_SUGGESTED' }),
      mk('Module', 'm', { untrusted: true }),
      mk('Module', 'n', { provenance: 'INFERRED' }),
    ];
    for (const p of Object.values(PROFILES)) {
      strictEqual(
        applyProfile(corpus, [], p).nodes.length,
        corpus.length,
        `'${p.name}' releases all three`,
      );
    }
  });
});

describe('export profile / where the format is documented', () => {
  it('links to the repository named in the root package.json, not to a path an installed user cannot open', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'),
    ) as { repository: { url: string } };
    const repository = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
    strictEqual(FORMAT_DOC_URL, `${repository}/blob/main/docs/design/export-profile.md`);
    ok(
      String(schema['$id']).startsWith(`${repository}/`),
      'the schema $id is on the same repository',
    );
  });

  it('counts the description in code points, as JSON Schema does, so the two agree on an emoji', () => {
    const emoji = '\u{1F600}'.repeat(PROFILE_DESCRIPTION_MAX);
    strictEqual(
      emoji.length,
      2 * PROFILE_DESCRIPTION_MAX,
      'twice as many UTF-16 units as characters',
    );
    const declared = { ...VALID, description: emoji };
    ok(validates(schema, schema, declared), 'the schema accepts it');
    ok(parserAccepts(declared).ok, 'and so does the parser');
  });
});

describe('export profile / packets', () => {
  const base = {
    version: 1,
    name: 'pk',
    description: 'd',
    allow: [['File', 'internal']],
    allowEdges: [],
    allowProps: {},
    allowEdgeProps: {},
    allowFields: ['id'],
    allowProvenance: ['EXTRACTED'],
    includeUntrusted: false,
  };

  it('keeps the packets a profile names, and leaves the key out when none are named', () => {
    deepStrictEqual(parseExportProfile({ ...base, packets: ['alignment'] }).packets, ['alignment']);
    strictEqual(Object.hasOwn(parseExportProfile(base), 'packets'), false);
    strictEqual(Object.hasOwn(parseExportProfile({ ...base, packets: [] }), 'packets'), false);
  });
});
