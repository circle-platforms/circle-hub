import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveResetDatabase, createResetDatabase, type ResetDatabaseControl } from './database.ts';
import { PlatformError } from '../errors.ts';

function fixture(failAt?: number) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let connections = 0, closes = 0;
  const control: ResetDatabaseControl = {
    target: { socketDir: '/synthetic/socket', port: 5432, user: 'synthetic_owner', database: 'synthetic_hub' },
    connector: async database => {
      assert.equal(database, 'postgres'); connections++;
      return { query: async (sql, values) => {
        calls.push({ sql, values }); if (calls.length === failAt) throw new Error('SyntheticPrivateDriverDetail938'); return [];
      }, close: async () => { closes++; } };
    },
  };
  return { control, calls, state: () => ({ connections, closes }) };
}

test('archive quotes exact names, blocks connections before termination, then renames without deletion', async () => {
  const f = fixture();
  await archiveResetDatabase(f.control, 'hub"one', 'archive"one');
  assert.deepEqual(f.calls, [
    { sql: 'ALTER DATABASE "hub""one" ALLOW_CONNECTIONS false', values: undefined },
    { sql: 'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', values: ['hub"one'] },
    { sql: 'ALTER DATABASE "hub""one" RENAME TO "archive""one"', values: undefined },
  ]);
  assert.deepEqual(f.state(), { connections: 1, closes: 1 });
});

test('a failed backend stop does not proceed to rename or disclose a driver error', async () => {
  const f = fixture(2);
  await assert.rejects(archiveResetDatabase(f.control, 'synthetic_hub', 'synthetic_archive'), error => {
    assert.ok(error instanceof PlatformError); assert.doesNotMatch(error.message, /SyntheticPrivateDriverDetail938/); return true;
  });
  assert.equal(f.calls.length, 2); assert.equal(f.state().closes, 1);
});

test('empty creation uses template0 and never grants public or application access', async () => {
  const f = fixture(); await createResetDatabase(f.control, 'synthetic_new');
  assert.deepEqual(f.calls.map(call => call.sql), [
    'CREATE DATABASE "synthetic_new" OWNER "synthetic_owner" TEMPLATE "template0"',
    'REVOKE ALL ON DATABASE "synthetic_new" FROM PUBLIC',
  ]);
  assert.equal(f.state().closes, 1);
});

test('a generic clone preserves the template and escapes its identifier', async () => {
  const f = fixture(); await createResetDatabase(f.control, 'synthetic_new', { template: 'archive"one' });
  assert.equal(f.calls[0]!.sql, 'CREATE DATABASE "synthetic_new" OWNER "synthetic_owner" TEMPLATE "archive""one"');
  assert.equal(f.calls.some(call => /ALTER|DROP/.test(call.sql)), false);
});

test('invalid or truncating identifiers and system database archives fail before connecting', async () => {
  const f = fixture();
  for (const name of ['', 'x\0y', 'a'.repeat(64), '界'.repeat(22), 'postgres', 'template0', 'template1']) {
    await assert.rejects(archiveResetDatabase(f.control, name, 'synthetic_archive'));
    await assert.rejects(createResetDatabase(f.control, name));
  }
  await assert.rejects(archiveResetDatabase(f.control, 'same_name', 'same_name'));
  await assert.rejects(createResetDatabase(f.control, 'same_name', { template: 'same_name' }));
  assert.deepEqual(f.state(), { connections: 0, closes: 0 });
});

test('a post-create restriction failure is reported for controller recovery, never treated as success', async () => {
  const f = fixture(2);
  await assert.rejects(createResetDatabase(f.control, 'synthetic_new'), error => {
    assert.ok(error instanceof PlatformError); assert.doesNotMatch(error.message, /SyntheticPrivateDriverDetail938/); return true;
  });
  assert.equal(f.calls.length, 2); assert.equal(f.state().closes, 1);
});
