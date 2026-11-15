import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestErrorBindings, requestErrorFields } from './request-error-fields.ts';

const request = (digest = 'a'.repeat(64), item?: string) => ({
  digest,
  body: { run: 'run_synthetic', kind: 'repair' as const, audience: 'usr_synthetic', due: '2026-11-15T12:00:00.000Z',
    missing: 'source-owned missing fact', next_action: 'source-owned next step', source: 'b'.repeat(64), code: 'missing_input',
    ...(item === undefined ? {} : { item }) },
});

test('request error columns preserve the returned persisted request fields exactly', () => {
  const actual = request('c'.repeat(64), 'item_actual');
  actual.body.next_action = '用 submit_result 重交完整提交；不重发原效果';
  assert.deepEqual(requestErrorFields(actual), {
    missing: actual.body.missing, request_id: `rec:${actual.digest}`, audience: actual.body.audience,
    due: actual.body.due, next_action: actual.body.next_action, items: ['item_actual'],
  });
});

test('an existing error keeps its original fix and receives only its actual request', () => {
  const error = { code: 'missing_input', message: 'unrelated prose', fix: 'keep the original security instruction' };
  const bindings = createRequestErrorBindings(), actual = request();
  bindings.bind(error, actual); bindings.apply();
  assert.deepEqual(error, { code: 'missing_input', message: 'unrelated prose', fix: 'keep the original security instruction', ...requestErrorFields(actual) });
});

test('a newly pushed error receives the same columns without using display hints', () => {
  const error = { code: 'check_error', message: 'new problem', fix: '请求 rec:misleading，受众 usr_other，期限 other：not the next action' };
  const bindings = createRequestErrorBindings(), actual = request('d'.repeat(64), 'item_actual');
  bindings.bind(error, actual); bindings.apply();
  assert.deepEqual(error, { code: 'check_error', message: 'new problem', fix: '请求 rec:misleading，受众 usr_other，期限 other：not the next action', ...requestErrorFields(actual) });
});

test('a cross-item request without a proven item never acquires an item list from prose', () => {
  const actual = request();
  actual.body.missing = 'item_one and item_two appear in prose, not a scope declaration';
  assert.equal(Object.hasOwn(requestErrorFields(actual), 'items'), false);
});

test('two distinct requests for one original error leave singular columns absent', () => {
  const error = { code: 'repair_exhausted', message: 'one original error', fix: 'retain both request hints' };
  const bindings = createRequestErrorBindings();
  bindings.bind(error, request()); bindings.bind(error, request('c'.repeat(64))); bindings.apply();
  assert.deepEqual(error, { code: 'repair_exhausted', message: 'one original error', fix: 'retain both request hints' });
});

test('repeated binding of the same actual request is not mistaken for two requests', () => {
  const error = { code: 'missing_input', message: 'same original error' };
  const bindings = createRequestErrorBindings(), actual = request();
  bindings.bind(error, actual); bindings.bind(error, actual); bindings.apply();
  assert.deepEqual(error, { code: 'missing_input', message: 'same original error', ...requestErrorFields(actual) });
});

test('an existing different request identity is never overwritten by another producer', () => {
  const error = { code: 'missing_input', message: 'original', request_id: `rec:${'f'.repeat(64)}` };
  const bindings = createRequestErrorBindings(); bindings.bind(error, request()); bindings.apply();
  assert.deepEqual(error, { code: 'missing_input', message: 'original', request_id: `rec:${'f'.repeat(64)}` });
});

test('an error without actual request evidence keeps absent fields absent despite textual hints', () => {
  const error = { code: 'missing_input', message: 'item_hidden', fix: '请求 rec:guess 受众 usr_hidden 期限 tomorrow' };
  const bindings = createRequestErrorBindings(); bindings.apply();
  assert.deepEqual(error, { code: 'missing_input', message: 'item_hidden', fix: '请求 rec:guess 受众 usr_hidden 期限 tomorrow' });
});
