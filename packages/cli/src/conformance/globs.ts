/**
 * Turning a declared `reads` glob into concrete file names, and files into benign content.
 *
 * The suite cannot know what an extractor reads, only what it declared it may read. So the fixtures
 * are built from the declaration: for each glob, files that glob admits, and for the lures, names
 * that look like declared files but lead somewhere they must not. Every name produced here is
 * checked against the glob it came from with the same matcher the sandbox guard uses
 * (`matchesReads`), so a sample is never a guess about what the glob means.
 */

import { matchesReads } from '@seamline/core';
import type { ExtractorManifest } from '@seamline/ontology';

function admits(glob: string, path: string): boolean {
  return matchesReads({ reads: [glob] } as unknown as ExtractorManifest, path);
}

export interface SampleOptions {
  /** What a `**` followed by `/` stands for: one directory with this name, or no directory at all. */
  readonly dir: string | null;
  /** What `*` stands for. */
  readonly stem: string;
}

/**
 * One concrete path that `glob` admits, or undefined when the glob uses syntax this does not
 * expand (the result is always checked, so an unsupported glob yields nothing rather than a wrong
 * name).
 */
export function sampleForGlob(glob: string, options: SampleOptions): string | undefined {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          if (options.dir !== null) out += `${options.dir}/`;
          i += 3;
          continue;
        }
        out += options.stem;
        i += 2;
        continue;
      }
      out += options.stem;
      i += 1;
      continue;
    }
    if (c === '?') {
      out += 'a';
      i += 1;
      continue;
    }
    if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close > i) {
        out += glob.slice(i + 1, close).split(',')[0] ?? '';
        i = close + 1;
        continue;
      }
    }
    if (c === '[') {
      const close = glob.indexOf(']', i);
      if (close > i + 1) {
        const body = glob.slice(i + 1, close);
        out += body.startsWith('^') || body.startsWith('!') ? 'a' : (body[0] ?? 'a');
        i = close + 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out.length > 0 && admits(glob, out) ? out : undefined;
}

/** The lower-case extension of `path` without the dot, or '' when it has none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

const SLASH_COMMENT = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'java',
  'kt',
  'go',
  'rs',
  'c',
  'h',
  'cc',
  'cpp',
  'cs',
  'swift',
  'scala',
  'dart',
  'php',
  'proto',
  'prisma',
]);
const DASH_COMMENT = new Set(['sql', 'lua', 'hs', 'elm']);
const HASH_COMMENT = new Set([
  'yaml',
  'yml',
  'py',
  'rb',
  'sh',
  'bash',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'tf',
  'r',
  'pl',
]);
const MARKUP_COMMENT = new Set(['xml', 'html', 'htm', 'xsd', 'svg']);

/**
 * `text` as a file of the kind `path`'s extension names, in a way that stays valid for that kind:
 * a comment where the format has comments, a JSON string where it does not. Nothing here is meant
 * to be extracted from; it is meant not to be mistaken for malformed input.
 */
export function contentFor(path: string, text: string): string {
  const ext = extensionOf(path);
  const line = text.replace(/\s+/g, ' ').trim();
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson') {
    return `${JSON.stringify({ conformance: line })}\n`;
  }
  if (SLASH_COMMENT.has(ext)) return `// ${line}\n`;
  if (DASH_COMMENT.has(ext)) return `-- ${line}\n`;
  if (HASH_COMMENT.has(ext)) return `# ${line}\n`;
  if (MARKUP_COMMENT.has(ext)) return `<!-- ${line} -->\n`;
  return `${line}\n`;
}

/** `contentFor`, repeated until it is at least `bytes` long. A JSON file is one long string instead. */
export function paddedContentFor(path: string, bytes: number): string {
  const ext = extensionOf(path);
  const filler = 'conformance stress filler line with no meaning';
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5' || ext === 'geojson') {
    return `${JSON.stringify({ conformance: filler.repeat(Math.ceil(bytes / filler.length)) })}\n`;
  }
  const one = contentFor(path, filler);
  return one.repeat(Math.ceil(bytes / one.length));
}

/**
 * A name inside the repository that no declared glob admits, or undefined when every candidate is
 * admitted (a manifest that declares `**`).
 */
export function undeclaredName(reads: ReadonlyArray<string>): string | undefined {
  const manifest = { reads } as unknown as ExtractorManifest;
  for (const candidate of [
    'undeclared.conformance-canary',
    'undeclared/conformance-canary.data',
    'undeclared',
    'conformance-canary',
  ]) {
    if (!matchesReads(manifest, `conformance-lures/${candidate}`))
      return `conformance-lures/${candidate}`;
  }
  return undefined;
}
