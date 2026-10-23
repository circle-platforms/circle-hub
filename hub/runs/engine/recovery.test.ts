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

test('timeout carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'timeout' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.owner });
  assert.ok(result.missing?.includes('检查在上限内'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('missing_input carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'missing_input' }, [], context);
  assert.equal(result.exit?.request_kind, 'clarification');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('运行所需的已'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('declared_skip carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'declared_skip' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('被跳过条目的'));
  assert.ok(LayerResult.safeParse(result).success);
});

test('not_covered carries its own missing fact and named exit', () => {
  const result = bindRecovery({ layer: 'static', terminal: 'unchecked', reason: 'not_covered' }, [], context);
  assert.equal(result.exit?.request_kind, 'repair');
  assert.deepEqual(result.exit?.audience, { user: context.runner });
  assert.ok(result.missing?.includes('未覆盖条目的'));
  assert.ok(LayerResult.safeParse(result).success);
});
