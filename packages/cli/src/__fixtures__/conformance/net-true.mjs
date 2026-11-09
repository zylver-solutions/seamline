// A manifest that asks for the network. There is no opt-in in v0.1 (v3 section 2.7).

import { manifestFor } from './lib.mjs';

export const MANIFEST = { ...manifestFor('conformance-net-true'), net: true };

export async function run() {
  throw new Error('never reached');
}
