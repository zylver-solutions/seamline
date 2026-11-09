/** ADR-0018: the non-JSON first line makes earlier readers refuse v2 semantics. */
import { SIF_VERSION } from '@seamline/ontology';

export const SIF_FRAME = `seamline-sif/${SIF_VERSION}`;

export class SifFramingError extends Error {
  readonly line: number;
  constructor(line: number, detail: string) {
    super(detail);
    this.name = 'SifFramingError';
    this.line = line;
  }
}

/** One physical document, including blank lines; bodies may retain legacy CRLF. */
export class SifFraming {
  #framed = false;
  get framed(): boolean { return this.#framed; }

  /** False only for the accepted framing line; true for a body line. */
  accept(raw: string, line: number, terminated = true): boolean {
    if (!raw.startsWith('seamline-sif/')) return true;
    if (this.#framed || line !== 1) throw new SifFramingError(line, 'duplicate or late SIF framing');
    if (raw !== SIF_FRAME) throw new SifFramingError(line, 'unsupported SIF framing');
    if (!terminated) throw new SifFramingError(line, 'SIF framing requires its LF terminator');
    this.#framed = true;
    return false;
  }
}
