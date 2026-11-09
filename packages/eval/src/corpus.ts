/**
 * `eval/corpus.json`: the pinned set of public repositories.
 *
 * A pin is a clone URL plus a full commit id. The loader refuses anything
 * looser (a branch name, an abbreviated sha), because a corpus that drifts
 * between runs turns every precision figure into a moving target.
 */

import { readFile } from 'node:fs/promises';
import { ConfigError } from './errors.ts';
import { PARTITIONS, type CorpusEntry, type Partition } from './types.ts';

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[0-9a-f]{40}$/;

export function parseCorpus(raw: unknown): readonly CorpusEntry[] {
  if (!Array.isArray(raw)) throw new ConfigError('corpus.json must be a JSON array of entries.');
  const problems: string[] = [];
  const entries: CorpusEntry[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const where = `corpus[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      problems.push(`${where}: must be an object.`);
      return;
    }
    const rec = item as Record<string, unknown>;
    const name = rec['name'];
    const url = rec['url'];
    const sha = rec['sha'];
    const license = rec['license'];
    const partition = rec['partition'];
    const stacks = rec['stacks'];
    const why = rec['why'];

    if (typeof name !== 'string' || !NAME.test(name)) {
      problems.push(`${where}: "name" must match ${NAME.source}.`);
      return;
    }
    if (seen.has(name)) problems.push(`${where}: duplicate name "${name}".`);
    seen.add(name);
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      problems.push(`${name}: "url" must be an https:// clone URL.`);
    }
    if (typeof sha !== 'string' || !SHA.test(sha)) {
      problems.push(`${name}: "sha" must be a full 40-character lowercase hex commit id.`);
    }
    if (typeof license !== 'string' || license.trim() === '') {
      problems.push(`${name}: "license" must be a non-empty SPDX identifier.`);
    }
    if (typeof partition !== 'string' || !PARTITIONS.includes(partition as Partition)) {
      problems.push(`${name}: "partition" must be "dev" or "sealed".`);
    }
    if (
      !Array.isArray(stacks) ||
      stacks.length === 0 ||
      stacks.some((s) => typeof s !== 'string' || s.trim() === '')
    ) {
      problems.push(`${name}: "stacks" must be a non-empty array of strings.`);
    }
    if (typeof why !== 'string' || why.trim() === '') {
      problems.push(`${name}: "why" must say why this repository is in the corpus.`);
    }
    if (
      typeof url === 'string' &&
      typeof sha === 'string' &&
      typeof license === 'string' &&
      typeof partition === 'string' &&
      PARTITIONS.includes(partition as Partition) &&
      typeof why === 'string' &&
      Array.isArray(stacks)
    ) {
      entries.push({
        name,
        url,
        sha,
        license,
        partition: partition as Partition,
        stacks: (stacks as string[]).slice(),
        why,
      });
    }
  });

  if (problems.length > 0) {
    throw new ConfigError(`corpus.json is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  if (entries.length === 0) throw new ConfigError('corpus.json lists no repositories.');
  return entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Reads and parses a JSON file, turning every failure into a `ConfigError`. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export async function loadCorpus(file: string): Promise<readonly CorpusEntry[]> {
  return parseCorpus(await readJsonFile(file));
}
