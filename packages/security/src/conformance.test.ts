/**
 * Corpus conformance: every entry in the public injection corpus is run through
 * the component it targets, and the test asserts the outcome the entry states.
 *
 * - `corpus/secrets.json` goes through the redactor. A free-text entry must come
 *   out as exactly its surrounding text with the credential replaced by its
 *   reference; an identity entry must be refused without the credential in the
 *   error, the report or anywhere else.
 * - `corpus/injections.json` goes through both untrusted-content renderers.
 *   Every payload must satisfy the structural invariants of the block (one
 *   opening, one closing, nothing in the body that could be read as either, no
 *   invisible or control characters), and then the entry's own `present` and
 *   `absent` lists for that renderer.
 *
 * The expected outcomes live in the corpus, not here, so a contributor adds a
 * case by editing JSON and this file runs it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nodeId } from '@seamline/ontology';
import type { NodeId, SeamlineEdge, SeamlineNode } from '@seamline/ontology';
import { loadInjectionCorpus, loadSecretCanaries, SECRET_PLACEHOLDER } from './corpus.ts';
import type { InjectionPayload, RendererChecks, SecretCanary } from './corpus.ts';
import {
  NEUTRALIZED,
  UNTRUSTED_CLOSE_TOKEN,
  UNTRUSTED_OPEN_TOKEN,
  UNTRUSTED_PREAMBLE,
  makeNonce,
  neutralize,
  wrapUntrusted,
} from './fence.ts';
import { REDACTION_MARKER_RE } from './patterns.ts';
import { RedactionError, createRedactor, redactionRef } from './redactor.ts';
import {
  DEFAULT_MAX_CHARS,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  delimit,
  neutraliseUntrusted,
} from './untrusted.ts';

// ---------------------------------------------------------------------------
// Secrets
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

const SECRETS = loadSecretCanaries();
const REDACTED = SECRETS.filter((c) => c.expect === 'redacted');
const REFUSED = SECRETS.filter((c) => c.expect === 'refused');

/** The text around the credential, recovered from the entry itself. */
function surround(c: SecretCanary): { before: string; after: string } {
  const at = c.text.indexOf(c.secret);
  assert.notEqual(at, -1, `${c.id}: the assembled text does not contain its secret`);
  return { before: c.text.slice(0, at), after: c.text.slice(at + c.secret.length) };
}

describe('corpus / secrets / redacted', () => {
  for (const c of REDACTED) {
    it(`${c.id}: the credential is replaced by its reference in every free-text field`, () => {
      const a = nodeId('repo', 'File', 'a.ts');
      const b = nodeId('repo', 'File', 'b.ts');
      const planted = nodeId('repo', 'File', 'planted.ts');
      const r = createRedactor();
      const out = r.redactGraph(
        [node(planted, { name: c.text, props: { detail: c.text } }), node(a), node(b)],
        [edge(a, b, { props: { note: c.text } })],
      );

      const { before, after } = surround(c);
      const expected = `${before}${redactionRef(c.secret)}${after}`;
      const planted_ = out.nodes.find((n) => n.id === planted);
      assert.ok(planted_ !== undefined);
      assert.equal(planted_.name, expected, `${c.id}: name`);
      assert.equal(planted_.props['detail'], expected, `${c.id}: props.detail`);
      assert.equal(out.edges[0]?.props['note'], expected, `${c.id}: edge props.note`);
      assert.match(expected, new RegExp(REDACTION_MARKER_RE.source));

      const everything = JSON.stringify({ nodes: out.nodes, edges: out.edges, report: out.report });
      assert.ok(
        !everything.includes(c.secret),
        `${c.id}: the credential survived somewhere in the output`,
      );
      assert.ok(
        out.report.findings.some((f) => f.rule === c.rule),
        `${c.id}: expected rule ${c.rule}, got [${out.report.findings.map((f) => f.rule).join(', ')}]`,
      );
    });

    it(`${c.id}: redacting the output again changes nothing`, () => {
      const planted = nodeId('repo', 'File', 'planted.ts');
      const once = createRedactor().redactGraph([node(planted, { name: c.text })], []);
      const twice = createRedactor().redactGraph(once.nodes, []);
      assert.deepEqual(twice.nodes, once.nodes);
      assert.equal(twice.report.totalFindings, 0);
    });
  }
});

