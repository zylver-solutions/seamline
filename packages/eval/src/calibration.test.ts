import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibratedConfidence, confidenceFit, repositoryGroup, type CalibrationDatum } from './calibration.ts';

function samples(repo: string, verdict: 'tp' | 'fp', partition: 'dev' | 'sealed' = 'dev', group = repo): CalibrationDatum[] {
  return Array.from({ length: 40 }, (_, i) => ({ id: `${repo}-${String(i).padStart(2, '0')}`, repo, group, partition, confidence: 0.9, verdict }));
}

test('development-only fit is checked, never refitted, on sealed labels', () => {
  const dev = [...samples('one', 'fp'), ...samples('two', 'fp'), ...samples('three', 'fp')];
  const before = confidenceFit([...dev, ...samples('held-out', 'fp', 'sealed')]);
  const after = confidenceFit([...dev, ...samples('held-out', 'tp', 'sealed')]);
  assert.deepEqual(before.model, after.model);
  assert.deepEqual(before.folds, after.folds);
  assert.equal(before.inputDigest, after.inputDigest);
  assert.equal(before.model[3]?.action, 'refit');
  assert.equal(before.model[3]?.estimate, 0);
  assert.equal(calibratedConfidence(0.9, before.model), 0);
  assert.equal(before.sealedCheck.calibratedBrier, 0);
  assert.equal(after.sealedCheck.calibratedBrier, 1, 'a wrong held-out estimate is reported, not repaired from held-out labels');
  assert.equal(after.sealedCheck.estimated, 40);
});

test('each held-out upstream is absent from its fitted fold, including every pin', () => {
  const dev = [...samples('parent', 'fp', 'dev', 'same-upstream'), ...samples('fix', 'fp', 'dev', 'same-upstream'), ...samples('two', 'fp'), ...samples('three', 'fp')];
  const before = confidenceFit(dev);
  const changed = confidenceFit(dev.map((d) => d.group === 'same-upstream' ? { ...d, verdict: 'tp' } : d));
  const fold = before.folds.find((f) => f.heldOutRepos.includes('parent'))!;
  const other = changed.folds.find((f) => f.heldOutRepos.includes('parent'))!;
  assert.deepEqual(fold.heldOutRepos, ['fix', 'parent']);
  assert.deepEqual(fold.trainingRepos, ['three', 'two']);
  assert.deepEqual(fold.model, other.model);
  assert.equal(fold.check.labelled, 80);
  assert.equal(fold.check.calibratedBrier, 0);
  assert.equal(other.check.calibratedBrier, 1);
  assert.equal(before.trainingGroups, 3);
  assert.equal(before.folds.length, 3);
});

test('paired Brier scores exclude labelled findings in sparse bands from both errors', () => {
  const fit = confidenceFit([
    ...samples('one', 'fp'), ...samples('two', 'fp'), ...samples('three', 'fp'),
    { ...samples('one', 'fp')[0]!, id: 'one-sparse', confidence: 0.6 },
    ...samples('held-out', 'tp', 'sealed'),
    { ...samples('held-out', 'fp', 'sealed')[0]!, id: 'held-out-sparse', confidence: 0.6 },
  ]);
  assert.equal(fit.model[1]?.repositories, 1);
  assert.equal(calibratedConfidence(0.6, fit.model), null);
  assert.equal(fit.sealedCheck.findings, 41);
  assert.equal(fit.sealedCheck.labelled, 41);
  assert.equal(fit.sealedCheck.estimated, 40);
  assert.equal(fit.sealedCheck.rawBrier, 0.01);
  assert.equal(fit.sealedCheck.calibratedBrier, 1);
});

test('sparse bands retain uncertainty and overlapping Wilson intervals do not trigger refit', () => {
  const oneUpstream = confidenceFit(samples('only', 'fp'));
  assert.equal(oneUpstream.model[3]?.action, 'not-estimable');
  assert.equal(calibratedConfidence(0.9, oneUpstream.model), null);
  assert.equal(oneUpstream.folds[0]?.check.estimated, 0);
  assert.equal(oneUpstream.folds[0]?.check.rawBrier, null);
  const overlap = confidenceFit([samples('one', 'tp')[0]!, samples('two', 'fp')[0]!]);
  assert.equal(overlap.model[3]?.precision, 0.5, 'point precision is outside the nominal band');
  assert.ok((overlap.model[3]?.interval?.hi ?? 0) > 0.85, 'sampling uncertainty still overlaps the nominal band');
  assert.equal(overlap.model[3]?.action, 'retain');
  assert.equal(calibratedConfidence(0.9, overlap.model), 0.9);
  assert.equal(overlap.model[0]?.action, 'not-estimable');
  const upward = confidenceFit([...samples('one', 'tp'), ...samples('two', 'tp')]
    .map((d) => ({ ...d, confidence: 0.3 })));
  assert.equal(upward.model[0]?.action, 'refit');
  assert.equal(upward.model[0]?.estimate, 1);
  assert.equal(calibratedConfidence(0.3, upward.model), 1);
});

test('unknown and unclear labels keep counts but cannot supply fitted positives or negatives', () => {
  const fit = confidenceFit([
    ...samples('one', 'fp'), ...samples('two', 'fp'),
    { ...samples('unclear', 'tp')[0]!, verdict: 'unclear' },
    { ...samples('unlabelled', 'tp')[0]!, verdict: null },
  ]);
  assert.equal(fit.model[3]?.findings, 82);
  assert.equal(fit.model[3]?.labelled, 80);
  assert.equal(fit.model[3]?.unclear, 1);
  assert.equal(fit.model[3]?.estimate, 0);
});

test('same GitHub upstream has one identity across case, .git suffix and parent/fix checkout names', () => {
  assert.equal(repositoryGroup('https://github.com/Owner/Project.git'), repositoryGroup('https://GITHUB.com/owner/project/'));
  assert.notEqual(repositoryGroup('https://github.com/owner/project'), repositoryGroup('https://github.com/owner/other'));
  assert.equal(repositoryGroup('https://one:two@example.invalid/project.git?q=one#two'), repositoryGroup('https://example.invalid/project'));
  assert.throws(() => repositoryGroup('invalid'), /invalid corpus clone URL/);
  assert.throws(() => repositoryGroup('http://example.invalid/project'), /HTTPS/);
});

test('one upstream across development and sealed partitions is refused', () => {
  assert.throws(() => confidenceFit([...samples('dev', 'fp', 'dev', 'same'), ...samples('sealed', 'tp', 'sealed', 'same')]), /cannot train calibration/);
});

test('fitting identity and models are invariant under input permutation', () => {
  const data = [...samples('one', 'fp'), ...samples('two', 'fp'), ...samples('three', 'tp'), ...samples('sealed', 'tp', 'sealed')];
  assert.deepEqual(confidenceFit(data), confidenceFit(data.slice().reverse()));
  assert.throws(() => confidenceFit([{ ...data[0]!, confidence: Number.NaN }]), /finite/);
  assert.throws(() => confidenceFit([data[0]!, data[0]!]), /duplicate finding id/);
});
