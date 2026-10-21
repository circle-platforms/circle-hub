import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { after, test } from 'node:test';
import type { Layout } from './layout.ts';
import type { PostgresControl } from './postgres.ts';
import { removeDir, tempDir } from './test-support.ts';
import { verifyPostgres } from './verify.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

test('a failure after the server started still stops it before its directory is removed', async () => {
  const parent = await tempDir();
  roots.push(parent);
  const order: string[] = [];
  const control = (layout: Layout) =>
    ({
      layout,
      initialise: async () => (order.push('initialise'), true),
      start: async () => (order.push('start'), true),
      ensureDatabase: async () => {
        order.push('ensureDatabase');
        throw new Error('synthetic failure after start');
      },
      stop: async () => {
        order.push('stop');
        assert.ok((await readdir(parent)).length === 1, 'the data directory still exists while the server stops');
        return true;
      },
    }) as unknown as PostgresControl;
  const result = await verifyPostgres({ parent, control });
  assert.deepEqual(result, { ok: false, message: 'synthetic failure after start' });
  assert.deepEqual(order, ['initialise', 'start', 'ensureDatabase', 'stop']);
  assert.deepEqual(await readdir(parent), [], 'and then the directory is removed');
});

test('the CI check boots a socket-only cluster from the pinned binaries and cleans up', async () => {
  const parent = await tempDir();
  roots.push(parent);
  const result = await verifyPostgres({ parent });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.listen_addresses, '');
  assert.equal(result.role, 'circle_hub');
  assert.deepEqual(await readdir(parent), []);
});
