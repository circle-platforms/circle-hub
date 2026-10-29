import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import ExcelJS from 'exceljs';
import {createSkillParserRegistry, PARSE_SANDBOX_LIMITS} from './skills.ts';
import {parseDocument, QUOTATION_UNITS, type Fragment, type ParsedDocument, type QuotationSource} from './parser.ts';
import {candidatesFrom} from './quote.ts';
import {callPackFunction} from '../rules/api.ts';
import {xmlParser} from '../../packs/skill/xml-format/api.ts';
import {QUOTATION_UNITS as XML_QUOTATION} from '../../packs/skill/xml-format/functions/format.ts';
import {htmlParser} from '../../packs/skill/html-format/api.ts';
import {QUOTATION_UNITS as HTML_QUOTATION} from '../../packs/skill/html-format/functions/format.ts';
import {xlsxParser} from '../../packs/skill/workbook-format/api.ts';
import {kityminderParser} from '../../packs/skill/mindmap-format/api.ts';
import {QUOTATION_UNITS as MIND_QUOTATION} from '../../packs/skill/mindmap-format/functions/format.ts';

// The actual pack functions run via callPackFunction. A fake package registry
// supplies only synthetic declarations so this tests parser transport independent
// of package signatures and database state. OS isolation is optional on CI hosts;
// callPackFunction still uses sandbox-exec when the host provides it.
async function installed(format: 'xml' | 'html' | 'workbook' | 'mindmap') {
  const directory = fileURLToPath(new URL(`../../packs/skill/${format}-format/`, import.meta.url));
  const skill = JSON.parse(await readFile(new URL(`../../packs/skill/${format}-format/skill.json`, import.meta.url), 'utf8'));
  const opened = {info: {id: `${format}-format`, version: '1.0.0', digest: 'a'.repeat(64), manifest: {}}, handle: {directory}, declarations: {kind: 'skill', skill}};
  const registry = {installedSkills: async () => [opened], open: async () => opened};
  const options = {registry, records: {}, sandbox: {requireOsIsolation: false}} as unknown as Parameters<typeof createSkillParserRegistry>[0];
  const parsers = (await createSkillParserRegistry(options).freeze!([])).parsers;
  const parser = parsers.get(skill.parsers[0].parser);
  assert.ok(parser);
  return parser;
}

async function equalLookup(document: ParsedDocument, native: {locate(selector: string): Fragment | null}, selectors: string[]) {
  for (const selector of selectors) {
    // Deep comparison covers selector, text, byteRange, data, and null.
    assert.deepEqual(await document.locate(selector), native.locate(selector), selector);
  }
}

async function equalSandboxLocate(format: 'xml' | 'html' | 'workbook', bytes: Buffer, native: {locate(selector: string): Fragment | null}, selectors: string[]) {
  const directory = fileURLToPath(new URL(`../../packs/skill/${format}-format/`, import.meta.url));
  const result = await callPackFunction({packDir: directory, module: 'functions/parse.ts', export: 'locate'},
    {bytes: bytes.toString('base64'), options: {}, selectors},
    PARSE_SANDBOX_LIMITS, {requireOsIsolation: false});
  const output = result.output as {fragments: Array<Fragment & {lookup: string}>};
  for (const selector of selectors) {
    const row = output.fragments.find((value) => value.lookup === selector);
    if (!row) { assert.equal(native.locate(selector), null, selector); continue; }
    const {lookup: _lookup, ...fragment} = row;
    assert.deepEqual(fragment, native.locate(selector), selector);
  }
}

function equalLists(document: ParsedDocument, native: {listSelectors(prefix?: string, options?: {properties?: boolean}): string[]}) {
  assert.deepEqual(document.listSelectors(''), native.listSelectors(''));
  assert.deepEqual(document.listSelectors('', {properties: true}), native.listSelectors('', {properties: true}));
}

