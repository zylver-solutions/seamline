// A module that does its work at import time, which is when the suite reads its manifest. The
// confined child that reads the manifest must stop it just as the sandbox stops a run.

import net from 'node:net';
import { manifestFor } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-import-time');

net.connect(9, '127.0.0.1').on('error', () => undefined);

export async function run() {
  throw new Error('never reached');
}
