import assert from 'node:assert/strict';
import test from 'node:test';

import { supportedSupabaseConfig } from './migration-order.ts';

const CONFIG = 'project_id = "example"\n[db.migrations]\nenabled = true\nschema_paths = []\n';

test('literal migration configuration admits only the declared supported order', () => {
  assert.equal(supportedSupabaseConfig(CONFIG), true);
  assert.equal(supportedSupabaseConfig(CONFIG.replace('true', 'false')), false);
  assert.equal(supportedSupabaseConfig(CONFIG.replace('[]', '["./schema.sql"]')), false);
  assert.equal(supportedSupabaseConfig(CONFIG.replace('true', 'read_setting()')), false);
  assert.equal(supportedSupabaseConfig(CONFIG.replace('project_id = "example"\n', '')), false);
});

test('comments and quoted samples cannot invent configuration authority', () => {
  assert.equal(supportedSupabaseConfig('# ' + CONFIG.replaceAll('\n', '\n# ')), false);
  assert.equal(supportedSupabaseConfig('sample = ' + JSON.stringify(CONFIG) + '\n'), false);
  assert.equal(supportedSupabaseConfig('sample = """\n' + CONFIG + '"""\n'), false);
  assert.equal(supportedSupabaseConfig('project_id = "example"\n["db.migrations"]\nenabled = true\nschema_paths = []\n'), false);
  assert.equal(supportedSupabaseConfig('project_id = "example"\n[db]\n"migrations.enabled" = true\n"migrations.schema_paths" = []\n'), false);
});

test('malformed, duplicate or unsupported TOML never certifies order', () => {
  for (const suffix of [
    'trailing',
    'enabled = true\n',
    '[db.migrations]\n',
    'x = { dynamic = true }\n',
    'x = "bad\\/escape"\n',
    'x = "bad\u007fcontrol"\n',
    'x = "\\uD800"\n',
    'x = 01\n',
    'x = 9007199254740993\n',
    'x.y = true\n',
    '[[array_table]]\nx = true\n',
  ]) assert.equal(supportedSupabaseConfig(CONFIG + suffix), false, suffix);
  assert.equal(supportedSupabaseConfig('\r' + CONFIG), false);
  assert.equal(supportedSupabaseConfig('\ufeff' + CONFIG), false);
  assert.equal(supportedSupabaseConfig(CONFIG + '#'.repeat(64 * 1024)), false);
});

test('irrelevant literal settings and arrays cannot change the migration policy', () => {
  const prefix = 'project_id = "example"\n[auth]\nenabled = true\nredirects = [\n "https://example.invalid", # comment\n \'local\',\n]\n';
  assert.equal(supportedSupabaseConfig(prefix + '[db.migrations]\nenabled = true\nschema_paths = []\n'), true);
  assert.equal(supportedSupabaseConfig(CONFIG.replaceAll('\n', '\r\n')), true);
});
