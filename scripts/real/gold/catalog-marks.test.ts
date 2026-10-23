// Synthetic XML and source lines only; this oracle imports no executable Hub or pack code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readCatalog, judgeCommand, quoteFromCase } from './catalog-marks.ts';

const tree = `<catalog version="10.8.1"><menu name="widget">
 <item name="port"><arguments><arg name="port" type="U16" limit="[1 - 20]"/></arguments></item>
 <item name="label"><arguments><arg name="name" type="STRING" length="[1 - 4]"/></arguments></item>
 <item name="address"><arguments><arg name="address" type="DOTTEDIP"/></arguments></item>
 <item name="mode"><arguments><arg name="mode" type="STRING" limit="{on|off}"/></arguments></item>
 <item name="optional"><arguments><arg name="first" type="U16" optional="yes"/><arg name="last" type="DOTTEDIP"/></arguments></item>
 <item name="overload"><arguments><arg name="first" type="U16"/></arguments><arguments><arg name="first" type="DOTTEDIP"/><arg name="last" type="STRING"/></arguments></item>
</menu></catalog>`;

test('independently identifies parameter ranges, types and arity in resolved command scope', () => {
  const catalog = readCatalog(tree);
  assert.equal(judgeCommand(catalog, 'widget port 21').code, 'core.catalog.param_out_of_range');
  assert.equal(judgeCommand(catalog, 'widget port bad').code, 'core.catalog.param_type_mismatch');
  assert.equal(judgeCommand(catalog, 'widget port').code, 'core.catalog.arity_mismatch');
  assert.equal(judgeCommand(catalog, 'widget port 3').code, null);
  assert.equal(judgeCommand(catalog, 'widget port 65536').code, 'core.catalog.param_out_of_range');
  assert.equal(judgeCommand(catalog, 'widget label abcde').code, 'core.catalog.param_out_of_range');
  assert.equal(judgeCommand(catalog, 'widget mode unknown').code, 'core.catalog.param_type_mismatch');
  assert.equal(judgeCommand(catalog, 'widget address 192.0.2.1').code, null);
});
test('unknown heads and prose are out of scope, never not_member gold positives', () => {
  for (const text of ['unlisted command 21', '普通操作说明', '']) {
    const result = judgeCommand(readCatalog(tree), text);
    assert.equal(result.code, null); assert.equal(result.in_scope, false);
  }
});
test('a signature or an optional-argument assignment that matches proves the line valid', () => {
  const catalog = readCatalog(tree);
  assert.equal(judgeCommand(catalog, 'widget optional 192.0.2.1').code, null);
  assert.equal(judgeCommand(catalog, 'widget optional 3 192.0.2.1').code, null);
  assert.equal(judgeCommand(catalog, 'widget overload 192.0.2.1 name').code, null);
});
test('NFKC, case folding and whitespace folding apply without cutting or inventing arguments', () => {
  const catalog = readCatalog(tree);
  assert.equal(judgeCommand(catalog, 'ＷＩＤＧＥＴ　ＰＯＲＴ ２１').code, 'core.catalog.param_out_of_range');
  assert.ok(quoteFromCase('ＷＩＤＧＥＴ　ＰＯＲＴ ２１', ['执行 widget   port 21。']));
  assert.ok(!quoteFromCase('widget port 2', ['widget port 21']));
  assert.ok(!quoteFromCase('widget port', ['widget port 21']));
  assert.ok(!quoteFromCase('widget port 21 extra', ['widget port 21']));
});
test('unknown parameter types and unparsed constraints request positioned evidence', () => {
  for (const attribute of ['type="SYNTHETIC_UNKNOWN"', 'type="U16" limit="unparsed-synthetic-rule"']) {
    const result = judgeCommand(readCatalog(`<catalog><item name="sample"><arguments><arg name="a" ${attribute}/></arguments></item></catalog>`), 'sample 1');
    assert.equal(result.code, null); assert.ok(result.requests.length);
    assert.ok(result.requests[0].line! > 0 && result.requests[0].column! > 0);
    assert.ok(result.requests[0].pointer.includes('arg'));
    assert.ok(result.requests[0].fact && result.requests[0].next_action);
  }
});
test('ambiguous error-code choices across matching arities are design gaps rather than guessed codes', () => {
  const xml = '<catalog><item name="sample"><arguments><arg type="U16" limit="[1 - 5]"/></arguments><arguments><arg type="DOTTEDIP"/></arguments></item></catalog>';
  const result = judgeCommand(readCatalog(xml), 'sample 9');
  assert.equal(result.code, null); assert.ok(result.requests.some(r => r.fact.includes('选择规则')));
});
test('the independent reader refuses malformed XML and its source imports no Hub or pack code', () => {
  assert.throws(() => readCatalog('<catalog>'));
  const source = readFileSync(new URL('./catalog-marks.ts', import.meta.url), 'utf8');
  assert.ok(!/from\s+['"][^'"]*(?:hub\/|packs\/)/.test(source));
});
