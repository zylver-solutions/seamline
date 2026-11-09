import type { ExtractorManifest } from '@seamline/ontology';
import { CHANGE_SCOPE, DEFAULT_DEPTH } from './types.ts';

export const EXTRACTOR_NAME = 'extract-change';
export const EXTRACTOR_VERSION = '0.0.1';

/**
 * The declared manifest. `provenanceCeiling` is `EXTRACTED` because every fact
 * here is read straight out of the object store: a commit sha, an author date,
 * a path pair git itself matched. Nothing in this package infers.
 *
 * `produces` claims `Commit` and `Changeset` and deliberately **not** `File`.
 * Authoritative scope drives tombstoning, and this extractor walks a bounded
 * range: claiming authority over `File` would tombstone every file that had not
 * been touched in the last N commits. File nodes are still emitted, as edge
 * endpoints (including pre-image paths that no other extractor can ever
 * produce, because they no longer exist on disk), but they are contributions to
 * the union, not a claim of completeness.
 */
export function changeManifest(selector: string = `HEAD max=${DEFAULT_DEPTH}`): ExtractorManifest {
  return {
    name: EXTRACTOR_NAME,
    version: EXTRACTOR_VERSION,
    reads: ['.git/**'],
    net: false,
    env: ['PATH', 'SystemRoot'],
    memMb: 256,
    timeoutS: 120,
    provenanceCeiling: 'EXTRACTED',
    produces: [{ scope: CHANGE_SCOPE, kinds: ['Commit', 'Changeset'], selector }],
  };
}

export const CHANGE_MANIFEST: ExtractorManifest = changeManifest();
