import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseDocument } from './api.ts';
import { xmlParser } from '../../packs/skill/xml-format/api.ts';
import { commandTree, compareDocument, measure, openLazy, sameFragment, selectorSegment } from './skill-lazy-support.ts';

const lazy = await openLazy(['xml']);
after(() => lazy.close());

test('a large synthetic xml document stays inside the sandbox output budget and locates on demand', { timeout: 600_000 }, async () => {
  const xml = commandTree();
  const xmlEager = xmlParser.parse(xml);
  assert.ok(xml.length >= 2 * 1024 * 1024);
  assert.ok(xmlEager.summary().elements as number >= 20000);
  assert.ok(xmlEager.summary().depth as number >= 8);
  await measure('xml-format', xml);

  const parsers = lazy.parsers();
  await parsers.refresh!();
  const installed = parsers.get('xml@1');
  assert.ok(installed);
  const tinyXml = Buffer.from('<?xml version="1.0"?><root a="1" b="2"><child a="3" b="4">合成</child></root>');
  const tinyXmlDoc = await parseDocument(installed, tinyXml);
  assert.equal(tinyXmlDoc.prefetch, undefined);
  const tinyXmlEager = xmlParser.parse(tinyXml);
  for (const selector of tinyXmlEager.listSelectors('', { properties: true })) await sameFragment(tinyXmlDoc.locate(selector), tinyXmlEager.locate(selector), selector);

  const xmlDoc = await parseDocument(installed, xml);
  const firstXml = xmlEager.locate(xmlEager.listSelectors('')[0]);
  const index = (firstXml?.data as { index?: string } | undefined)?.index;
  assert.equal(typeof index, 'string');
  const attribute = `${index}/${selectorSegment('@a')}`;
  assert.ok(xmlEager.locate(attribute), attribute);
  await compareDocument(xmlDoc, xmlEager, 'xml', lazy.attempts, [index as string, attribute]);
});
