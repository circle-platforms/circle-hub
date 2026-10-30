// The product command policy declares the list commands' cleanup by their two leading identity parameters (1.7.38).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import PRODUCT from './product.json' with { type: 'json' };

const rules = PRODUCT.command_policy.inverse_rules as Array<{ source_prefix: string; inverse_prefix: string; leading_parameters?: number }>;

test('addrlists and portlists have one inverse rule each, with the list name and the start value as leading parameters', () => {
  for (const list of ['addrlists', 'portlists']) {
    const declared = rules.filter((rule) => rule.source_prefix === `/commands/slb/virtual/${list}`);
    assert.equal(declared.length, 1, list);
    assert.deepEqual(declared[0], { source_prefix: `/commands/slb/virtual/${list}`, inverse_prefix: `/commands/no/slb/virtual/${list}`, leading_parameters: 2 });
  }
});

test('the generic rules stay, and every other path keeps the inverse identity the locked inverse signature determines', () => {
  assert.ok(rules.some((rule) => rule.source_prefix === '/commands' && rule.inverse_prefix === '/commands/no' && rule.leading_parameters === undefined));
  assert.ok(rules.some((rule) => rule.source_prefix === '/commands/no' && rule.inverse_prefix === '/commands' && rule.leading_parameters === undefined));
  assert.equal(rules.filter((rule) => rule.leading_parameters !== undefined).length, 4);
});

// 1.7.40 (decision 104, aligned with InfoTest's SSL_CERT_LOAD and its paired teardown): an SSL virtual host is torn down by
// `clear ssl host <host>`, which the device confirms with YES at an "abort:" prompt; a started host is stopped first.
test('an SSL virtual host clears by its name after a confirmation, and a started SSL host stops by its name', () => {
  assert.deepEqual(rules.filter((rule) => rule.source_prefix.startsWith('/commands/ssl/')), [
    { source_prefix: '/commands/ssl/host/virtual', inverse_prefix: '/commands/clear/ssl/host', leading_parameters: 1 },
    { source_prefix: '/commands/ssl/start', inverse_prefix: '/commands/ssl/stop', leading_parameters: 1 },
  ]);
  assert.deepEqual(PRODUCT.command_policy.confirmations, [{ command_prefix: '/commands/clear/ssl/host', prompt: 'abort:', answer: 'YES' }]);
});
