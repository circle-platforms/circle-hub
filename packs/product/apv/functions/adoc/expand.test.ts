import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { textParser } from '../../../../../hub/refs/api.ts';
import { compileAdoc } from './index.ts';

function group(files: Record<string, string>, attributes: Record<string, string | boolean> = {}) {
  return { main: 'book.adoc', revision: '42', attributes, files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, { text, revision: '42', sha256: createHash('sha256').update(text).digest('hex') }])) };
}
test('a main file orders a dozen chapters, leaving unreferenced files outside the model', async () => {
  const files: Record<string, string> = { 'book.adoc': '= Synthetic\n:cmd: demo one\n\n' + Array.from({ length: 12 }, (_, i) => `include::c${11 - i}.adoc[]`).join('\n'), 'unused.adoc': '== Not in book\n\nUnused.' };
  for (let i = 0; i < 12; i++) files[`c${i}.adoc`] = `== Chapter ${i}\n\nParagraph ${i}.\n\n`;
  const out = await compileAdoc(group(files)); assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.model.blocks.filter((b) => b.kind === 'section' && b.level === 1).map((b) => b.title), Array.from({ length: 12 }, (_, i) => `Chapter ${11 - i}`));
  assert.deepEqual(out.report.unused_files, ['unused.adoc']);
  assert.ok(!out.model.expanded_text.includes('Not in book'));
});
test('conditions use the engine and report removed source rows separately for nested branches', async () => {
  const files = { 'book.adoc': '= Synthetic\n\nifdef::brand[]\n== Included\n\nifdef::missing[]\nHidden nested.\nendif::missing[]\nendif::brand[]\n\nifndef::brand[]\nHidden alternative.\nendif::brand[]\n' };
  const out = await compileAdoc(group(files, { brand: '' })); assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.report.conditions.map((b) => b.retained), [true, false, false]);
  assert.deepEqual(out.report.conditions[1].removed, [{ file: 'book.adoc', from: 7, to: 7, lines: 1 }]);
  assert.deepEqual(out.report.conditions[2].removed, [{ file: 'book.adoc', from: 12, to: 12, lines: 1 }]);
  assert.ok(!out.model.blocks.some((b) => b.raw.includes('Hidden')));
});
test('source attribute changes and cancellation are replayed without rewriting raw text', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n:cmd: demo one\n\n*{cmd}*\n\n:cmd: demo two\n\n*{cmd}*\n\n:flag:\nifdef::flag[]\nKept after body attribute.\nendif::flag[]\n\n:flag!:\nifdef::flag[]\nNot kept.\nendif::flag[]\n' }));
  assert.ok(out.ok, JSON.stringify(out));
  const paragraphs = out.model.blocks.filter((b) => b.raw === '*{cmd}*');
  assert.deepEqual(paragraphs.map((b) => b.expanded), ['*demo one*', '*demo two*']);
  assert.deepEqual(out.report.conditions.map((b) => b.retained), [true, false]);
});
test('NUL and CRLF remain attributable to raw source bytes and every emitted text reference resolves', async () => {
  const input = group({ 'book.adoc': '= Synthetic\r\n\r\ninclude::chapter.adoc[]\r\n', 'chapter.adoc': '== Chapter\r\n\r\n[role=signature]\r\n----\r\ndemo\0 one\r\n----\r\n\r\nA paragraph.\r\n' });
  const out = await compileAdoc(input); assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.report.files.find((f) => f.file === 'chapter.adoc')!.nul_bytes, 1);
  assert.ok(out.report.files.find((f) => f.file === 'chapter.adoc')!.crlf > 0);
  const listing = out.model.blocks.find((b) => b.kind === 'listing')!;
  assert.equal(listing.raw, 'demo one'); assert.equal(listing.origin?.from, 5);
  for (const block of out.model.blocks) if (block.origin) {
    const file = input.files[block.origin.file];
    const parsed = textParser.parse(new TextEncoder().encode(file.text));
    assert.equal(parsed.locate(block.origin.selector)!.text, block.origin.verbatim);
  }
});
test('identity and complete output bytes are deterministic, while declared attributes change identity', async () => {
  const input = group({ 'book.adoc': '= Synthetic\n\nifdef::brand[]\nBrand.\nendif::brand[]\n' });
  const a = await compileAdoc(input), b = await compileAdoc(input); assert.ok(a.ok && b.ok);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const c = await compileAdoc({ ...input, attributes: { brand: '' } }); assert.ok(c.ok);
  assert.notEqual(c.composition.sha256, a.composition.sha256);
});
test('attribute-based include targets use prior source definitions, including conditional assignments', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\nifdef::brand[]\n:chapter: chapter.adoc\nendif::brand[]\n\ninclude::{chapter}[]', 'chapter.adoc': '== Chapter\n\nIncluded.' }, { brand: '' }));
  assert.ok(out.ok, JSON.stringify(out)); assert.ok(out.model.expanded_text.includes('Included.'));
});

