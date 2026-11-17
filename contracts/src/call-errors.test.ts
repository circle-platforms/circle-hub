import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CALL_ERROR_CATEGORY, AXES, labelOf } from '../generated/vocabulary.ts';
import { CALL_ERROR_CATEGORY_BY_CODE, CORE_VIOLATION_CODES, PROTOCOL_CODES, callErrorCategory, formatCallError } from '../generated/protocol.ts';

test('model 82 registers exactly five D05 categories and every protocol row supplies its mapping', () => {
  const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
  assert.ok(model.version >= 82);
  assert.ok(model.elements.find((element: { id: string }) => element.id === 'D05').changes82.some((source: string) => source.includes('13:48')));
  assert.equal(AXES.call_error_category.owner, 'D05');
  assert.deepEqual(CALL_ERROR_CATEGORY, ['invalid_parameters', 'permission_denied', 'not_found', 'occupied', 'temporarily_unavailable']);
  assert.deepEqual(CALL_ERROR_CATEGORY.map(value => labelOf('call_error_category', value)), ['参数无效', '无权限', '不存在', '已被占用', '暂时不可用']);
  assert.deepEqual(Object.keys(CALL_ERROR_CATEGORY_BY_CODE), Object.keys(PROTOCOL_CODES));
  for (const row of model.formatProposals.protocolCodes) {
    assert.ok(Object.hasOwn(row, 'callErrorCategory'));
    assert.equal(callErrorCategory(row.code), row.callErrorCategory);
  }
});

test('Boss prerequisite and lease corrections override earlier classifications without guessing ambiguous codes', () => {
  for (const code of ['EFFECT_CONTENT_UNVERIFIED', 'EFFECT_RELEASE_UNMET', 'LEASE_EXPIRED', 'FENCING_STALE', 'TEAM_PARSER_REQUIRED', 'SYNC_MODE_LOCAL', 'RUN_SUPERSEDED']) assert.equal(callErrorCategory(code), 'not_found', code);
  assert.equal(callErrorCategory('RUN_SUPERSEDED', true), 'not_found', 'a known protocol category is not overridden by a package flag');
  assert.equal(callErrorCategory('IDEMPOTENCY_MISMATCH'), 'invalid_parameters');
  assert.equal(callErrorCategory('SOURCE_PENDING_REVIEW'), 'temporarily_unavailable');
  assert.equal(callErrorCategory('MEMORY_CURSOR_STALE'), 'invalid_parameters');
  assert.equal(callErrorCategory('SYNC_PURGE_CONFIRMATION_REQUIRED'), 'invalid_parameters');
  assert.equal(callErrorCategory('SHARE_DUPLICATE'), 'occupied');
  for (const code of ['SOURCE_UNAVAILABLE', 'RUN_ABANDONED', 'LEASE_UNAVAILABLE', 'EFFECT_UNKNOWN_DISPOSED']) {
    assert.equal(callErrorCategory(code), null);
    assert.equal(callErrorCategory(code, true), null, 'a known unclassified code cannot become a package refusal');
  }
});

test('unknown and review codes stay unknown unless the caller explicitly identifies a package invocation refusal', () => {
  assert.equal(callErrorCategory('UNREGISTERED_CODE'), null);
  assert.equal(callErrorCategory('synthetic-pack.invalid-input'), null);
  assert.equal(callErrorCategory('synthetic-pack.invalid-input', true), 'invalid_parameters');
  for (const code of [...Object.keys(CORE_VIOLATION_CODES), 'core.unregistered']) assert.equal(callErrorCategory(code, true), null);
  for (const code of ['constructor', '__proto__', 'toString']) assert.equal(callErrorCategory(code), null);
});

test('one formatter uses generated labels and caller facts rather than interpreting message content', () => {
  assert.equal(formatCallError('not_found', '这次运行还没有判断为正确的脚本合并结果', '请先完成脚本合并'), '不存在：这次运行还没有判断为正确的脚本合并结果。请先完成脚本合并。');
  assert.equal(formatCallError('occupied', '测试环境正由其他成员持有。', '请等待占用结束后重交。'), '已被占用：测试环境正由其他成员持有。请等待占用结束后重交。');
  assert.equal(formatCallError('permission_denied', ' 事实句含“已被占用”，但本次结构判定为无权限。 ', ' 请管理员核对分配。 '), '无权限：事实句含“已被占用”，但本次结构判定为无权限。请管理员核对分配。');
  assert.equal(callErrorCategory('LEASE_UNAVAILABLE'), null);
  assert.equal(formatCallError('not_found', '当前账户没有测试环境预订', '请先预订整个测试环境'), '不存在：当前账户没有测试环境预订。请先预订整个测试环境。');
});
