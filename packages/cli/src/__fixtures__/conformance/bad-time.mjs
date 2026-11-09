// Negative control for the time budget: declares two seconds and does not finish. `mode`:
//   spin    a synchronous loop, which nothing inside the process can interrupt
//   wait    a promise that never settles

import { manifestFor } from './lib.mjs';

export const MANIFEST = manifestFor('conformance-bad-time', { timeoutS: 2 });

export async function run(ctx) {
  if ((ctx.options.mode ?? 'spin') === 'wait') {
    await new Promise(() => {});
  }
  for (;;) {
    // never returns
  }
}