describe('corpus / secrets / refused', () => {
  const placements: ReadonlyArray<{
    field: string;
    plant: (text: string) => { nodes: SeamlineNode[]; edges: SeamlineEdge[] };
    skipIfMultiline?: boolean;
  }> = [
    {
      field: 'path',
      plant: (text) => ({
        nodes: [node(nodeId('repo', 'File', 'x.ts'), { path: text })],
        edges: [],
      }),
    },
    {
      field: 'srcFile',
      plant: (text) => {
        const a = nodeId('repo', 'File', 'a.ts');
        const b = nodeId('repo', 'File', 'b.ts');
        return { nodes: [node(a), node(b)], edges: [edge(a, b, { srcFile: text })] };
      },
    },
    {
      field: 'id.canonicalName',
      plant: (text) => ({ nodes: [node(nodeId('repo', 'File', text))], edges: [] }),
      skipIfMultiline: true,
    },
  ];

  for (const c of REFUSED) {
    for (const p of placements) {
      if (p.skipIfMultiline === true && c.text.includes('\n')) continue;
      it(`${c.id}: refused in ${p.field}, never rewritten, never quoted`, () => {
        const { nodes, edges } = p.plant(c.text);
        const r = createRedactor();
        assert.throws(
          () => r.redactGraph(nodes, edges),
          (e: unknown) => {
            assert.ok(e instanceof RedactionError, `${c.id}: expected a RedactionError`);
            assert.equal(e.rule, c.rule);
            assert.equal(e.field, p.field);
            assert.ok(!e.message.includes(c.secret), `${c.id}: the refusal quotes the credential`);
            return true;
          },
        );
        assert.ok(
          !JSON.stringify(r.redactionReport()).includes(c.secret),
          `${c.id}: the report holds the credential`,
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Injection payloads
// ---------------------------------------------------------------------------

const INJECTIONS = loadInjectionCorpus();

const CONTROL_CHARACTER = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const KEYCAP_BASE = /^[0-9#*]$/;

/**
 * True when `text` holds a C0 or C1 control except tab and line feed, or a
 * default-ignorable code point (zero-width, bidi, joiner, variation selector and
 * tag characters among them) that is not an emoji presentation selector. The
 * oracle is the runtime's Unicode property, not the implementation's own list.
 * U+FE0F is allowed only where it makes an emoji: directly after a non-ASCII
 * pictograph, or between a keycap base and U+20E3.
 */
function hasUnsafeCharacter(text: string): boolean {
  if (CONTROL_CHARACTER.test(text)) return true;
  const chars = [...text];
  return chars.some((ch, i) => {
    if (!DEFAULT_IGNORABLE.test(ch)) return false;
    if (ch !== '\uFE0F') return true;
    const before = chars[i - 1] ?? '';
    const after = chars[i + 1] ?? '';
    const afterPictograph = PICTOGRAPH.test(before) && (before.codePointAt(0) ?? 0) > 0x7f;
    const insideKeycap = KEYCAP_BASE.test(before) && after === '\u20E3';
    return !afterPictograph && !insideKeycap;
  });
}

const FENCE_TOKEN = /\b(?:BEGIN|END)[\s\-_]*UNTRUSTED[\s\-_]*DATA\b/gi;

/** The delimit sentinel in any spacing or case, as an oracle independent of the implementation. */
const SENTINEL = new RegExp(
  `${[...'SEAMLINE'].join('\\s*')}\\s*(?:[-_]\\s*)?${[...'UNTRUSTED'].join('\\s*')}`,
  'i',
);

/**
 * Generous: the slowest payload is a few hundred thousand characters and takes
 * milliseconds. A matcher that backtracks over whitespace takes minutes, so the
 * bound separates the two without being a benchmark.
 */
const LINEAR_BOUND_MS = 500;

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function applyChecks(label: string, body: string, checks: RendererChecks | undefined): void {
  for (const s of checks?.present ?? []) {
    assert.ok(
      body.includes(s),
      `${label}: expected the block body to contain ${JSON.stringify(s)}`,
    );
  }
  for (const s of checks?.absent ?? []) {
    assert.ok(!body.includes(s), `${label}: the block body still contains ${JSON.stringify(s)}`);
  }
}

function fenceInvariants(e: InjectionPayload, nonce: string): string {
  const started = performance.now();
  const block = wrapUntrusted('code-comment', e.payload, nonce);
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < LINEAR_BOUND_MS,
    `${e.id}: wrapUntrusted took ${Math.round(elapsed)} ms for ${e.payload.length} characters`,
  );
  const lines = block.split('\n');
  assert.equal(lines[0], `<<<${UNTRUSTED_OPEN_TOKEN} id=${nonce} source="code-comment">>>`);
  assert.equal(lines[1], UNTRUSTED_PREAMBLE);
  assert.equal(lines.at(-1), `<<<${UNTRUSTED_CLOSE_TOKEN} id=${nonce}>>>`);
  // Exactly the two delimiters this module wrote: the payload contributed none.
  assert.equal(
    block.match(FENCE_TOKEN)?.length,
    2,
    `${e.id}: the payload added a delimiter-shaped token`,
  );
  const body = lines.slice(2, -1).join('\n');
  assert.ok(!hasUnsafeCharacter(block), `${e.id}: a control or invisible character survived`);
  assert.ok(!body.includes('<<<') && !body.includes('>>>'), `${e.id}: a bracket run survived`);
  assert.equal(
    neutralize(neutralize(e.payload)),
    neutralize(e.payload),
    `${e.id}: neutralize is not idempotent`,
  );
  return body;
}

describe('corpus / injections / fence (wrapUntrusted)', () => {
  for (const e of INJECTIONS.entries) {
    it(`${e.id}: stays inside the block (${e.rule})`, () => {
      const body = fenceInvariants(e, INJECTIONS.nonce);
      applyChecks(e.id, body, e.checks.fence);
    });
    it(`${e.id}: does not depend on the nonce`, () => {
      const nonce = makeNonce();
      const body = fenceInvariants(e, nonce);
      assert.ok(!body.includes(nonce) || e.payload.includes(nonce));
    });
  }

  it('replaces a forged delimiter with the neutralised marker, not with nothing', () => {
    const forged = INJECTIONS.entries.find(
      (e) => e.id === 'forged-delimiter/fence-close-with-nonce',
    );
    assert.ok(forged !== undefined);
    assert.ok(
      wrapUntrusted('code-comment', forged.payload, INJECTIONS.nonce).includes(NEUTRALIZED),
    );
  });
});

describe('corpus / injections / delimit', () => {
  for (const e of INJECTIONS.entries) {
    it(`${e.id}: stays inside the block (${e.rule})`, () => {
      const started = performance.now();
      const result = delimit(e.payload, { source: 'code-comment' });
      const elapsed = performance.now() - started;
      assert.ok(
        elapsed < LINEAR_BOUND_MS,
        `${e.id}: delimit took ${Math.round(elapsed)} ms for ${e.payload.length} characters`,
      );
      const lines = result.rendered.split('\n');
      assert.match(
        lines[1] ?? '',
        /^<<<SEAMLINE-UNTRUSTED source="code-comment" sha256="[0-9a-f]{8}" chars="\d+" truncated="(?:true|false)">>>$/,
        `${e.id}: the header was influenced by the payload`,
      );
      assert.equal(lines.at(-2), UNTRUSTED_CLOSE);
      assert.equal(
        occurrences(result.rendered, UNTRUSTED_OPEN),
        1,
        `${e.id}: more than one opening`,
      );
      assert.equal(
        occurrences(result.rendered, UNTRUSTED_CLOSE),
        1,
        `${e.id}: more than one closing`,
      );
      const body = lines.slice(2, -2).join('\n');
      assert.ok(!SENTINEL.test(body), `${e.id}: a sentinel spelling survived in the body`);
      assert.ok(
        !hasUnsafeCharacter(result.rendered),
        `${e.id}: a control or invisible character survived`,
      );
      assert.ok(
        result.renderedChars <= DEFAULT_MAX_CHARS + 200,
        `${e.id}: the body is not bounded`,
      );
      const once = neutraliseUntrusted(e.payload).text;
      assert.equal(
        neutraliseUntrusted(once).text,
        once,
        `${e.id}: the neutraliser is not idempotent`,
      );

      applyChecks(e.id, body, e.checks.delimit);
      const fired = new Set(result.hits.map((h) => h.rule));
      for (const rule of e.checks.delimit?.hits ?? []) {
        assert.ok(
          fired.has(rule as never),
          `${e.id}: expected neutralisation rule ${rule} to fire, got [${[...fired].join(', ')}]`,
        );
      }
      if (e.checks.delimit?.truncated !== undefined) {
        assert.equal(result.truncated, e.checks.delimit.truncated, `${e.id}: truncated`);
      }
    });
  }
});

describe('corpus / placeholder', () => {
  it('the placeholder is not a rewrite target of the redactor', () => {
    // A template that kept its placeholder would test nothing.
    assert.equal(createRedactor().redactString(SECRET_PLACEHOLDER), SECRET_PLACEHOLDER);
  });
});