test('engine OR/AND and inline conditions work, and empty/nested branches have explicit dispositions', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\nifdef::a,b[Selected inline.]\n\nifdef::a+b[]\nNot both.\nendif::a+b[]\n\nifdef::a[]\nendif::a[]\n\nifndef::a[]\nifdef::b[]\nBlocked by parent.\nendif::b[]\nendif::a[]' }, { a: '', b: false }));
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.report.conditions.map((b) => b.retained), [true, false, true, false, false]);
  assert.equal(out.report.conditions[2].removed_lines, 0);
  assert.ok(out.model.blocks.some((b) => b.raw === 'Selected inline.'));
});

test('simultaneous host calls serialize logger sessions without changing either result', async () => {
  const input = group({ 'book.adoc': '= Synthetic\n\nifdef::a[]\nAlpha.\nendif::a[]\n\nifndef::a[]\nBeta.\nendif::a[]' });
  const [a, b] = await Promise.all([compileAdoc({ ...input, attributes: { a: '' } }), compileAdoc(input)]);
  assert.ok(a.ok && b.ok);
  assert.equal(a.report.conditions[0].retained, true); assert.equal(b.report.conditions[0].retained, false);
});

test('UTF-8 BOM and mixed line breaks produce the exact text@1 fragment text', async () => {
  const input = group({ 'book.adoc': '\ufeff= Synthetic\r\n\r\n== Chapter\r\rText.\n' });
  const out = await compileAdoc(input); assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.report.files[0].utf8_bom_bytes, 3);
  const parsed = textParser.parse(new TextEncoder().encode(input.files['book.adoc'].text));
  for (const block of out.model.blocks) for (const origin of block.origins) assert.equal(parsed.locate(origin.selector)!.text, origin.verbatim);
});

test('include-path lookup flushes body attribute updates and unsets immediately before the include', async () => {
  const files = { 'book.adoc': '= Synthetic\n:chapter: old.adoc\n\nA paragraph.\n\n:chapter: new.adoc\ninclude::{chapter}[]', 'old.adoc': '== Old\n\nWrong.', 'new.adoc': '== New\n\nRight.' };
  const updated = await compileAdoc(group(files)); assert.ok(updated.ok, JSON.stringify(updated));
  assert.ok(updated.model.expanded_text.includes('Right.')); assert.ok(!updated.model.expanded_text.includes('Wrong.'));
  const unset = await compileAdoc(group({ ...files, 'book.adoc': files['book.adoc'].replace(':chapter: new.adoc', ':chapter!:') }));
  assert.equal(unset.ok, false);
});

test('an attribute-based whole-file include inside a listing is not rejected by the prefix probe warning', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n:snippet: snippet.adoc\n\n----\ninclude::{snippet}[]\n----\n', 'snippet.adoc': 'demo one\n' }));
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.model.blocks.find((b) => b.kind === 'listing')?.raw, 'demo one');
});
