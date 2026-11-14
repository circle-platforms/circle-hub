import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as api from '../api.ts';
import { AXES, MODEL_VERSION, RESET_SCOPE as generatedScopes, RESET_SCOPE_LABEL as generatedLabels, ResetScopeSchema as generatedSchema, labelOf } from '../api.ts';
import { RESET_SCOPE, RESET_SCOPE_LABEL, RESET_DATA_SCOPE, RESET_ALL_LABEL, ResetScopeSchema, ResetDataScopeSchema, ResetScopesSchema } from './reset.ts';

test('the approved reset axis has one generated five-value public binding', () => {
  assert.deepEqual(RESET_SCOPE, ['history', 'knowledge', 'packs', 'config', 'all']);
  assert.equal(RESET_SCOPE, generatedScopes);
  assert.equal(RESET_SCOPE_LABEL, generatedLabels);
  assert.equal(ResetScopeSchema, generatedSchema);
  assert.equal(api.ResetScopeSchema, ResetScopeSchema);
  assert.equal(AXES.reset_scope.owner, 'D04');
  assert.deepEqual(Object.values(RESET_SCOPE_LABEL), ['运行历史', '知识', '包', '配置', '全部']);
  for (const scope of RESET_SCOPE) assert.equal(ResetScopeSchema.parse(scope), scope);
  assert.equal(RESET_ALL_LABEL, labelOf('reset_scope', 'all'));
  for (const scope of ['History', ' config', 'unknown']) assert.equal(ResetScopeSchema.safeParse(scope).success, false);
});

test('four real data scopes derive from the axis without counting all', () => {
  assert.deepEqual(RESET_DATA_SCOPE, generatedScopes.filter(scope => scope !== 'all'));
  assert.equal(RESET_DATA_SCOPE.length, 4);
  for (const scope of RESET_DATA_SCOPE) assert.equal(ResetDataScopeSchema.parse(scope), scope);
  assert.equal(ResetDataScopeSchema.safeParse('all').success, false);
  const counts = RESET_DATA_SCOPE.map(scope => ({ scope, retained: 0, cleared: 0 }));
  assert.equal(counts.length, 4);
  assert.ok(counts.every(row => row.scope !== ('all' as string)));
});

test('all is selectable alone and cannot widen or enter an explicit scope list', () => {
  assert.equal(ResetScopesSchema.parse('all'), 'all');
  assert.deepEqual(ResetScopesSchema.parse(['history', 'config']), ['history', 'config']);
  assert.deepEqual(ResetScopesSchema.parse(RESET_DATA_SCOPE), RESET_DATA_SCOPE);
  for (const scopes of [[], ['all'], ['all', 'history'], ['history', 'all'], ['history', 'history'], ['unknown']]) assert.equal(ResetScopesSchema.safeParse(scopes).success, false);
});

test('reset axis registration at model revision 79 records the owner and Boss approval sources', () => {
  const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
  assert.equal(MODEL_VERSION, model.version);
  const owner = model.elements.find((element: { id: string }) => element.id === 'D04');
  const changes: string[] = owner.changes79;
  assert.ok(Array.isArray(changes), 'D04 registered reset_scope at revision 79; unrelated later model revisions need no duplicate change entry');
  assert.ok(changes.some(text => text.includes('17:15') && text.includes('18:50')));
});
