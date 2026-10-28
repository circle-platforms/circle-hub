import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseDocument } from './api.ts';
import { xlsxParser } from '../../packs/skill/workbook-format/api.ts';
import { compareDocument, measure, openLazy, workbook } from './skill-lazy-support.ts';

const lazy = await openLazy(['workbook']);
after(() => lazy.close());

test('a large synthetic workbook stays inside the sandbox output budget and locates on demand', { timeout: 600_000 }, async () => {
  const book = await workbook();
  const bookEager = xlsxParser.parse(book);
  assert.ok(bookEager.summary().cells as number >= 20000);
  await measure('workbook-format', book);
  const parsers = lazy.parsers();
  await parsers.refresh!();
  const installed = parsers.get('xlsx@1');
  assert.ok(installed);
  const bookDoc = await parseDocument(installed, book);
  await compareDocument(bookDoc, bookEager, 'workbook', lazy.attempts);
});
