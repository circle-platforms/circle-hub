// Inverse alternatives (the inverse-alternatives task): a switch command whose enum alternatives the product declared
// as an inverse pair cleans up with the paired value of the same signature; undeclared pairs still refuse; the no-prefix
// rules keep working beside them. Synthetic commands and values only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommandsKnown } from './checks.ts';
import { fixture, cleanup } from '../testing/inverse-alternatives.ts';

const policyWithoutPairs = { schema: 'command-policy@1' as const, read_only: ['/commands/show'], inverse_rules: [{ source_prefix: '/commands/demo/pool', inverse_prefix: '/commands/no/demo/pool', leading_parameters: 1 }] };

test('a declared enum pair inverts within the same signature: demo feature on cleans up with off', () => {
  const value = fixture(['demo feature on', cleanup('demo feature off')]);
  const result = checkCommandsKnown(value);
  assert.ok(result.every(row => row.verdict === 'support'), JSON.stringify(result));
  const reversed = fixture(['demo feature off', cleanup('demo feature on')]);
  assert.ok(checkCommandsKnown(reversed).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(reversed)));
});

test('a cleanup that repeats the same value instead of the paired alternative is refused', () => {
  const value = fixture(['demo feature on', cleanup('demo feature on')]);
  const result = checkCommandsKnown(value);
  assert.ok(result.some(row => row.verdict === 'refute' && row.statement.includes('缺同设备、逆序的清理操作')), JSON.stringify(result));
});

test('an enum pair the product did not declare still refuses: demo mode auto has no declared inverse', () => {
  const value = fixture(['demo mode auto', cleanup('demo mode manual')], policyWithoutPairs);
  const result = checkCommandsKnown(value);
  assert.ok(result.some(row => row.verdict !== 'support'), JSON.stringify(result));
});

test('declared sibling leaf paths invert by last segment: demo switch on cleans up with demo switch off', () => {
  const value = fixture(['demo switch on', cleanup('demo switch off')]);
  assert.ok(checkCommandsKnown(value).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(value)));
  const reversed = fixture(['demo relay disable', cleanup('demo relay enable')]);
  assert.ok(checkCommandsKnown(reversed).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(reversed)));
});

test('sibling leaves whose pair is not declared still refuse: demo lamp bright has no declared inverse', () => {
  const value = fixture(['demo lamp bright', cleanup('demo lamp dim')], policyWithoutPairs);
  assert.ok(checkCommandsKnown(value).some(row => row.verdict !== 'support'), JSON.stringify(checkCommandsKnown(value)));
});

test('a declared pair without a sibling leaf on the locked tree still refuses', () => {
  // /commands/demo/feature is the same-signature form; nothing declares /commands/demo/feature-on leaves.
  const value = fixture(['demo feature on', cleanup('demo feature off')]);
  assert.ok(checkCommandsKnown(value).every(row => row.verdict === 'support'), JSON.stringify(checkCommandsKnown(value)));
});

test('the no-prefix rules keep working beside the alternatives: demo pool add cleans up with no demo pool add', () => {
  const value = fixture(['demo pool add one 10', 'demo feature on', cleanup('demo feature off'), cleanup('no demo pool add one')]);
  const result = checkCommandsKnown(value);
  assert.ok(result.every(row => row.verdict === 'support'), JSON.stringify(result));
});
