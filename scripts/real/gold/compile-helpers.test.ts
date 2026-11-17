// Unit tests for active shared helpers exported by compile-check.ts (synthetic inputs only; no Hub or pack imports).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  canonicalJson,
  checkCatalogCommand,
  checkVerbatimQuote,
  commandCatalogDeclaration,
  parseCommandTree,
} from './compile-check.ts';

const commandTreeXml = `<commands><scope><menu name="widget"><menu name="health"><item name="interval"><arguments><arg name="seconds" type="U16" limit="[1 - 120]"/></arguments></item></menu><menu name="session"><item name="persistence"><arguments><arg name="mode" type="STRING" limit="{cookie|source}"/></arguments></item></menu></menu></scope></commands>`;
const commandCatalog = { complete: true, case_sensitive: false };
const checkCompleteCommand = (catalog: Parameters<typeof checkCatalogCommand>[0], line: string) =>
  checkCatalogCommand(catalog, line, commandCatalog);

for (const [line, verdict] of [
  ['widget health interval 60', 'pass'],
  ['widget health interval 121', 'fail'],
  ['widget health interval nope', 'fail'],
  ['widget health interval', 'fail'],
  ['widget health interval 60 extra', 'fail'],
  ['widget unknown 60', 'fail'],
  ['widget session persistence cookie', 'pass'],
  ['widget session persistence bogus', 'fail'],
] as const) {
  test(`catalog ${line}`, () => assert.equal(checkCompleteCommand(parseCommandTree(commandTreeXml), line).verdict, verdict));
}

test('all overloads and duplicate command definitions remain independent', () => {
  const catalog = parseCommandTree(
    `<commands><item name="select"><arguments><arg type="U16" limit="[1 - 3]"/></arguments><arguments><arg type="STRING" limit="{a|b}"/></arguments></item><item name="select"><arguments><arg type="U16" limit="[20 - 30]"/></arguments></item></commands>`,
  );
  for (const v of ['2', 'a', '25']) assert.equal(checkCompleteCommand(catalog, `select ${v}`).verdict, 'pass');
  assert.equal(checkCompleteCommand(catalog, 'select 10').verdict, 'fail');
});

test('XML comments, entities, quoted strings, length and optional arguments', () => {
  const c = parseCommandTree(
    `<commands><!-- comment --><item name="set"><arguments><arg name="name" type="STRING" length="8"/><arg name="mode" type="STRING" limit="{a&amp;b|other}" optional="yes"/></arguments></item></commands>`,
  );
  assert.equal(checkCompleteCommand(c, 'set "two word" a&b').verdict, 'pass');
  assert.equal(checkCompleteCommand(c, 'set short').verdict, 'pass');
  assert.equal(checkCompleteCommand(c, 'set toolongtext').verdict, 'fail');
  assert.equal(checkCompleteCommand(c, 'set "unclosed').verdict, 'fail');
});

test('malformed or unsupported XML throws instead of returning an empty catalog', () => {
  for (const xml of ['<commands><item name="x"></commands>', '<commands>', '<!DOCTYPE commands><commands/>', '<commands><item name=x/></commands>']) {
    assert.throws(() => parseCommandTree(xml));
  }
});

test('missing commands fail only for a declared complete catalog', () => {
  const c = parseCommandTree(commandTreeXml);
  assert.equal(checkCatalogCommand(c, 'widget missing', { complete: true, case_sensitive: false }).verdict, 'fail');
  assert.equal(checkCatalogCommand(c, 'widget missing', { complete: false, case_sensitive: false }).verdict, 'unknown');
  assert.equal(checkCatalogCommand(c, 'widget health interval 60', { complete: false, case_sensitive: false }).verdict, 'pass');
  assert.equal(checkCatalogCommand(c, 'widget health interval 121', { complete: false, case_sensitive: false }).verdict, 'fail');
  assert.equal(checkCatalogCommand(c, 'widget missing').verdict, 'unknown');
});

test('command matching follows the declared case sensitivity without merging distinct definitions', () => {
  const c = parseCommandTree(
    '<commands><item name="Select"><arguments><arg type="U16" limit="[1 - 3]"/></arguments></item><item name="select"><arguments><arg type="U16" limit="[20 - 30]"/></arguments></item></commands>',
  );
  const sensitive = { complete: true, case_sensitive: true };
  const insensitive = { ...sensitive, case_sensitive: false };
  assert.equal(checkCatalogCommand(c, 'Select 2', sensitive).verdict, 'pass');
  assert.equal(checkCatalogCommand(c, 'select 2', sensitive).verdict, 'fail');
  assert.equal(checkCatalogCommand(c, 'SELECT 2', sensitive).verdict, 'fail');
  assert.equal(checkCatalogCommand(c, 'SELECT 2', insensitive).verdict, 'pass');
  assert.equal(checkCatalogCommand(c, 'SELECT 25', insensitive).verdict, 'pass');
});

test('quote requires exact whitespace and rejects paraphrases, blank quotes, missing and unreadable sources', () => {
  const sources = new Map([['src:synthetic', '预期：返回  200\nOK。']]);
  assert.equal(checkVerbatimQuote(sources, 'src:synthetic', '返回  200\nOK').verdict, 'pass');
  assert.equal(checkVerbatimQuote(sources, 'src:synthetic', '返回 200 OK').verdict, 'fail');
  assert.equal(checkVerbatimQuote(sources, 'src:synthetic', '返回 500 OK').verdict, 'fail');
  assert.equal(checkVerbatimQuote(sources, 'src:missing', '返回  200\nOK').verdict, 'unknown');
  assert.equal(checkVerbatimQuote(sources, '', '返回  200\nOK').verdict, 'fail');
  for (const quote of ['', ' \t\r\n', '\u00a0\u3000']) assert.equal(checkVerbatimQuote(sources, 'src:synthetic', quote).verdict, 'fail');
});

test('source quotation rejects deleted Chinese hard wraps', () => {
  const sources = new Map([['src:synthetic', '健康检查间隔\r\n设置成功']]);
  assert.equal(checkVerbatimQuote(sources, 'src:synthetic', '健康检查间隔设置成功').verdict, 'fail');
  assert.equal(checkVerbatimQuote(sources, 'src:synthetic', '健康检查间隔\r\n设置成功').verdict, 'pass');
});

test('canonicalJson sorts integer-like keys as strings, uses JavaScript UTF-16 order and retains Chinese strings', () => {
  assert.equal(canonicalJson({ '2': 2, '10': 10, z: 1, a: 2 }), '{"10":10,"2":2,"a":2,"z":1}');
  assert.equal(canonicalJson({ '\uE000': '中文', '𐀀': 1 }), '{"𐀀":1,"\uE000":"中文"}');
  assert.throws(() => canonicalJson(undefined), /非 JSON 值/);
});

test('public product declarations supply commands@1 metadata without importing functions', () => {
  const product: unknown = JSON.parse(readFileSync(new URL('../../../packs/product/famx/product.json', import.meta.url), 'utf8'));
  // The published FAMX command catalog declares case_sensitive: true; verify the public declaration only.
  assert.deepEqual(commandCatalogDeclaration(product), { complete: true, case_sensitive: true });
  for (const v of [{}, { schema: 'product@1', catalogs: [] }, { schema: 'product@1', catalogs: [{ id: 'commands@1', complete: true }] }]) {
    assert.throws(() => commandCatalogDeclaration(v));
  }
});
