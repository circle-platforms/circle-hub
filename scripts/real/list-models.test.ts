import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idsOf, listRequest } from './list-models.ts';

test('the Anthropic list request goes to <base>/v1/models with the key in x-api-key and the version header', () => {
  const a = listRequest('anthropic', 'https://gateway.example/api/anthropic/', 'k');
  assert.equal(a.url, 'https://gateway.example/api/anthropic/v1/models');
  assert.deepEqual(a.headers, { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  assert.equal(listRequest('anthropic', 'https://gateway.example/v1', 'k').url, 'https://gateway.example/v1/models', 'a trailing /v1 is not doubled');
});

test('the OpenAI list request uses a bearer token on <base>/models', () => {
  const o = listRequest('openai', 'https://gateway.example/v1/', 'k');
  assert.equal(o.url, 'https://gateway.example/v1/models');
  assert.deepEqual(o.headers, { authorization: 'Bearer k' });
});

test('ids come out of both answer shapes, sorted, and nothing else is trusted', () => {
  assert.deepEqual(idsOf({ data: [{ id: 'b' }, { id: 'a' }, { name: 'x' }, null] }), ['a', 'b']);
  assert.deepEqual(idsOf([{ id: 'z' }, { id: 'y' }]), ['y', 'z']);
  assert.deepEqual(idsOf({ code: 1000, msg: 'x' }), []);
  assert.deepEqual(idsOf('text'), []);
});
