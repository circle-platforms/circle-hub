import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import ExcelJS from 'exceljs';
import {startPostgres, type TemporaryPostgres} from '../testing/postgres.ts';
import {openPackTestbed, type PackTestbed} from '../runs/packs/testing/setup.ts';
import {createSkillParserRegistry} from './skills.ts';
import {parseDocument} from './api.ts';
import {installHtmlFixture, installMindmapFixture, installWorkbookFixture, installXmlFixture} from '../testing/skills.ts';
import {callPackFunction} from '../rules/api.ts';
import type {FunctionAttempt} from '../rules/sandbox/retry.ts';
import {xmlParser} from '../../packs/skill/xml-format/api.ts';
import {selectorSegment} from '../../packs/skill/xml-format/functions/selectors.ts';
import {htmlParser} from '../../packs/skill/html-format/api.ts';
import {kityminderParser} from '../../packs/skill/mindmap-format/api.ts';
import {xlsxParser} from '../../packs/skill/workbook-format/api.ts';
import {QUOTATION_UNITS, type Fragment, type ParsedDocument, type QuotationSource} from './parser.ts';
import {QUOTATION_UNITS as XML_QUOTATION} from '../../packs/skill/xml-format/functions/format.ts';
import {QUOTATION_UNITS as HTML_QUOTATION} from '../../packs/skill/html-format/functions/format.ts';
import {QUOTATION_UNITS as MIND_QUOTATION} from '../../packs/skill/mindmap-format/functions/format.ts';

const OUTPUT_BUDGET = 24 * 1024 * 1024;
const SANDBOX = {timeoutMs: 5000, inputBytes: 96 * 1024 * 1024, outputBytes: 64 * 1024 * 1024};
const packDir = (id: string) => fileURLToPath(new URL(`../../packs/skill/${id}/`, import.meta.url));

let postgres: TemporaryPostgres, bed: PackTestbed;
const attempts: FunctionAttempt[] = [];

before(async () => {
  postgres = await startPostgres();
  bed = await openPackTestbed({postgres});
  await installXmlFixture(bed.registry, bed.kit, bed.admin);
  await installHtmlFixture(bed.registry, bed.kit, bed.admin);
  await installMindmapFixture(bed.registry, bed.kit, bed.admin);
  await installWorkbookFixture(bed.registry, bed.kit, bed.admin);
});
after(async () => { await bed?.close(); await postgres?.stop(); });

const registry = () => createSkillParserRegistry({
  registry: bed.registry,
  records: bed.kit,
  sandbox: {requireOsIsolation: false, onAttempt: (attempt) => { attempts.push(attempt); }},
});

