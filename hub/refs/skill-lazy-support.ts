import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openPackTestbed, type PackTestbed } from '../runs/packs/testing/setup.ts';
import { createSkillParserRegistry } from './skills.ts';
import { installHtmlFixture, installMindmapFixture, installWorkbookFixture, installXmlFixture } from '../testing/skills.ts';
import { callPackFunction } from '../rules/api.ts';
import type { FunctionAttempt } from '../rules/sandbox/retry.ts';
import { selectorSegment } from '../../packs/skill/xml-format/functions/selectors.ts';
import { QUOTATION_UNITS, type Fragment, type ParsedDocument, type QuotationSource } from './parser.ts';
import { QUOTATION_UNITS as XML_QUOTATION } from '../../packs/skill/xml-format/functions/format.ts';
import { QUOTATION_UNITS as HTML_QUOTATION } from '../../packs/skill/html-format/functions/format.ts';
import { QUOTATION_UNITS as MIND_QUOTATION } from '../../packs/skill/mindmap-format/functions/format.ts';

const OUTPUT_BUDGET = 24 * 1024 * 1024;
const SANDBOX = { timeoutMs: 5000, inputBytes: 96 * 1024 * 1024, outputBytes: 64 * 1024 * 1024 };
const packDir = (id: string) => fileURLToPath(new URL(`../../packs/skill/${id}/`, import.meta.url));

export type LazyKind = 'xml' | 'html' | 'mindmap' | 'workbook';

export async function openLazy(kinds: LazyKind[]) {
  const postgres: TemporaryPostgres = await startPostgres();
  const bed: PackTestbed = await openPackTestbed({ postgres });
  if (kinds.includes('xml')) await installXmlFixture(bed.registry, bed.kit, bed.admin);
  if (kinds.includes('html')) await installHtmlFixture(bed.registry, bed.kit, bed.admin);
  if (kinds.includes('mindmap')) await installMindmapFixture(bed.registry, bed.kit, bed.admin);
  if (kinds.includes('workbook')) await installWorkbookFixture(bed.registry, bed.kit, bed.admin);
  const attempts: FunctionAttempt[] = [];
  const parsers = () => createSkillParserRegistry({
    registry: bed.registry,
    records: bed.kit,
    sandbox: { requireOsIsolation: false, onAttempt: (attempt) => { attempts.push(attempt); } },
  });
  return {
    attempts,
    parsers,
    async close() {
      await bed.close();
      await postgres.stop();
    },
  };
}

export function commandTree(): Buffer {
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

export function htmlPage(blocks: number, targetBytes: number): Buffer {
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

export function mindmap(): Buffer {
  const note = 'n'.repeat(70);
  const children = [];
  for (let i = 0; i < 18000; i++) children.push({ data: { id: 'n' + i, text: '合成', note }, children: [] });
  return Buffer.from(JSON.stringify({ root: { data: { id: 'root', text: '合成根' }, children } }));
}

export async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('合成');
  for (let r = 1; r <= 200; r++) {
    const row: string[] = [];
    for (let c = 1; c <= 100; c++) row.push('v' + r + '-' + c + 'x'.repeat(64));
    sheet.addRow(row);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function measure(pack: string, bytes: Buffer) {
  const out = await callPackFunction(
    { packDir: packDir(pack), module: 'functions/parse.ts', export: 'default' },
    { bytes: bytes.toString('base64'), options: {} },
    SANDBOX,
    { requireOsIsolation: false },
  );
  const output = Buffer.byteLength(JSON.stringify(out.output));
  const fragments = (out.output as { document?: { fragments?: unknown } }).document?.fragments;
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

export async function sameFragment(got: Fragment | null | Promise<Fragment | null>, expected: Fragment | null, label: string) {
  const actual = await got;
  assert.ok(actual, label);
  assert.ok(expected, label);
  assert.equal(actual.selector, expected.selector, label);
  assert.equal(actual.text, expected.text, label);
  assert.deepEqual(actual.byteRange, expected.byteRange, label);
  assert.deepEqual(actual.data, expected.data, label);
}

export async function sampleLocate(document: ParsedDocument, eager: { locate(selector: string): Fragment | null; listSelectors(prefix?: string, options?: { properties?: boolean }): string[] }, ranges: string[] = []) {
  const selectors = document.listSelectors('');
  assert.ok(selectors.length >= 2);
  const chosen = [...new Set([...pick(selectors, 50, 0x5eed), ...ranges])];
  assert.equal(typeof document.prefetch, 'function');
  await document.prefetch!(chosen);
  for (const selector of chosen) await sameFragment(document.locate(selector), eager.locate(selector), selector);
}

export async function locateAll(document: ParsedDocument, attempts: FunctionAttempt[]) {
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

type Eager = ParsedDocument & { locate(selector: string): Fragment | null; listSelectors(prefix?: string, options?: { properties?: boolean }): string[] };

/** The per-document comparisons that used to run one after another in a single test. */
export async function compareDocument(wire: ParsedDocument, eager: Eager, kind: LazyKind, attempts: FunctionAttempt[], ranges: string[] = []) {
  for (const properties of [false, true]) assert.deepEqual(wire.listSelectors('', { properties }), eager.listSelectors('', { properties }));
  for (const properties of [false, true]) {
    if (kind === 'xml') {
      const units = eager as Eager & { [XML_QUOTATION]: (options: { properties: boolean }) => unknown };
      assert.deepEqual((wire as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({ properties }), units[XML_QUOTATION]({ properties }));
    } else if (kind === 'html') {
      const units = eager as Eager & { [HTML_QUOTATION]: (options: { properties: boolean }) => unknown };
      assert.deepEqual((wire as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({ properties }), units[HTML_QUOTATION]({ properties }));
    } else if (kind === 'mindmap') {
      const units = eager as Eager & { [MIND_QUOTATION]: (options: { properties: boolean }) => unknown };
      assert.deepEqual((wire as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({ properties }), units[MIND_QUOTATION]({ properties }));
    } else {
      const expectedWorkbookUnits = eager.listSelectors('', { properties }).map(selector => {
        const fragment = eager.locate(selector) as Fragment;
        return { selector, text: fragment.text, byteRange: fragment.byteRange, parent: -1, start: -1, end: -1 };
      });
      assert.deepEqual((wire as ParsedDocument & QuotationSource)[QUOTATION_UNITS]({ properties }), { stream: '', units: expectedWorkbookUnits });
    }
  }
  await sampleLocate(wire, eager, ranges);
  await locateAll(wire, attempts);
}

export { selectorSegment };
