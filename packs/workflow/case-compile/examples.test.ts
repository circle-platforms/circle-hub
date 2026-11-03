// Issue #130: the bundled examples are one consistent set. Uploading examples/case-mindmap.json and starting the run of
// examples/start-run.json must give exactly the item ids and quote references examples/submit-result.json answers with.
// When this fails, regenerate with `node testing/examples.ts --write` instead of editing values by hand.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deriveExamples, quotesOf } from './testing/examples.ts';

const json = (name: string): any => JSON.parse(readFileSync(new URL(`./examples/${name}`, import.meta.url), 'utf8'));

test('start-run, submit-result and case-mindmap examples agree on the subject, the item ids and every quote reference', () => {
  const start = json('start-run.json').arguments, submission = json('submit-result.json'), derived = deriveExamples(start.parameters);
  assert.deepEqual(start.inputs.subject, { reference: derived.subject }, 'the subject is the upload of examples/case-mindmap.json');
  assert.deepEqual(derived.items.map((item) => item.autoid), [start.parameters.autoid]);
  assert.deepEqual(submission.items.map((item: any) => item.item), derived.items.map((item) => item.id), 'item ids are the projected ones');
  assert.deepEqual(derived.items.map((item) => item.id), ['fixture-document:fixture-case'], 'an uploaded mind map is named by its root node (3.9.17)');
  const quotes = quotesOf(submission); assert.ok(quotes.length >= 2);
  for (const quote of quotes) assert.equal(quote.reference, derived.references.get(quote.text), `quote ${quote.text} cites its own node of the uploaded mind map`);
  for (const item of submission.items) for (const claim of item.slots.plan) assert.equal(claim.data.bucket, derived.bed, 'the plan names the profile bed');
  assert.deepEqual(derived.items[0].path, ['合成文档', '健康检查间隔配置与查询测试\nwidget health interval 60\nshow health interval']);
});