function commandTree(): Buffer {
  const leaf = `<c a="1" b="2" d="3">t</c>`;
  const open = `<c a="1" b="2" d="3">`;
  const close = `</c>`;
  const el = (depth: number): string => {
    if (depth === 0) return leaf;
    let inner = '';
    for (let i = 0; i < 4; i++) inner += el(depth - 1);
    return open + inner + close;
  };
  const body = el(7);
  const pad = `<!--${'p'.repeat(Math.max(0, 2_100_000 - body.length))}-->`;
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${pad}\n${body}`, 'utf8');
}

function htmlPage(blocks: number, targetBytes: number): Buffer {
  const prefix = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>合成列表</title></head><body>';
  const suffix = '</body></html>';
  const page = (n: number) => {
    const text = '合'.repeat(n);
    let body = '';
    for (let i = 0; i < blocks; i++) body += `<p>合成条目 ${i} ${text}</p>`;
    return Buffer.from(prefix + body + suffix);
  };
  let lo = 0, hi = 2000, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (page(mid).length <= targetBytes) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const under = page(best);
  const over = page(Math.min(best + 1, 2000));
  return Math.abs(over.length - targetBytes) < Math.abs(under.length - targetBytes) ? over : under;
}

function mindmap(): Buffer {
  const note = 'n'.repeat(70);
  const children = [];
  for (let i = 0; i < 18000; i++) children.push({data: {id: 'n' + i, text: '合成', note}, children: []});
  return Buffer.from(JSON.stringify({root: {data: {id: 'root', text: '合成根'}, children}}));
}

async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('合成');
  for (let r = 1; r <= 200; r++) {
    const row: string[] = [];
    // Preserve the 20,000-cell shape while crossing the lazy threshold after
    // removal of selector aliases that the native parser never supported.
    for (let c = 1; c <= 100; c++) row.push('v' + r + '-' + c + 'x'.repeat(64));
    sheet.addRow(row);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function measure(pack: string, bytes: Buffer) {
  const out = await callPackFunction(
    {packDir: packDir(pack), module: 'functions/parse.ts', export: 'default'},
    {bytes: bytes.toString('base64'), options: {}},
    SANDBOX,
    {requireOsIsolation: false},
  );
  const output = Buffer.byteLength(JSON.stringify(out.output));
  const fragments = (out.output as {document?: {fragments?: unknown}}).document?.fragments;
  console.log(`MEASURE ${pack} input=${bytes.length} output=${output} durationMs=${out.durationMs} fragments=${Array.isArray(fragments) ? fragments.length : 'absent'}`);
  assert.ok(output <= OUTPUT_BUDGET, `${pack} output ${output}`);
  assert.ok(out.durationMs <= 3000, `${pack} duration ${out.durationMs}`);
  assert.equal(fragments, undefined);
  return out;
}

function pick(selectors: string[], count: number, seed: number): string[] {
  const middle = selectors.slice(1, -1);
  let state = seed >>> 0;
  const next = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return (state >>> 0) / 4294967296;
  };
  for (let i = middle.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = middle[i]; middle[i] = middle[j]; middle[j] = swap;
  }
  return [selectors[0], selectors[selectors.length - 1], ...middle.slice(0, count)];
}

async function sameFragment(got: Fragment | null | Promise<Fragment | null>, expected: Fragment | null, label: string) {
  const actual = await got;
  assert.ok(actual, label);
  assert.ok(expected, label);
  assert.equal(actual.selector, expected.selector, label);
  assert.equal(actual.text, expected.text, label);
  assert.deepEqual(actual.byteRange, expected.byteRange, label);
  assert.deepEqual(actual.data, expected.data, label);
}

async function sampleLocate(document: ParsedDocument, eager: {locate(selector: string): Fragment | null; listSelectors(prefix?: string, options?: {properties?: boolean}): string[]}, ranges: string[] = []) {
  const selectors = document.listSelectors('');
  assert.ok(selectors.length >= 2);
  const chosen = [...new Set([...pick(selectors, 50, 0x5eed), ...ranges])];
  assert.equal(typeof document.prefetch, 'function');
  await document.prefetch!(chosen);
  for (const selector of chosen) await sameFragment(document.locate(selector), eager.locate(selector), selector);
}

async function locateAll(document: ParsedDocument) {
  const selectors = document.listSelectors('');
  const before = attempts.length;
  await document.prefetch!(selectors);
  const loaded = attempts.length;
  assert.ok(loaded > before, 'batch locate calls the sandbox');
  for (const selector of selectors) {
    const fragment = await document.locate(selector);
    assert.ok(fragment, selector);
    assert.equal(fragment.selector.length > 0, true);
  }
  assert.equal(attempts.length, loaded, 'cached selectors are not requested again');
}

test('large synthetic documents stay inside the sandbox output budget and locate on demand', {timeout: 600_000}, async () => {
  const xml = commandTree();
  const htmlSmall = htmlPage(190, 46 * 1024);
  const htmlLarge = htmlPage(1200, 900 * 1024);
  const mind = mindmap();
  const book = await workbook();
  const xmlEager = xmlParser.parse(xml);
  const htmlSmallEager = htmlParser.parse(htmlSmall);
  const htmlLargeEager = htmlParser.parse(htmlLarge);
  const mindEager = kityminderParser.parse(mind);
  const bookEager = xlsxParser.parse(book);
  assert.ok(xml.length >= 2 * 1024 * 1024);
  assert.ok(xmlEager.summary().elements as number >= 20000);
  assert.ok(xmlEager.summary().depth as number >= 8);
  assert.equal(htmlSmallEager.summary().blocks, 190);
  assert.ok(htmlSmall.length >= 45 * 1024 && htmlSmall.length <= 48 * 1024);
  assert.ok(htmlLargeEager.summary().blocks as number > 1000);
  assert.ok(htmlLarge.length >= 890 * 1024 && htmlLarge.length <= 910 * 1024);
  assert.ok(mind.length >= 2 * 1024 * 1024);
  assert.ok(bookEager.summary().cells as number >= 20000);

  await measure('xml-format', xml);
  await measure('html-format', htmlSmall);
  await measure('html-format', htmlLarge);
  await measure('mindmap-format', mind);
  await measure('workbook-format', book);

  const parsers = registry();
  await parsers.refresh!();
  const xmlParserInstalled = parsers.get('xml@1');
  const htmlParserInstalled = parsers.get('html@1');
  const mindParserInstalled = parsers.get('kityminder@1');
  const bookParserInstalled = parsers.get('xlsx@1');
  assert.ok(xmlParserInstalled && htmlParserInstalled && mindParserInstalled && bookParserInstalled);

  const tinyXml = Buffer.from('<?xml version="1.0"?><root a="1" b="2"><child a="3" b="4">合成</child></root>');
  const tinyHtml = Buffer.from('<!DOCTYPE html><html><body><p>甲</p><p>乙</p><p>丙</p></body></html>');
  const tinyXmlDoc = await parseDocument(xmlParserInstalled, tinyXml);
  const tinyHtmlDoc = await parseDocument(htmlParserInstalled, tinyHtml);
  assert.equal(tinyXmlDoc.prefetch, undefined);
  assert.equal(tinyHtmlDoc.prefetch, undefined);
  const tinyXmlEager = xmlParser.parse(tinyXml);
  const tinyHtmlEager = htmlParser.parse(tinyHtml);
  for (const selector of tinyXmlEager.listSelectors('', {properties: true})) await sameFragment(tinyXmlDoc.locate(selector), tinyXmlEager.locate(selector), selector);
  for (const selector of [...tinyHtmlEager.listSelectors(''), 'b/0-1', 'b/0-2', 'b/1-2']) await sameFragment(tinyHtmlDoc.locate(selector), tinyHtmlEager.locate(selector), selector);

  const htmlLargeDoc = await parseDocument(htmlParserInstalled, htmlLarge);
  const selectors = htmlLargeDoc.listSelectors('');
  assert.ok(selectors.length > 301);
  const one = selectors[0];
  const batch = selectors.slice(1, 301);
  const fresh = selectors[301];
  const beforeCap = attempts.length;
  await htmlLargeDoc.prefetch!([one, one, one]);
  assert.equal(attempts.length - beforeCap, 1, 'duplicate lookups are one request');
  const cached = attempts.length;
  await htmlLargeDoc.prefetch!([one, one]);
  assert.equal(attempts.length, cached, 'a cache hit does not call the sandbox');
  await htmlLargeDoc.locate(one);
  assert.equal(attempts.length, cached);
  const beforeBatch = attempts.length;
  await htmlLargeDoc.prefetch!([...batch, ...batch]);
  assert.equal(attempts.length - beforeBatch, 2, '300 selectors are two batches of at most 256');
  const batched = attempts.length;
  await htmlLargeDoc.prefetch!(batch);
  await htmlLargeDoc.locate(batch[10]);
  assert.equal(attempts.length, batched);
  await htmlLargeDoc.locate(fresh);
  assert.equal(attempts.length, batched + 1);

  const xmlDoc = await parseDocument(xmlParserInstalled, xml);
  const htmlSmallDoc = await parseDocument(htmlParserInstalled, htmlSmall);
  const mindDoc = await parseDocument(mindParserInstalled, mind);
  const bookDoc = await parseDocument(bookParserInstalled, book);
  // Compare the complete lists and quotation units on actual threshold-triggered
  // documents, not just the sample of located fragments below.
  for (const [wire, native] of [[xmlDoc, xmlEager], [htmlSmallDoc, htmlSmallEager], [htmlLargeDoc, htmlLargeEager], [mindDoc, mindEager], [bookDoc, bookEager]] as const) {
    for (const properties of [false, true]) assert.deepEqual(wire.listSelectors('', {properties}), native.listSelectors('', {properties}));
  }
  const xmlUnits = xmlEager as typeof xmlEager & {[XML_QUOTATION]: (options: {properties: boolean}) => unknown};
  const htmlSmallUnits = htmlSmallEager as typeof htmlSmallEager & {[HTML_QUOTATION]: (options: {properties: boolean}) => unknown};
  const htmlLargeUnits = htmlLargeEager as typeof htmlLargeEager & {[HTML_QUOTATION]: (options: {properties: boolean}) => unknown};
  const mindUnits = mindEager as typeof mindEager & {[MIND_QUOTATION]: (options: {properties: boolean}) => unknown};
  for (const properties of [false, true]) {
    assert.deepEqual((xmlDoc as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({properties}), xmlUnits[XML_QUOTATION]({properties}));
    assert.deepEqual((htmlSmallDoc as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({properties}), htmlSmallUnits[HTML_QUOTATION]({properties}));
    assert.deepEqual((htmlLargeDoc as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({properties}), htmlLargeUnits[HTML_QUOTATION]({properties}));
    assert.deepEqual((mindDoc as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({properties}), mindUnits[MIND_QUOTATION]({properties}));
    const expectedWorkbookUnits = bookEager.listSelectors('', {properties}).map(selector => {
      const fragment = bookEager.locate(selector)!;
      return {selector, text: fragment.text, byteRange: fragment.byteRange, parent: -1, start: -1, end: -1};
    });
    assert.deepEqual((bookDoc as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({properties}), {stream: '', units: expectedWorkbookUnits});
  }
  const firstXml = xmlEager.locate(xmlEager.listSelectors('')[0]);
  const index = (firstXml?.data as {index?: string} | undefined)?.index;
  assert.equal(typeof index, 'string');
  const attribute = `${index}/${selectorSegment('@a')}`;
  assert.ok(xmlEager.locate(attribute), attribute);
  await sampleLocate(xmlDoc, xmlEager, [index as string, attribute]);
  await sampleLocate(htmlSmallDoc, htmlSmallEager, ['b/0-1', 'b/0-189', 'b/10-40', 'b/100-150']);
  await sampleLocate(htmlLargeDoc, htmlLargeEager, ['b/0-1', 'b/0-1199', 'b/10-40', 'b/400-900']);
  await sampleLocate(mindDoc, mindEager);
  await sampleLocate(bookDoc, bookEager);
  await locateAll(xmlDoc);
  await locateAll(htmlSmallDoc);
  await locateAll(htmlLargeDoc);
  await locateAll(mindDoc);
  await locateAll(bookDoc);
});
