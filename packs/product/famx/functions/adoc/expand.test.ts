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

test('list items, description-list items, an admonition and a retained single-line conditional verify on their own source line', async () => {
  const files = {
    'book.adoc': [
      '= Synthetic',                          // 1
      '',                                     // 2
      '== 参数',                               // 3
      '',                                     // 4
      'name:: 成员名称',                        // 5
      'weight:: 权重，取值 1 到 100',            // 6
      '',                                     // 7
      '* 使用 `demo pool add` 添加',            // 8
      '* {product} 支持热备',                   // 9
      "* Don't change it",                    // 10
      '',                                     // 11
      'NOTE: 需要管理员权限。',                  // 12
      '',                                     // 13
      'ifdef::brand-famx[FAMX 独有的一行说明。]',  // 14
      '',                                     // 15
    ].join('\n'),
  };
  const out = await compileAdoc(group(files, { product: 'FAMX', 'brand-famx': true }));
  assert.ok(out.ok, JSON.stringify(out));
  // The engine's own text of these blocks is converted (tags, expanded attributes, typographic replacements), so the
  // locator compares the words of the source line, with its structural marker off, against the words of that text.
  assert.equal(out.report.unverified_count, 0, JSON.stringify(out.report.unverified));
  const items = out.model.blocks.filter((b) => b.kind === 'list_item');
  assert.deepEqual(items.map((b) => b.origins[0]?.selector ?? null), ['l/5', 'l/5', 'l/6', 'l/6', 'l/8', 'l/9', 'l/10']);
  assert.deepEqual(items.map((b) => b.listAt !== null && out.model.blocks[b.listAt]?.kind), ['dlist', 'dlist', 'dlist', 'dlist', 'ulist', 'ulist', 'ulist']);
  assert.equal(items[4]?.origins[0]?.verbatim, '* 使用 `demo pool add` 添加', 'the citation is the source line, not the converted text');
  assert.equal(out.model.blocks.find((b) => b.kind === 'admonition')?.origins[0]?.selector, 'l/12');
  assert.equal(out.model.blocks.find((b) => b.raw === 'FAMX 独有的一行说明。')?.origins[0]?.selector, 'l/14');
});

test('a container with no text of its own is not reported as unverified, and a repeated sentence is cited where the engine put it', async () => {
  const files = {
    'book.adoc': [
      '= Synthetic',   // 1
      '',              // 2
      '== 说明',        // 3
      '',              // 4
      '* 甲',           // 5
      '* 乙',           // 6
      '',              // 7
      '同一段说明文字。', // 8
      '',              // 9
      '同一段说明文字。', // 10
      '',              // 11
    ].join('\n'),
  };
  const out = await compileAdoc(group(files));
  assert.ok(out.ok, JSON.stringify(out));
  // The list container carries no text of its own: its items do, and both are cited. Reporting the container would name
  // a gap that is not there.
  assert.equal(out.report.unverified.filter((u) => u.kind === 'ulist').length, 0, JSON.stringify(out.report.unverified));
  assert.deepEqual(out.model.blocks.filter((b) => b.kind === 'list_item').map((b) => b.origins[0]?.selector ?? null), ['l/5', 'l/6']);
  // The sentence stands on two lines, but a blank line separates them, so the other copy is another block's line: each
  // paragraph cites its own. That two lines hold the text is still disclosed.
  const repeated = out.model.blocks.filter((b) => b.raw === '同一段说明文字。');
  assert.deepEqual(repeated.map((b) => b.origins[0]?.selector ?? null), ['l/8', 'l/10']);
  assert.equal(out.report.unverified_count, 0, JSON.stringify(out.report.unverified));
  assert.deepEqual(out.report.disambiguated.map((d) => [d.kind, d.reported_line, d.candidates]), [['paragraph', 8, 2], ['paragraph', 10, 2]]);
});

test('two identical items on adjacent lines are told apart by the engine cursor, and the choice is disclosed', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n== 说明\n\n* 甲\n* 甲\n' }));
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.model.blocks.filter((b) => b.kind === 'list_item').map((b) => b.origins[0]?.selector ?? null), ['l/5', 'l/6']);
  assert.deepEqual(out.report.disambiguated.map((d) => [d.kind, d.reported_line, d.candidates]), [['list_item', 5, 2], ['list_item', 6, 2]]);
  assert.equal(out.report.disambiguated_count, 2);
});

