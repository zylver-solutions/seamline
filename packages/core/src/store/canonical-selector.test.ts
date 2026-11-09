import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import type { AuthoritativeScope } from '@seamline/ontology';
import { RedactionError } from '@seamline/security';
import { secretCanary } from '@seamline/security/corpus';
import {
  assertCanonicalSelectorBudget, CANONICAL_SELECTOR_PREFIX, compileCanonicalSelector,
  encodeCanonicalSelector, MAX_CANONICAL_SELECTOR_BYTES, MAX_CANONICAL_SELECTOR_RULES,
  type CanonicalRule,
} from './canonical-selector.ts';
import { compileSelector, SelectorError } from './scope-selector.ts';

const raw = (body: unknown): string => CANONICAL_SELECTOR_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('hex');
const claim = (selector: string): AuthoritativeScope => ({ scope: 'contracts', kinds: ['Contract'], selector });

// A fixed wire example, independently specified in ADR-0018.
const expectedJson = '{"path":"src/form.ts","rules":[["exact","abc"],["prefix","abc#/"]]}';
const wireExample = CANONICAL_SELECTOR_PREFIX + Buffer.from(expectedJson, 'utf8').toString('hex');

test('encoding and decoding cannot hide closed-format credentials in authority paths or rules', () => {
  const canary = secretCanary('aws-access-key-id/documented-example').secret;
  const encodedCanary = Buffer.from(canary).toString('hex');
  for (const input of [
    { path: `src/${canary}.ts`, rules: [['exact', 'A']] as const },
    { path: 'src/a.ts', rules: [['exact', canary]] as const },
    { path: 'src/a.ts', rules: [['prefix', canary + '#/']] as const },
  ]) {
    const unsafe = raw(input);
    for (const operation of [() => encodeCanonicalSelector(input), () => compileCanonicalSelector(unsafe)]) {
      assert.throws(operation, (error: unknown) => {
        assert.ok(error instanceof RedactionError);
        assert.equal(error.message.includes(canary), false);
        assert.equal(error.message.includes(encodedCanary), false);
        return true;
      });
    }
    for (const malformed of [unsafe + '0', unsafe.replace('/v1/', '/v2/'), raw({ ...input, extra: true })]) {
      assert.throws(() => compileCanonicalSelector(malformed), (error: unknown) => {
        assert.ok(error instanceof SelectorError);
        assert.equal(error.selector, '/@canonical/');
        assert.equal(JSON.stringify(error).includes(canary), false);
        assert.equal(JSON.stringify(error).includes(encodedCanary), false);
        assert.equal(error.message.includes(encodedCanary), false);
        return true;
      });
    }
  }
});

test('authority budgets precede credential scans for both producers and aggregate readers', () => {
  const canary = secretCanary('aws-access-key-id/documented-example').secret;
  assert.throws(() => encodeCanonicalSelector({ path: 'a.ts', rules: [['exact', canary + '/' + 'x'.repeat(MAX_CANONICAL_SELECTOR_BYTES)]] }),
    /canonical byte budget exceeded/);
  const unsafe = raw({ path: 'a.ts', rules: [['exact', canary]] });
  const big = encodeCanonicalSelector({ path: 'a.ts', rules: [['exact', 'x'.repeat(20_000)]] });
  assert.throws(() => assertCanonicalSelectorBudget([claim(unsafe), claim(big), claim(big)]), /aggregate canonical byte budget/,
    'even credential rejection must wait for the complete encoded-byte preflight');
});

test('the codec has one literal representation and does not infer scope authority', () => {
  const wire = encodeCanonicalSelector({ path: 'src/form.ts', rules: [['prefix', 'abc#/'], ['exact', 'abc'], ['exact', 'abc']] });
  assert.equal(wire, wireExample);
  const compiled = compileCanonicalSelector(wire);
  assert.equal(compiled.path, 'src/form.ts');
  assert.equal(compiled.matchesName('abc'), true);
  assert.equal(compiled.matchesName('abc#/properties/title'), true);
  assert.equal(compiled.matchesName('abcd#/properties/title'), false);
  assert.equal(compiled.matchesName('abc#'), false);
  assert.equal(compiled.matchesName('src/form.ts'), false);
  assert.throws(() => compileSelector(wire), SelectorError, 'legacy path compilation still refuses the reserved absolute envelope');
});

test('literal Unicode, punctuation and glob-looking names stay distinct and immutable', () => {
  const names = ['a,*?[x]', 'é', 'e\u0301', '🔒:#/field'];
  const compiled = compileCanonicalSelector(encodeCanonicalSelector({ path: 'src/a,*?!.ts', rules: names.map(name => ['exact', name]) }));
  assert.equal(compiled.path, 'src/a,*?!.ts');
  for (const name of names) assert.equal(compiled.matchesName(name), true);
  for (const name of ['a,anything', 'É', 'e', '🔒:#/field/child']) assert.equal(compiled.matchesName(name), false);
  assert.throws(() => { (compiled.rules[0] as unknown as string[])[1] = 'broadened'; }, TypeError);
  assert.equal(compiled.matchesName('broadened'), false);
});

