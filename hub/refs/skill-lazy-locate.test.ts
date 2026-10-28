import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseDocument } from './api.ts';
import { htmlParser } from '../../packs/skill/html-format/api.ts';
import { compareDocument, htmlPage, measure, openLazy, sameFragment } from './skill-lazy-support.ts';

const lazy = await openLazy(['xml', 'html', 'mindmap', 'workbook']);
after(() => lazy.close());

test('large synthetic html stays inside the sandbox output budget and locates on demand', { timeout: 600_000 }, async () => {
  const htmlSmall = htmlPage(190, 46 * 1024);
  const htmlLarge = htmlPage(1200, 900 * 1024);
  const htmlSmallEager = htmlParser.parse(htmlSmall);
  const htmlLargeEager = htmlParser.parse(htmlLarge);
  assert.equal(htmlSmallEager.summary().blocks, 190);
  assert.ok(htmlSmall.length >= 45 * 1024 && htmlSmall.length <= 48 * 1024);
  assert.ok(htmlLargeEager.summary().blocks as number > 1000);
  assert.ok(htmlLarge.length >= 890 * 1024 && htmlLarge.length <= 910 * 1024);
  await measure('html-format', htmlSmall);
  await measure('html-format', htmlLarge);

  const parsers = lazy.parsers();
  await parsers.refresh!();
  assert.ok(parsers.get('xml@1') && parsers.get('html@1') && parsers.get('kityminder@1') && parsers.get('xlsx@1'));
  const htmlParserInstalled = parsers.get('html@1')!;

  const tinyHtml = Buffer.from('<!DOCTYPE html><html><body><p>甲</p><p>乙</p><p>丙</p></body></html>');
  const tinyHtmlDoc = await parseDocument(htmlParserInstalled, tinyHtml);
  assert.equal(tinyHtmlDoc.prefetch, undefined);
  const tinyHtmlEager = htmlParser.parse(tinyHtml);
  for (const selector of [...tinyHtmlEager.listSelectors(''), 'b/0-1', 'b/0-2', 'b/1-2']) await sameFragment(tinyHtmlDoc.locate(selector), tinyHtmlEager.locate(selector), selector);

  const htmlLargeDoc = await parseDocument(htmlParserInstalled, htmlLarge);
  const selectors = htmlLargeDoc.listSelectors('');
  assert.ok(selectors.length > 301);
  const one = selectors[0];
  const batch = selectors.slice(1, 301);
  const fresh = selectors[301];
  const beforeCap = lazy.attempts.length;
  await htmlLargeDoc.prefetch!([one, one, one]);
  assert.equal(lazy.attempts.length - beforeCap, 1, 'duplicate lookups are one request');
  const cached = lazy.attempts.length;
  await htmlLargeDoc.prefetch!([one, one]);
  assert.equal(lazy.attempts.length, cached, 'a cache hit does not call the sandbox');
  await htmlLargeDoc.locate(one);
  assert.equal(lazy.attempts.length, cached);
  const beforeBatch = lazy.attempts.length;
  await htmlLargeDoc.prefetch!([...batch, ...batch]);
  assert.equal(lazy.attempts.length - beforeBatch, 2, '300 selectors are two batches of at most 256');
  const batched = lazy.attempts.length;
  await htmlLargeDoc.prefetch!(batch);
  await htmlLargeDoc.locate(batch[10]);
  assert.equal(lazy.attempts.length, batched);
  await htmlLargeDoc.locate(fresh);
  assert.equal(lazy.attempts.length, batched + 1);

  const htmlSmallDoc = await parseDocument(htmlParserInstalled, htmlSmall);
  await compareDocument(htmlSmallDoc, htmlSmallEager, 'html', lazy.attempts, ['b/0-1', 'b/0-189', 'b/10-40', 'b/100-150']);
  await compareDocument(htmlLargeDoc, htmlLargeEager, 'html', lazy.attempts, ['b/0-1', 'b/0-1199', 'b/10-40', 'b/400-900']);
});
