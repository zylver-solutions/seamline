import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ONTOLOGY_VERSION } from './extract.ts';

test('the ontology version extract records equals the version of ontology/seamline.yaml', () => {
  const yaml = readFileSync(new URL('../../../../ontology/seamline.yaml', import.meta.url), 'utf8');
  const versions = [...yaml.matchAll(/^version:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]);
  assert.equal(versions.length, 1, 'the ontology has exactly one top-level version key');
  assert.equal(ONTOLOGY_VERSION, versions[0]);
});