test('XML eager transport preserves every native lookup including nested ordinal aliases', async () => {
  const bytes = Buffer.from('<r z="v"><a><b x="one">First</b><b x="two">Second</b></a></r>');
  const native = xmlParser.parse(bytes);
  const parsed = await parseDocument(await installed('xml'), bytes);
  const selectors = ['x/r/a/b[1]', 'x/r/a[1]/b[1]', 'x/r[1]/a[1]/b[2]/@x', 'x/r/a[1]/b[3]', 'i/0/0', 'i/00', ...native.listSelectors('', {properties: true})];
  await equalLookup(parsed, native, selectors);
  await equalSandboxLocate('xml', bytes, native, selectors);
  equalLists(parsed, native);
  const actual = parsed as ParsedDocument & QuotationSource;
  const nativeQuotation = native as typeof native & {[XML_QUOTATION]: (options: {properties: boolean}) => unknown};
  for (const properties of [false, true]) assert.deepEqual(actual[QUOTATION_UNITS]({properties}), nativeQuotation[XML_QUOTATION]({properties}));
});

test('XLSX transport rejects aliases absent from the native selector grammar', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Synthetic').addRow(['value']);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const native = xlsxParser.parse(bytes);
  const parsed = await parseDocument(await installed('workbook'), bytes);
  const selectors = ['c/Synthetic/A1', 'i/00/0/0', 'i/0/0/0', 'i/n/00', ...native.listSelectors('')];
  await equalLookup(parsed, native, selectors);
  await equalSandboxLocate('workbook', bytes, native, selectors);
  equalLists(parsed, native);
  for (const properties of [false, true]) {
    const source = 'a'.repeat(64);
    assert.deepEqual(await candidatesFrom(parsed, source, {properties}), await candidatesFrom(native, source, {properties}));
  }
});

test('HTML eager and mind-map quotation units retain native lists and quotations', async () => {
  const htmlBytes = Buffer.from('<html><body><p>first</p><p>second</p></body></html>');
  const html = htmlParser.parse(htmlBytes);
  const htmlWire = await parseDocument(await installed('html'), htmlBytes);
  equalLists(htmlWire, html);
  const htmlSelectors = [...html.listSelectors(''), 'b/0-1', 'b/0-0', 'b/1-0', 'b/0-2'];
  await equalLookup(htmlWire, html, htmlSelectors);
  await equalSandboxLocate('html', htmlBytes, html, htmlSelectors);
  const htmlQuotation = html as typeof html & {[HTML_QUOTATION]: (options: {properties: boolean}) => unknown};
  for (const properties of [false, true]) assert.deepEqual((htmlWire as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({properties}), htmlQuotation[HTML_QUOTATION]({properties}));

  const mindBytes = Buffer.from(JSON.stringify({root: {data: {id: 'root', text: 'Synthetic root'}, children: [{data: {id: 'child', text: 'Synthetic child', note: 'note'}, children: []}]}}));
  const mind = kityminderParser.parse(mindBytes);
  const mindWire = await parseDocument(await installed('mindmap'), mindBytes);
  equalLists(mindWire, mind);
  await equalLookup(mindWire, mind, mind.listSelectors('', {properties: true}));
  const mindQuotation = mind as typeof mind & {[MIND_QUOTATION]: (options: {properties: boolean}) => unknown};
  for (const properties of [false, true]) assert.deepEqual((mindWire as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({properties}), mindQuotation[MIND_QUOTATION]({properties}));
});

test('HTML threshold-triggered lazy transport preserves range boundaries, lists, and quotation units', {timeout: 120_000}, async () => {
  const bytes = Buffer.from(`<html><body>${Array.from({length: 180}, (_, i) => `<p>line ${i} ${'z'.repeat(500)}</p>`).join('')}</body></html>`);
  const native = htmlParser.parse(bytes);
  const parsed = await parseDocument(await installed('html'), bytes);
  assert.equal(typeof parsed.prefetch, 'function', 'the document must really cross the lazy threshold');
  const lookups = ['b/0-0', 'b/2-1', 'b/0-180', 'b/180-180', 'b/0-1', 'b/0-179', 'b/9-20'];
  await parsed.prefetch!(lookups);
  await equalLookup(parsed, native, lookups);
  equalLists(parsed, native);
  const actual = parsed as ParsedDocument & QuotationSource;
  const nativeQuotation = native as typeof native & {[HTML_QUOTATION]: (options: {properties: boolean}) => unknown};
  for (const properties of [false, true]) assert.deepEqual(actual[QUOTATION_UNITS]({properties}), nativeQuotation[HTML_QUOTATION]({properties}));
});
