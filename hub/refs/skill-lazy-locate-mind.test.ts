import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseDocument } from './api.ts';
import { kityminderParser } from '../../packs/skill/mindmap-format/api.ts';
import { compareDocument, measure, mindmap, openLazy } from './skill-lazy-support.ts';

const lazy = await openLazy(['mindmap']);
after(() => lazy.close());

test('a large synthetic mind map stays inside the sandbox output budget and locates on demand', { timeout: 600_000 }, async () => {
  const mind = mindmap();
  const mindEager = kityminderParser.parse(mind);
  assert.ok(mind.length >= 2 * 1024 * 1024);
  await measure('mindmap-format', mind);
  const parsers = lazy.parsers();
  await parsers.refresh!();
  const installed = parsers.get('kityminder@1');
  assert.ok(installed);
  const mindDoc = await parseDocument(installed, mind);
  await compareDocument(mindDoc, mindEager, 'mindmap', lazy.attempts);
});
