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
  assert.equal(rules.filter((rule) => rule.leading_parameters !== undefined).length, 2);
});
