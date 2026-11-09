import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchLabels, parseLabels } from './labels.ts';
import { auditReviews, parseIdentity, parseReviewMetadata } from './review.ts';
import { finding } from './testing.ts';
import type { Finding, ReviewerIdentity } from './types.ts';

const CODE = 'c'.repeat(64);
const identity = (name: string): ReviewerIdentity => ({ kind: 'agent', account: `provider:${name}`, model: 'model-a' });
const META = { codeId: CODE, authors: [identity('author')] };
const primary = { verdict: 'tp', rationale: 'Synthetic source facts disagree.', evidence: ['schema.ts:1'], reviewer: 'provider:first', blind: true, identity: identity('first') };
const second = { verdict: 'tp', rationale: 'Independently checked the synthetic facts.', evidence: ['schema.ts:1'], blind: true, identity: identity('second') };
const make = (n: number): Finding[] => Array.from({ length: n }, (_, i) => finding('held', 'X2_TYPE', `held:Column:c${i}`, `held:SchemaProperty:p${i}`));
function run(found = make(30), edits: Record<string, unknown> = {}, metadata: unknown = META, double = 10) {
  const labels = parseLabels(Object.fromEntries(found.map((f, i) => [f.id, { ...primary, reviews: i < double ? [second] : [], ...edits }])));
  const match = matchLabels(found, labels, true);
  return auditReviews(parseReviewMetadata(metadata === null ? undefined : metadata), CODE, found, match, new Map([['held', 'sealed']]));
}

test('30 independent primary labels and ten complete second reviews meet the declared evidence sample', () => {
  const audit = run();
  assert.equal(audit.metadata, 'bound');
  assert.deepEqual(audit.overall, { findings: 30, labelledFindings: 30, independentPrimaryFindings: 30,
    missingPrimaryFindings: 0, clusters: 30, doubleReviewedClusters: 10, requiredDoubleReviewedClusters: 10,
    reviewPairs: 10, agreeingPairs: 10, agreement: 1, ready: true });
  assert.equal(run([], {}, META, 0).overall.ready, false, 'no evidence is never ready');
});

test('legacy labels, missing metadata, stale code and an empty author roster cannot establish independence', () => {
  for (const metadata of [null, { ...META, codeId: 'd'.repeat(64) }]) {
    const audit = run(make(30), {}, metadata);
    assert.equal(audit.overall.ready, false);
    assert.equal(audit.sealed.independentPrimaryFindings, 0);
  }
  const legacy = run(make(30), { identity: undefined });
  assert.equal(legacy.sealed.independentPrimaryFindings, 0);
  assert.equal(legacy.sealed.doubleReviewedClusters, 0);
  assert.throws(() => parseReviewMetadata({ ...META, authors: [] }));
  const empty = auditReviews({ ...META, authors: [] }, CODE, [], matchLabels([], new Map(), true), new Map());
  assert.notEqual(empty.metadata, 'bound');
});

test('change authors and shared accounts across different models receive no independent second identity', () => {
  assert.equal(run(make(30), { reviewer: 'provider:author', identity: identity('author') }).sealed.independentPrimaryFindings, 0);
  assert.equal(run(make(30), { reviews: [{ ...second, identity: identity('author') }] }).sealed.doubleReviewedClusters, 0);
  assert.equal(run(make(30), { reviews: [{ ...second, identity: { ...identity('first'), model: 'model-b' } }] }).sealed.doubleReviewedClusters, 0);
  assert.equal(run(make(30), { reviewer: 'PROVIDER:AUTHOR', identity: { ...identity('author'), account: ' PROVIDER:AUTHOR ' } }).overall.ready, false);
  assert.equal(run(make(30), { reviewer: 'provider:unrelated' }).sealed.independentPrimaryFindings, 0);
});

test('the sample is ceiling twenty percent of all root-cause clusters, with a floor of ten', () => {
  const tooSmall = run(make(51), {}, META, 10).overall;
  assert.equal(tooSmall.requiredDoubleReviewedClusters, 11);
  assert.equal(tooSmall.doubleReviewedClusters, 10);
  assert.equal(tooSmall.ready, false);
  assert.equal(run(make(51), {}, META, 11).overall.ready, true);
  assert.equal(run(make(30), {}, META, 9).overall.ready, false);
});

test('every finding in a shared-endpoint cluster needs two complete account reviews', () => {
  const found = [finding('held', 'X2_TYPE', 'held:Column:shared', 'held:SchemaProperty:a'),
    finding('held', 'X2_TYPE', 'held:Column:shared', 'held:SchemaProperty:b')];
  const partial = run(found, {}, META, 1).sealed;
  assert.equal(partial.clusters, 1);
  assert.equal(partial.doubleReviewedClusters, 0);
  assert.equal(run(found, {}, META, 2).sealed.doubleReviewedClusters, 1);
  const labels = parseLabels({ [found[0]!.id]: { ...primary, reviews: [second] } });
  const audit = auditReviews(META, CODE, found, matchLabels(found, labels, true), new Map([['held', 'sealed']]));
  assert.equal(audit.sealed.findings, 2);
  assert.equal(audit.sealed.missingPrimaryFindings, 1);
  assert.equal(audit.sealed.doubleReviewedClusters, 0, 'an unlabelled bridge is not omitted');
});

