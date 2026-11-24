import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINE_CALL_DOCUMENT_MS } from './service.ts';

test('an engine call keeps its documents readable for the time a client waits for a merge submission', () => {
  assert.ok(ENGINE_CALL_DOCUMENT_MS >= 20 * 60_000);
});
