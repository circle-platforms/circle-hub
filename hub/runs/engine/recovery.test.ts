import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LayerResult } from '../../../contracts/src/validation.ts';
import { unknown } from '../../rules/outcome.ts';
import { bindRecovery } from './recovery.ts';

const context = { now: new Date('2026-01-01T00:00:00Z'), runner: 'usr_' + '1'.repeat(26), owner: 'usr_' + '2'.repeat(26), admin: 'usr_' + '3'.repeat(26) };
test('missing check has an explicit fact and a repair exit to its author', () => {
  const layer = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'no_check' }, [], context);
  assert.ok(layer.missing?.includes('检查'));
  assert.deepEqual(layer.exit, { action: 'request', request_kind: 'repair', audience: { user: context.owner }, due: '2026-01-04T00:00:00.000Z' });
  assert.ok(LayerResult.safeParse(layer).success);
});
test('check errors are valid outcomes before reaching the engine', () => {
  assert.ok(unknown({ tier: 'advisory', grounds: [] }, 'check_error', '检查声明没有可用的函数').missing);
});