test('a block cites its own line, not a neighbour that happens to hold the same words', async () => {
  // An admonition whose label the engine drops, next to a paragraph that says the same words.
  const labelled = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n== 说明\n\n修改后保存配置。\n\nNOTE: 修改后保存配置。\n' }));
  assert.ok(labelled.ok, JSON.stringify(labelled));
  assert.deepEqual(
    labelled.model.blocks.filter((b) => b.kind === 'paragraph' || b.kind === 'admonition').map((b) => [b.kind, b.reportedLine, b.origins[0]?.selector ?? null]),
    [['paragraph', 5, 'l/5'], ['admonition', 7, 'l/7']],
  );
  assert.deepEqual(labelled.report.disambiguated.map((d) => [d.kind, d.reported_line, d.candidates]), [['admonition', 7, 2]], 'the twin line is counted, and the admonition still cites its own');

  // A description list whose second value stands on its own line, and a term that repeats it.
  const described = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n== 说明\n\nname:: 成员名称\nweight::\n成员名称\n' }));
  assert.ok(described.ok, JSON.stringify(described));
  assert.deepEqual(
    described.model.blocks.filter((b) => b.kind === 'list_item').map((b) => [b.raw, b.reportedLine, b.origins[0]?.selector ?? null]),
    [['name', 5, 'l/5'], ['成员名称', 5, 'l/5'], ['weight', 6, 'l/6'], ['成员名称', 7, 'l/7']],
  );

  // A list item whose attribute expands to what the next item says literally: each cites its own line, whichever family
  // expands it, so the two family copies never cite different lines for the same item.
  for (const product of ['FAMX', 'FAMY']) {
    const twin = await compileAdoc(group({ 'book.adoc': `= Synthetic\n\n== 说明\n\n* {product} 支持热备\n* ${product} 支持热备\n` }, { product }));
    assert.ok(twin.ok, JSON.stringify(twin));
    assert.deepEqual(
      twin.model.blocks.filter((b) => b.kind === 'list_item').map((b) => b.origins[0]?.selector ?? null),
      ['l/5', 'l/6'],
      `product=${product}`,
    );
  }

  // A callout line in a listing and an indented literal block: each cites the line it is written on, and the cursor
  // offset the engine's delimiter reporting causes is disclosed as a remap.
  const marks = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n== 说明\n\n----\n<1> 保存\n----\n\n 保存配置。\n' }));
  assert.ok(marks.ok, JSON.stringify(marks));
  assert.equal(marks.model.blocks.find((b) => b.kind === 'listing')?.origins[0]?.selector, 'l/6');
  assert.equal(marks.model.blocks.find((b) => b.kind === 'literal')?.origins[0]?.selector, 'l/9');
  assert.deepEqual(marks.report.remapped.map((r) => [r.reported_line, r.verified_line]), [[5, 6]]);

  // A checklist item: the engine drops the `[x]` mark, so no source line folds to its text. Nothing is cited and the
  // block is reported — the neighbour's line is never borrowed.
  const checklist = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n== 说明\n\n* [x] 保存\n* [ ] 保存\n' }));
  assert.ok(checklist.ok, JSON.stringify(checklist));
  const items = checklist.model.blocks.filter((b) => b.kind === 'list_item');
  assert.deepEqual(items.map((b) => b.origins.length), [0, 0]);
  assert.deepEqual(checklist.report.unverified.map((u) => [u.kind, u.reported_line]), [['list_item', 5], ['list_item', 6]]);
});

test('a paragraph the engine reports at the endif of a removed branch still cites the line it was read from', async () => {
  const out = await compileAdoc(group({ 'book.adoc': '= Synthetic\n\n== 说明\n\n保存配置。\nifdef::brand-famx[]\nFAMX 设备另需重启。\nendif::[]\n\n保存配置。\n' }));
  assert.ok(out.ok, JSON.stringify(out));
  // The window is counted in visible lines, so the line before the removed branch is still reachable, and a candidate
  // across a blank line is another block's line: the first paragraph cites l/5, the second l/10.
  assert.deepEqual(
    out.model.blocks.filter((b) => b.kind === 'paragraph').map((b) => [b.reportedLine, b.origins[0]?.selector ?? null]),
    [[8, 'l/5'], [10, 'l/10']],
  );
  assert.deepEqual(out.report.remapped.map((r) => [r.reported_line, r.verified_line]), [[8, 5]], 'the cursor offset is disclosed');
  assert.equal(out.report.unverified_count, 0, JSON.stringify(out.report.unverified));
});

test('an item that verifies on no line does not borrow the identical line of the item before it', async () => {
  const files = { 'book.adoc': '= Synthetic\n\n== 说明\n\n* 保存\n* [x] 保存\n' };
  const out = await compileAdoc(group(files));
  assert.ok(out.ok, JSON.stringify(out));
  // The engine drops the checkbox mark, so the second item's own line folds to nothing the locator can match. The first
  // item's line holds the same words and sits right next to the cursor — but the cursor stands on the second item's own
  // text line, which is no delimiter, control or blank line, so that neighbour is not a recovery and is not cited.
  const items = out.model.blocks.filter((b) => b.kind === 'list_item');
  assert.deepEqual(
    items.map((b) => [b.reportedLine, b.origins.map((o) => o.selector)]),
    [[5, ['l/5']], [6, []]],
    JSON.stringify(items.map((b) => [b.reportedLine, b.raw, b.origins, b.unverifiedReason])),
  );
  assert.deepEqual(out.report.unverified.map((u) => [u.kind, u.reported_line]), [['list_item', 6]]);
  assert.match(items[1]!.unverifiedReason, /相符|不唯一/);
});
