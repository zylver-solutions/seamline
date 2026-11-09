/**
 * The tokenizer moved here from `extract-data`, where `sql-ddl.ts` was its only
 * importer. The first group of tests pins what it produces on the statement forms
 * the DDL reader's tests and fixtures cover (comments, quoting, escapes,
 * dollar-quoted bodies, numbers, two-character operators, nested brackets), with
 * expected values taken from the lexer as it was before the move, so
 * `extract-data`'s output stays byte-identical. The second group covers the one
 * addition: tokens that the text cut short are marked `unterminated`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitStatements, tokenizeSql } from './index.ts';
import type { Tok } from './index.ts';

const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

test('the SQL tokenizer accepts 256 bracket groups and rejects the 257th deterministically', () => {
  for (const [open, close] of Object.entries(CLOSERS)) {
    const within = open.repeat(256) + '1' + close.repeat(256);
    assert.equal(tokenizeSql(within)[0]?.raw, within);
    assert.throws(() => tokenizeSql(open.repeat(257) + '1' + close.repeat(257)), {
      name: 'RangeError', message: 'SQL nesting limit exceeded (256)',
    });
    assert.throws(() => tokenizeSql(open.repeat(257) + '1'), {
      name: 'RangeError', message: 'SQL nesting limit exceeded (256)',
    });
  }
  assert.equal(rendered(`SELECT '${'('.repeat(3000)}', $$${'['.repeat(3000)}$$ /* ${'{'.repeat(3000)} */`),
    `w:select s:${JSON.stringify('('.repeat(3000))} p:, s:${JSON.stringify('['.repeat(3000))}`);
});

/** One compact, unambiguous rendering of a token tree. */
function render(t: Tok): string {
  if (t.t === 'group') return `${t.v}${t.items.map(render).join(' ')}${CLOSERS[t.v] ?? '?'}`;
  if (t.t === 'word') return t.quoted ? `"${t.v}"` : `w:${t.v}`;
  if (t.t === 'str') return `s:${JSON.stringify(t.v)}`;
  if (t.t === 'num') return `n:${t.v}`;
  return `p:${t.v}`;
}

function rendered(text: string): string {
  return tokenizeSql(text).map(render).join(' ');
}

function statements(text: string): string[] {
  return splitStatements(tokenizeSql(text)).map((s) => s.toks.map(render).join(' '));
}

test('a CREATE TABLE with defaults, a type modifier and an array type lexes as the DDL reader expects', () => {
  const text =
    "CREATE TABLE app.users (\n  id bigserial PRIMARY KEY,\n  email character varying(255) NOT NULL DEFAULT 'a''b',\n  tags text[]\n);";
  assert.equal(
    rendered(text),
    'w:create w:table w:app p:. w:users (w:id w:bigserial w:primary w:key p:, w:email w:character w:varying (n:255) w:not w:null w:default s:"a\'b" p:, w:tags w:text []) p:;',
  );
  assert.deepEqual(
    tokenizeSql(text).map((t) => t.pos),
    [0, 7, 13, 16, 17, 23, 124],
  );
  assert.deepEqual(statements(text), [
    'w:create w:table w:app p:. w:users (w:id w:bigserial w:primary w:key p:, w:email w:character w:varying (n:255) w:not w:null w:default s:"a\'b" p:, w:tags w:text [])',
  ]);
});

test('line and nested block comments produce no tokens, and the offsets still point into the original text', () => {
  const text = '-- line comment\nSELECT 1; /* outer /* nested */ still outer */ SELECT 2';
  assert.equal(rendered(text), 'w:select n:1 p:; w:select n:2');
  assert.deepEqual(
    tokenizeSql(text).map((t) => t.pos),
    [16, 23, 24, 63, 70],
  );
  assert.deepEqual(statements(text), ['w:select n:1', 'w:select n:2']);
});

test('a double-quoted identifier keeps its case and its spaces, and "" is one quote', () => {
  assert.equal(
    rendered('CREATE TABLE "Mixed Case" ("Id" int, "a""b" text)'),
    'w:create w:table "Mixed Case" ("Id" w:int p:, "a"b" w:text)',
  );
});

test('string forms: backslash escapes, doubled quotes, dollar-quoted bodies, and positional parameters', () => {
  const text = "SELECT E'it\\'s', 'x''y', $$a;b$$, $tag$x;y$tag$; SELECT $1, 1.5e3, .5, 2";
  assert.equal(
    rendered(text),
    'w:select s:"it\'s" p:, s:"x\'y" p:, s:"a;b" p:, s:"x;y" p:; w:select n:$1 p:, n:1.5e3 p:, n:.5 p:, n:2',
  );
  // The `;` inside the dollar-quoted bodies does not split a statement.
  assert.deepEqual(statements(text), [
    'w:select s:"it\'s" p:, s:"x\'y" p:, s:"a;b" p:, s:"x;y"',
    'w:select n:$1 p:, n:1.5e3 p:, n:.5 p:, n:2',
  ]);
});

test('COMMENT ON ... IS lexes to the words and the decoded string the DDL reader reads', () => {
  assert.equal(
    rendered("COMMENT ON COLUMN app.users.phone_number IS 'Primary contact phone number';"),
    'w:comment w:on w:column w:app p:. w:users p:. w:phone_number w:is s:"Primary contact phone number" p:;',
  );
});

test('two-character operators are one token, and a stray closing bracket is dropped', () => {
  assert.equal(
    rendered('a::int <= b <> c -> d => e || f != g >= h'),
    'w:a p::: w:int p:<= w:b p:<> w:c p:-> w:d p:=> w:e p:|| w:f p:!= w:g p:>= w:h',
  );
  assert.equal(rendered('a ) b ] c } d'), 'w:a w:b w:c w:d');
});

test('brackets nest into group tokens whose items are the balanced contents', () => {
  const toks = tokenizeSql('f(a, g(b, [c]), {d})');
  assert.equal(render(toks[1] as Tok), '(w:a p:, w:g (w:b p:, [w:c]) p:, {w:d})');
  assert.equal(toks.map((t) => t.pos).join(','), '0,1');
  assert.equal((toks[1] as Tok).raw, '(a, g(b, [c]), {d})');
});

test('a token the text cut short is marked unterminated, and a complete one never is', () => {
  const unterminated = (text: string): string[] => {
    const out: string[] = [];
    const walk = (toks: readonly Tok[]): void => {
      for (const t of toks) {
        if (t.unterminated === true) out.push(`${t.t}:${t.raw}`);
        walk(t.items);
      }
    };
    walk(tokenizeSql(text));
    return out;
  };

  assert.deepEqual(unterminated('INSERT INTO t (a, b) VALUES (1, 2)'), []);
  assert.deepEqual(unterminated("SELECT 'x', \"y\", $$z$$, E'e', (1, [2], {3})"), []);

  // Text that stops inside a bracket marks that bracket and every one enclosing it.
  assert.deepEqual(unterminated('INSERT INTO t (a'), ['group:(a']);
  assert.deepEqual(unterminated('f(a, g(b'), ['group:(a, g(b', 'group:(b']);
  // A closing bracket belonging to an inner group does not close the outer one.
  assert.deepEqual(unterminated('INSERT INTO t (a, f(x)'), ['group:(a, f(x)']);
  // Text that stops inside a line comment does not close the bracket before it.
  assert.deepEqual(unterminated('INSERT INTO t (a, b -- )'), ['group:(a, b -- )']);

  assert.deepEqual(unterminated("SELECT 'abc"), ["str:'abc"]);
  // `''` is an escape, so a quote that only closes the escape leaves the literal open.
  assert.deepEqual(unterminated("SELECT 'abc''"), ["str:'abc''"]);
  assert.deepEqual(unterminated('SELECT "abc'), ['word:"abc']);
  assert.deepEqual(unterminated("SELECT E'abc"), ["str:E'abc"]);
  assert.deepEqual(unterminated('SELECT $$abc'), ['str:$$abc']);
});
