import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESET_SCOPE, RESET_SCOPE_LABEL, RESET_ALL_LABEL, ResetScopeSchema, ResetScopesSchema } from './reset.ts';

test('reset scopes have one exact category source and all stays a selector', () => {
  assert.deepEqual(RESET_SCOPE, ['history', 'knowledge', 'packs', 'config']);
  assert.deepEqual(RESET_SCOPE, Object.keys(RESET_SCOPE_LABEL));
  assert.deepEqual(Object.values(RESET_SCOPE_LABEL), ['运行历史', '知识', '包', '配置']);
  assert.equal(RESET_ALL_LABEL, '全部初始化');
  for (const scope of RESET_SCOPE) assert.equal(ResetScopeSchema.parse(scope), scope);
  for (const scope of ['all', 'History', ' config', 'unknown']) assert.equal(ResetScopeSchema.safeParse(scope).success, false);
  assert.equal(ResetScopesSchema.parse('all'), 'all');
  assert.deepEqual(ResetScopesSchema.parse(['history', 'config']), ['history', 'config']);
  for (const scopes of [[], ['all'], ['all', 'history'], ['history', 'history'], ['unknown']]) assert.equal(ResetScopesSchema.safeParse(scopes).success, false);
});
