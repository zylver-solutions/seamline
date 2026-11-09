/**
 * The one write site (design 8.5): every byte `seamline align` emits, the
 * packet and both summaries included, leaves through `writeOutput`.
 *
 * `Rendered` is opaque and can only be made from a `RedactedPacket` (the token
 * is module-private), and `writeOutput` accepts nothing else, so the redactor
 * sits in front of every output by construction. A test fails if a second call
 * site that writes to a file or to stdout appears in this package.
 */

import type { RedactedPacket } from './redact.ts';
import { summaryJson, summaryText } from './summary.ts';

/** Where the CLI lets the package write. The CLI supplies both functions. */
export interface AlignSink {
  stdout(text: string): void;
  file(path: string, text: string): void;
}

export type Destination =
  { readonly to: 'stdout' } | { readonly to: 'file'; readonly path: string };

const TOKEN = Symbol('seamline.align.rendered');

export class Rendered {
  readonly text: string;
  constructor(token: symbol, text: string) {
    if (token !== TOKEN)
      throw new TypeError('Rendered output can only be made from a RedactedPacket');
    this.text = text;
    Object.freeze(this);
  }
}

/** The packet itself. */
export function renderPacket(redacted: RedactedPacket): Rendered {
  return new Rendered(TOKEN, redacted.bytes);
}

/** The human summary. */
export function renderSummaryText(redacted: RedactedPacket, packetEmitted = false): Rendered {
  return new Rendered(TOKEN, summaryText(redacted, packetEmitted));
}

/** The summary object, as JSON. */
export function renderSummaryJson(redacted: RedactedPacket): Rendered {
  return new Rendered(TOKEN, summaryJson(redacted));
}

/** The only function in this package that writes a file or stdout. */
export function writeOutput(sink: AlignSink, destination: Destination, rendered: Rendered): void {
  if (!(rendered instanceof Rendered)) throw new TypeError('only rendered output can be written');
  if (destination.to === 'stdout') sink.stdout(rendered.text);
  else sink.file(destination.path, rendered.text);
}
