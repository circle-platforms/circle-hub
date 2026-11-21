// The documents of one engine call stay readable for as long as the verification of a whole run takes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINE_CALL_DOCUMENT_MS } from './service.ts';

test('an engine call keeps its documents readable for the time a client waits for a merge submission', () => {
  // tools/open-merge.ts waits twenty minutes for the Hub's answer; a seventeen-case merge was verified in 400 to 450 seconds.
  assert.ok(ENGINE_CALL_DOCUMENT_MS >= 20 * 60_000);
});