test('disagreements are measured without rewriting labels, and every complete account pair counts', () => {
  const found = make(30);
  const disagree = { ...second, verdict: 'fp' };
  const audit = run(found, { reviews: [second, { ...disagree, identity: identity('third') }] });
  assert.equal(audit.sealed.doubleReviewedClusters, 30);
  assert.equal(audit.sealed.reviewPairs, 90);
  assert.equal(audit.sealed.agreeingPairs, 30);
  assert.equal(audit.sealed.agreement, 1 / 3);
  assert.equal(audit.overall.ready, true, 'the design specifies reporting agreement, not a new threshold');
  assert.throws(() => run(found, { reviews: [second, { ...disagree, identity: identity('second') }] }), /one current verdict/);
});

test('models sharing an account cannot combine partial coverage or form an independent pair', () => {
  const found = [finding('held', 'X2_TYPE', 'held:Column:shared', 'held:SchemaProperty:a'),
    finding('held', 'X2_TYPE', 'held:Column:shared', 'held:SchemaProperty:b')];
  const labels = parseLabels(Object.fromEntries(found.map((f, i) => [f.id, { ...primary,
    identity: { ...identity('first'), model: `model-${i}` }, reviews: [second] }])));
  const audit = auditReviews(META, CODE, found, matchLabels(found, labels, true), new Map([['held', 'sealed']]));
  assert.equal(audit.sealed.independentPrimaryFindings, 2);
  assert.equal(audit.sealed.doubleReviewedClusters, 0, 'neither primary model reviewed the whole cluster');
  const multiple = run(make(30), { reviews: [second, { ...second, verdict: 'fp', identity: { ...identity('first'), model: 'model-b' } }] });
  assert.equal(multiple.sealed.reviewPairs, 60, 'same-account models do not form a pair, and neither cross-account disagreement is hidden');
  assert.equal(multiple.sealed.agreement, 0.5);
});

test('reordering findings, reviewers and authors preserves the numeric audit exactly', () => {
  const found = make(30);
  const a = run(found, { reviews: [second, { ...second, identity: identity('third') }] }, { ...META, authors: [identity('author'), identity('other-author')] });
  const b = run(found.reverse(), { reviews: [{ ...second, identity: identity('third') }, second] }, { ...META, authors: [identity('other-author'), identity('author')] });
  assert.deepEqual(a, b);
});

test('the sample is pooled across partitions and an unverified development primary prevents readiness', () => {
  const dev = Array.from({ length: 51 }, (_, i) => finding('train', 'X2_TYPE', `train:Column:c${i}`, `train:SchemaProperty:p${i}`));
  const held = make(30);
  const found = [...dev, ...held];
  const raw = Object.fromEntries(found.map((f, i) => [f.id, { ...primary, reviews: i < 17 ? [second] : [] }]));
  const partitions = new Map([['train', 'dev'], ['held', 'sealed']] as const);
  const audit = (data: unknown) => auditReviews(META, CODE, found, matchLabels(found, parseLabels(data), true), partitions);
  const good = audit(raw);
  assert.equal(good.overall.requiredDoubleReviewedClusters, 17);
  assert.equal(good.overall.ready, true, 'the design does not require ten reviews separately in each partition');
  assert.equal(good.sealed.doubleReviewedClusters, 0);
  const bad = audit({ ...raw, [dev[0]!.id]: { ...raw[dev[0]!.id], identity: undefined } });
  assert.equal(bad.overall.ready, false, 'development labels used for fitting need identity evidence too');
});

test('invalid identity and secondary review records fail without echoing untrusted sealed text', () => {
  const secret = 'SEALED_PRIVATE_VALUE';
  for (const bad of [null, [], { kind: 'agent', account: 'provider:a' }, { kind: 'human', account: secret, model: secret },
    { kind: 'human', account: 'provider:a', [secret]: secret }]) {
    assert.throws(() => parseIdentity(bad), (error: unknown) => error instanceof Error && !error.message.includes(secret));
  }
  for (const reviews of [null, [{}], [{ ...second, evidence: [] }], [{ ...second, verdict: 'maybe' }], [{ ...second, blind: secret }]]) {
    assert.throws(() => parseLabels({ '0123456789abcdef': { ...primary, reviews } }));
  }
  assert.throws(() => parseReviewMetadata({ ...META, [secret]: secret }), (error: unknown) => error instanceof Error && !error.message.includes(secret));
  const labels = parseLabels({ _review: META, '0123456789abcdef': { ...primary, reviews: [second] } });
  assert.equal(labels.size, 1);
  assert.equal(labels.get('0123456789abcdef')?.reviews?.length, 1);
});
