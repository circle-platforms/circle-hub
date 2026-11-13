import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESET_SCOPE, ResetScopeSchema, ResetScopesSchema } from './reset.ts';

test('reset scopes have one exact category source and all stays a selector', () => {
  assert.deepEqual(RESET_SCOPE, ['history', 'knowledge', 'packs', 'config']);
  for (const scope of RESET_SCOPE) assert.equal(ResetScopeSchema.parse(scope), scope);
  for (const scope of ['all', 'History', ' config', 'unknown']) assert.equal(ResetScopeSchema.safeParse(scope).success, false);
  assert.equal(ResetScopesSchema.parse('all'), 'all');
  assert.deepEqual(ResetScopesSchema.parse(['history', 'config']), ['history', 'config']);
  for (const scopes of [[], ['all'], ['all', 'history'], ['history', 'history'], ['unknown']]) assert.equal(ResetScopesSchema.safeParse(scopes).success, false);
});
