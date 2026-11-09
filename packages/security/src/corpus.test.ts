/**
 * The corpus and the components it tests stay in step, and the corpus files are
 * safe to ship.
 *
 * Three things are asserted here, none of them about a single payload (the
 * outcomes are in conformance.test.ts):
 *
 * 1. Coverage. Every redactor rule has a canary, every closed-format rule has a
 *    refused-in-identity canary, and every neutralisation rule and every layer
 *    of the fence has at least one payload that exercises it. Adding a rule
 *    without a corpus entry fails here.
 * 2. Hygiene. No credential appears contiguously in a corpus file, and a scan of
 *    the raw files with the project's own redactor finds nothing. Invisible
 *    characters are written as `\u` escapes, so the file shows what it holds.
 * 3. The schema. The loader rejects a malformed entry rather than skipping it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CorpusError,
  INJECTION_RULES,
  assembleParts,
  loadInjectionCorpus,
  loadSecretCanaries,
  parseInjectionCorpus,
  parseSecretCorpus,
  readCorpusText,
  secretCanary,
} from './corpus.ts';
import { SECRET_RULES } from './patterns.ts';
import { ENTROPY_RULE_ID, createRedactor } from './redactor.ts';
import { NEUTRALISATION_RULES } from './untrusted.ts';

const SECRETS = loadSecretCanaries();
const INJECTIONS = loadInjectionCorpus();

describe('corpus / coverage', () => {
  it('has a redacted canary for every redactor rule, entropy included', () => {
    const covered = new Set(SECRETS.filter((c) => c.expect === 'redacted').map((c) => c.rule));
    const missing = [...SECRET_RULES.map((r) => r.id), ENTROPY_RULE_ID].filter(
      (id) => !covered.has(id),
    );
    assert.deepEqual(
      missing,
      [],
      `rules with no canary in corpus/secrets.json: ${missing.join(', ')}`,
    );
  });

  it('has a refused-in-identity canary for every closed-format rule, and only for those', () => {
    const closed = SECRET_RULES.filter((r) => r.closedFormat === true)
      .map((r) => r.id)
      .sort();
    const refused = [
      ...new Set(SECRETS.filter((c) => c.expect === 'refused').map((c) => c.rule)),
    ].sort();
    assert.deepEqual(refused, closed);
  });

  it('names no rule that does not exist', () => {
    const known = new Set<string>([...SECRET_RULES.map((r) => r.id), ENTROPY_RULE_ID]);
    const unknown = SECRETS.filter((c) => !known.has(c.rule)).map((c) => `${c.id} -> ${c.rule}`);
    assert.deepEqual(unknown, []);
  });

  it('exercises every rule of the injection vocabulary at least once', () => {
    const used = new Set(INJECTIONS.entries.map((e) => e.rule));
    const missing = INJECTION_RULES.filter((r) => !used.has(r));
    assert.deepEqual(missing, [], `injection rules with no payload: ${missing.join(', ')}`);
  });

  it('expects every neutralisation rule of the delimit renderer to fire on some payload', () => {
    // injection-phrase is opt-in and off by default; the corpus runs the default.
    const expected = new Set(INJECTIONS.entries.flatMap((e) => e.checks.delimit?.hits ?? []));
    const missing = NEUTRALISATION_RULES.filter(
      (r) => r !== 'injection-phrase' && !expected.has(r),
    );
    assert.deepEqual(
      missing,
      [],
      `delimit rules no payload expects to fire: ${missing.join(', ')}`,
    );
  });

  it('gives every category of the task its own payloads', () => {
    const categories = new Set(INJECTIONS.entries.map((e) => e.category));
    for (const wanted of [
      'instruction-override',
      'fake-role',
      'fake-chat-template',
      'fake-tool',
      'forged-delimiter',
      'zero-width',
      'bidi',
      'control-characters',
      'bracket-run',
      'long-line',
      'benign',
    ]) {
      assert.ok(categories.has(wanted), `no payload in category ${wanted}`);
    }
  });
});

describe('corpus / hygiene', () => {
  for (const name of ['secrets.json', 'injections.json'] as const) {
    it(`${name} is plain ASCII, so an invisible character cannot hide in review`, () => {
      const nonAscii = /[^\u0009\u000A -~]/.exec(readCorpusText(name));
      assert.equal(
        nonAscii,
        null,
        `${name} contains U+${nonAscii?.[0].codePointAt(0)?.toString(16)}; write it as a \\u escape`,
      );
    });

    it(`${name} is clean under the project's own redactor, rules and entropy included`, () => {
      const r = createRedactor();
      r.redactString(readCorpusText(name), name, 'file');
      const findings = r.redactionReport().findings.map((f) => f.rule);
      assert.deepEqual(findings, [], `${name} would trip a scanner: ${findings.join(', ')}`);
    });
  }

  it('secrets.json never holds a credential contiguously', () => {
    const raw = readCorpusText('secrets.json');
    for (const c of SECRETS) {
      assert.ok(!raw.includes(c.secret), `${c.id}: write the secret as several parts`);
    }
  });

  it('says why every canary cannot be live', () => {
    for (const c of SECRETS)
      assert.ok(c.fakeBecause.length >= 20, `${c.id}: fakeBecause is too short to mean anything`);
  });

  it('reads a canary by id, and fails loudly for an id that is gone', () => {
    assert.equal(
      secretCanary('aws-access-key-id/documented-example').secret,
      'AKIAIOSFODNN7EXAMPLE',
    );
    assert.throws(() => secretCanary('aws-access-key-id/no-such-entry'), CorpusError);
  });
});

describe('corpus / schema', () => {
  const secretEntry = {
    id: 'jwt/example',
    category: 'secret',
    rule: 'jwt',
    surface: 'free-text',
    expect: 'redacted',
    fakeBecause: 'a made-up value that no service issued',
    template: ['x {{secret}} y'],
    secret: ['a', 'b'],
  };
  const secretDoc = (entries: unknown[]): unknown => ({
    format: 'seamline-corpus/1',
    kind: 'secrets',
    description: 'd',
    entries,
  });
  const injectionEntry = {
    id: 'benign/example',
    category: 'benign',
    rule: 'inert-text',
    expect: 'delimited',
    description: 'd',
    payload: ['hello'],
  };
  const injectionDoc = (entries: unknown[]): unknown => ({
    format: 'seamline-corpus/1',
    kind: 'injections',
    description: 'd',
    nonce: 'abcdef0123456789',
    entries,
  });

  it('accepts a well-formed entry and assembles its parts', () => {
    const [c] = parseSecretCorpus(secretDoc([secretEntry]));
    assert.equal(c?.secret, 'ab');
    assert.equal(c?.text, 'x ab y');
    assert.equal(parseInjectionCorpus(injectionDoc([injectionEntry])).entries[0]?.payload, 'hello');
  });

  it('expands a repeated part', () => {
    assert.equal(assembleParts(['<', { repeat: 'ab', times: 3 }, '>'], 'p'), '<ababab>');
  });

  const rejected: ReadonlyArray<[string, () => unknown, RegExp]> = [
    [
      'an unknown key',
      () => parseSecretCorpus(secretDoc([{ ...secretEntry, extra: 1 }])),
      /unknown key "extra"/,
    ],
    [
      'a missing rule',
      () => parseSecretCorpus(secretDoc([{ ...secretEntry, rule: undefined }])),
      /missing "rule"|rule/,
    ],
    [
      'a duplicate id',
      () => parseSecretCorpus(secretDoc([secretEntry, secretEntry])),
      /duplicate id/,
    ],
    [
      'a badly formed id',
      () => parseSecretCorpus(secretDoc([{ ...secretEntry, id: 'JWT' }])),
      /id "JWT"/,
    ],
    [
      'a template without the placeholder',
      () => parseSecretCorpus(secretDoc([{ ...secretEntry, template: ['none'] }])),
      /exactly once/,
    ],
    [
      'a free-text entry that expects a refusal',
      () => parseSecretCorpus(secretDoc([{ ...secretEntry, expect: 'refused' }])),
      /free-text surface/,
    ],
    [
      'an unknown outcome',
      () => parseSecretCorpus(secretDoc([{ ...secretEntry, expect: 'ignored' }])),
      /one of redacted, refused/,
    ],
    [
      'an empty parts list',
      () => parseSecretCorpus(secretDoc([{ ...secretEntry, secret: [] }])),
      /non-empty array of parts/,
    ],
    ['a repeat with no count', () => assembleParts([{ repeat: 'a' }], 'p'), /missing "times"/],
    ['a runaway repeat', () => assembleParts([{ repeat: 'a', times: 5_000_000 }], 'p'), /exceed/],
    [
      'an unknown injection rule',
      () => parseInjectionCorpus(injectionDoc([{ ...injectionEntry, rule: 'vibes' }])),
      /one of nonce-fence/,
    ],
    [
      'an outcome other than delimited',
      () => parseInjectionCorpus(injectionDoc([{ ...injectionEntry, expect: 'redacted' }])),
      /must be "delimited"/,
    ],
    [
      'a check for an unknown renderer',
      () => parseInjectionCorpus(injectionDoc([{ ...injectionEntry, checks: { llm: {} } }])),
      /one of fence, delimit/,
    ],
    [
      'delimit-only checks on the fence',
      () =>
        parseInjectionCorpus(
          injectionDoc([{ ...injectionEntry, checks: { fence: { truncated: true } } }]),
        ),
      /delimit renderer only/,
    ],
    [
      'a wrong format tag',
      () => parseInjectionCorpus({ ...(injectionDoc([injectionEntry]) as object), format: 'v0' }),
      /"format" must be/,
    ],
    [
      'a nonce that is not alphanumeric',
      () => parseInjectionCorpus({ ...(injectionDoc([injectionEntry]) as object), nonce: 'a>>>b' }),
      /alphanumeric/,
    ],
  ];
  for (const [label, run, message] of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(run, (e: unknown) => e instanceof CorpusError && message.test(e.message));
    });
  }
});
