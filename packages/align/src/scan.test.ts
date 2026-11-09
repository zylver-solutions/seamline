import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  deleteParentheticals,
  plainText,
  prepareSentences,
  replaceCodeSpans,
  replaceLinks,
  scanMarkdown,
  splitRow,
} from './scan.ts';

const scan = (text: string) => scanMarkdown(text, { maxLineLength: 4096 });

describe('scanner units (3.2)', () => {
  test('list items are their own units with the lead label of a bold span that begins them', () => {
    const { units } = scan(
      '# Title\n\n- **Node >= 22** is required.\n- plain item\n  continued here\n',
    );
    assert.deepEqual(
      units.map((u) => [u.type, u.label, u.lineStart, u.lineEnd, u.text]),
      [
        ['list-item', 'Node >= 22', 3, 3, '**Node >= 22** is required.'],
        ['list-item', null, 4, 5, 'plain item continued here'],
      ],
    );
    assert.deepEqual(units[0]?.headingPath, ['Title']);
  });

  test('each table row is its own unit, with its own line range', () => {
    const { units, tables } = scan('| A | B |\n| --- | --- |\n| 1 | two |\n| 3 | four |\n');
    assert.deepEqual(
      units.map((u) => [u.type, u.lineStart, u.text]),
      [
        ['table-row', 3, '1 | two'],
        ['table-row', 4, '3 | four'],
      ],
    );
    assert.deepEqual(tables[0]?.header, ['A', 'B']);
  });

  test('a pipe inside a code span or escaped with a backslash is not a cell delimiter', () => {
    assert.deepEqual(splitRow('| `a|b` | c \\| d | e |'), ['`a|b`', 'c | d', 'e']);
  });

  test('fenced and indented code, HTML blocks and HTML comments are skipped entirely', () => {
    const text = [
      'Real paragraph.',
      '',
      '```',
      'Output is JSON and CSV from the CLI.',
      '```',
      '',
      '    Output is JSON and CSV from the CLI.',
      '',
      '<!-- Output is JSON and CSV from the CLI. -->',
      '',
      '<div>',
      'Output is JSON and CSV from the CLI.',
      '</div>',
      '',
      'Another paragraph.',
    ].join('\n');
    assert.deepEqual(
      scan(text).units.map((u) => u.text),
      ['Real paragraph.', 'Another paragraph.'],
    );
  });

  test('front matter is recognised and kept out of the prose units', () => {
    const result = scan('---\ntitle: A page\nstatus: draft\n---\n\nBody text.\n');
    assert.deepEqual(result.frontMatter, { title: 'A page', status: 'draft' });
    assert.deepEqual(
      result.units.map((u) => u.text),
      ['Body text.'],
    );
  });

  test('a claim line range is the unit, not the block it sits in', () => {
    const { units } = scan('Intro.\n\n- first\n- second\n- third\n');
    assert.deepEqual(
      units.map((u) => [u.lineStart, u.lineEnd]),
      [
        [1, 1],
        [3, 3],
        [4, 4],
        [5, 5],
      ],
    );
  });

  test('a line over the bound is cut and reported, and only its first characters are scanned', () => {
    const long = `${'x'.repeat(50)} tail`;
    const result = scanMarkdown(`${long}\n\nshort\n`, { maxLineLength: 20 });
    assert.deepEqual(result.truncatedLines, [1]);
    assert.equal(result.units[0]?.text, 'x'.repeat(20));
  });

  test('crlf line endings are read like lf', () => {
    assert.deepEqual(
      scan('- **A** one\r\n- **B** two\r\n').units.map((u) => u.label),
      ['A', 'B'],
    );
  });

  test('heading paths nest and pop', () => {
    const { units } = scan('# A\n\n## B\n\ntext b\n\n# C\n\ntext c\n');
    assert.deepEqual(
      units.map((u) => u.headingPath),
      [['A', 'B'], ['C']],
    );
  });
});

describe('inline helpers', () => {
  test('links, images and reference links become their text', () => {
    assert.equal(replaceLinks('a [b](http://x) ![c](d.png) [e][ref] [lone] f'), 'a b c e [lone] f');
  });

  test('code spans are replaced with the callback, matching fence lengths', () => {
    assert.equal(
      replaceCodeSpans('a `b` c ``d ` e`` f `unclosed', (c) => `<${c}>`),
      'a <b> c <d ` e> f `unclosed',
    );
  });

  test('parentheticals are deleted innermost first, and unbalanced ones yield null', () => {
    assert.equal(deleteParentheticals('a (b (c) d) e'), 'a  e');
    assert.equal(deleteParentheticals('a (b'), null);
    assert.equal(deleteParentheticals('a b) c'), null);
  });

  test('plain text keeps code span content and drops links and emphasis', () => {
    assert.equal(plainText('**Bold** `code` [link](u) _em_'), 'Bold code link em');
  });
});

describe('preparation P (3.2)', () => {
  test('lower-cases, drops code spans and parentheticals, and removes the trailing full stop', () => {
    assert.deepEqual(prepareSentences('The `--json` flag (see below) prints JSON.'), [
      'the flag prints json',
    ]);
  });

  test('splits on a full stop followed by a capital letter, a digit, a code span or the end', () => {
    assert.deepEqual(prepareSentences('One. Two! Three? 4 is a number. `x` begins. End'), [
      'one',
      'two',
      'three',
      '4 is a number',
      'begins',
      'end',
    ]);
  });

  test('does not split inside a number or before a lower-case word', () => {
    assert.deepEqual(prepareSentences('Node 22.13 is e.g. fine.'), ['node 22.13 is e.g. fine']);
  });

  test('a sentence that begins with a code span is split from the one before it, before the span is deleted', () => {
    assert.deepEqual(prepareSentences('Output is JSON. `seamline` prints CSV.'), [
      'output is json',
      'prints csv',
    ]);
  });

  test('a semicolon ends a sentence', () => {
    assert.deepEqual(prepareSentences('First part; second part.'), ['first part', 'second part']);
  });

  test('a parenthetical that holds a sentence end or a semicolon is split and left unbalanced, so its sentences yield nothing', () => {
    assert.deepEqual(prepareSentences('Before (one. Two) after.'), []);
    assert.deepEqual(prepareSentences('Before (a; b) after.'), []);
  });

  test('emphasis markers and link syntax are stripped', () => {
    assert.deepEqual(prepareSentences('**Output** is [JSON](x) and __CSV__.'), [
      'output is json and csv',
    ]);
  });

  test('an inline html comment is not text', () => {
    assert.deepEqual(prepareSentences('Output is JSON <!-- CSV --> and text.'), [
      'output is json and text',
    ]);
  });
});

describe('linear time', () => {
  test('a long line of brackets, backticks and parentheses is scanned in well under a second', () => {
    const nasty = `${'[a'.repeat(1500)} ${'`'.repeat(1500)} ${'('.repeat(1500)}`;
    const started = Date.now();
    prepareSentences(nasty);
    scanMarkdown(`${nasty}\n`, { maxLineLength: 4096 });
    assert.ok(Date.now() - started < 2000, 'scanning took too long');
  });
});
