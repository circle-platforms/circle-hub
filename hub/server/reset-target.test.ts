import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertResetTarget } from './reset-target.ts';

const target = { socketDir: '/synthetic/socket', port: 5432, database: 'synthetic', user: 'owner' };
const database = { host: target.socketDir, port: target.port, database: target.database, user: 'runtime' };
test('reset accepts a distinct runtime role only for the same managed database', () => {
  assert.doesNotThrow(() => assertResetTarget(database, target));
});
test('reset refuses each mismatched database target before invoking platform operations', () => {
  for (const change of [{ host: '192.0.2.1' }, { port: 5433 }, { database: 'another' }])
    assert.throws(() => assertResetTarget({ ...database, ...change }, target), /未执行重置/);
});