test('malformed and noncanonical bodies never broaden into prefix or whole-scope matching', () => {
  const good = { path: 'src/form.ts', rules: [['exact', 'abc']] };
  for (const body of [
    null, [], {}, { ...good, extra: true }, { rules: good.rules, path: good.path },
    { ...good, path: '' }, { ...good, path: '/src/form.ts' }, { ...good, path: 'C:/form.ts' },
    { ...good, path: '../form.ts' }, { ...good, path: 'src/./form.ts' }, { ...good, path: 'src//form.ts' },
    { ...good, path: 'src\\form.ts' }, { ...good, path: 'src/\u0000.ts' }, { ...good, path: 'src/\ud800.ts' },
    { ...good, rules: [] }, { ...good, rules: [['prefix', '']] },
    { ...good, rules: [[['exact'], 'abc']] }, { ...good, rules: [['unknown', 'abc']] },
    { ...good, rules: [['exact', '\ud800']] }, { ...good, rules: [['exact', '\udfff']] },
    { ...good, rules: [['exact', 'abc'], ['exact', 'abc']] },
    { ...good, rules: [['prefix', 'abc#/'], ['exact', 'abc']] },
  ]) assert.throws(() => compileCanonicalSelector(raw(body)), SelectorError, JSON.stringify(body));
  for (const wire of [CANONICAL_SELECTOR_PREFIX, CANONICAL_SELECTOR_PREFIX + 'f',
    CANONICAL_SELECTOR_PREFIX + 'FF', CANONICAL_SELECTOR_PREFIX + 'ff',
    wireExample.replace('/v1/', '/v2/'), CANONICAL_SELECTOR_PREFIX + Buffer.from(expectedJson + ' ').toString('hex'),
  ]) assert.throws(() => compileCanonicalSelector(wire), SelectorError);
});

test('encoded byte and rule budgets fail before unbounded decoding or claim compilation', () => {
  assert.throws(() => compileCanonicalSelector(CANONICAL_SELECTOR_PREFIX + 'f'.repeat(MAX_CANONICAL_SELECTOR_BYTES)), /byte budget/);
  assert.throws(() => encodeCanonicalSelector({ path: 'src/form.ts', rules: [['exact', 'a'.repeat(MAX_CANONICAL_SELECTOR_BYTES)]] }), /byte budget/);
  assert.throws(() => encodeCanonicalSelector({ path: 'src/form.ts', rules: Array.from({ length: MAX_CANONICAL_SELECTOR_RULES + 1 }, () => ['exact', 'a'] as const) }), /rule count/);
  const big = encodeCanonicalSelector({ path: 'src/form.ts', rules: [['exact', 'a'.repeat(20_000)]] });
  const invalid = CANONICAL_SELECTOR_PREFIX + 'f'.repeat(40_000);
  for (const selectors of [[big, invalid], [invalid, big]])
    assert.throws(() => assertCanonicalSelectorBudget(selectors.map(claim)), /aggregate canonical byte budget/,
      'every encoded claim is budgeted before even the first malformed body is decoded');
  const tiny = encodeCanonicalSelector({ path: 'a.ts', rules: [['exact', 'a']] });
  const smallClaims = Array.from({ length: Math.floor(MAX_CANONICAL_SELECTOR_BYTES / Buffer.byteLength(tiny)) + 1 }, () => claim(tiny));
  assert.throws(() => assertCanonicalSelectorBudget(smallClaims), /aggregate canonical byte budget/);
  assert.throws(() => assertCanonicalSelectorBudget([claim('/@canonical/v1/f'), ...smallClaims]), /aggregate canonical byte budget/,
    'many small claims are preflighted before decoding the malformed first envelope');
  const rules: CanonicalRule[] = Array.from({ length: 1_025 }, (_, n) => ['exact', n.toString(36).padStart(2, '0')]);
  const many = encodeCanonicalSelector({ path: 'a.ts', rules });
  assert.ok(Buffer.byteLength(many, 'utf8') * 2 < MAX_CANONICAL_SELECTOR_BYTES);
  assert.throws(() => assertCanonicalSelectorBudget([claim(many), claim(many)]), /aggregate canonical rule budget/);
  assert.throws(() => assertCanonicalSelectorBudget([{ ...claim(wireExample), kinds: [] }]), /node kinds/);
  assert.doesNotThrow(() => assertCanonicalSelectorBudget([claim(wireExample), { scope: 'infer-join', kinds: [], selector: 'EXPOSED_AS' }]));
});
