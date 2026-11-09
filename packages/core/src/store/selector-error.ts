/** Invalid authority metadata is never a whole-scope claim. */
export class SelectorError extends Error {
  readonly selector: string;
  constructor(selector: string, reason: string) {
    // A malformed envelope may contain reversible credentials before it can be
    // decoded and guarded. Neither diagnostics nor retained payloads expose it.
    const safe = selector.startsWith('/@canonical/') ? '/@canonical/' : selector;
    const shown = safe.length > 256 ? safe.slice(0, 256) + '...' : safe;
    super(`invalid authoritative-scope selector ${JSON.stringify(shown)}: ${reason}`);
    this.name = 'SelectorError';
    this.selector = safe;
  }
}
