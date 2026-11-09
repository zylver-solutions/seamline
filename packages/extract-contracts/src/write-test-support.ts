// SPDX-License-Identifier: Apache-2.0
/** Original generic request/write fixture. Test support only, never published. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const input = JSON.parse(readFileSync(new URL('./__fixtures__/validated-write.files.json', import.meta.url), 'utf8')) as {
  files: Record<string, string>; route: string;
};
export const WRITE_ROUTE = input.route;
export const WRITE_FILES = input.files;

export function makeWriteFixture(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'write-fixture-'));
  for (const [path, content] of Object.entries({ ...WRITE_FILES, 'src/app/items/route.ts': WRITE_ROUTE, ...extra })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeFixtureIndex(repo: string): string {
  const table = `${repo}:Table:default.public.entries`;
  return JSON.stringify({ version: 1,
    dataSources: [{name: 'default', dialect: 'postgres', defaultSchema: 'public'}],
    tables: [{id: table, name: 'entries', schema: 'public', dataSource: 'default'}],
    prismaDelegates: {entry: {model: 'Entry', table}}, drizzleExports: {},
  });
}
