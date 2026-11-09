// An extractor that finds nothing and says PASS. Not misbehaviour: the suite must call it what it is,
// UNAVAILABLE, because a run that emitted nothing has not exercised the controls on what it emits.

import { manifestFor, output } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-empty');

export async function run() {
  return output(MANIFEST, 'PASS', []);
}
