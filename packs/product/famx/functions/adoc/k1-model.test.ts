// Tests of the adoc-to-K1 mapping (task kb-adoc item 4): the expanded model becomes a markdown@1-shaped model —
// sections from `=` levels, discrete headings marked, invalid `=======` not a heading, blocks carry their section
// paths and text@1 line selectors — and K1's produceManualEntries applies to it unchanged (placement, tables,
// literals). A block that cannot be cited is reported with its file, line and reason and stays out of the model; it is
// never handed to K1 without a selector, because K1 skips such a block as malformed and its text would be lost.
// Synthetic adoc only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { toK1Model, type Mapped } from './k1-model.ts';
import { compileAdoc } from './index.ts';
import {produceManualEntries} from '../manual.ts';
import {compileGrammar} from '../commands.ts';
const catalog=compileGrammar(['add','del','mode'].map(word=>({path:'/commands/demo/pool/'+word,words:['demo','pool',word],signatures:[{params:[]}]})));
import { ADOC_PARSER, produceAdocEntries } from './entries.ts';

const compile = async (files: Record<string, string>, main = 'main.adoc', attributes: Record<string, string | boolean> = {}): Promise<Extract<Awaited<ReturnType<typeof compileAdoc>>, { ok: true }>> => {
  const out = await compileAdoc({ main, revision: '42', attributes, files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: createHash('sha256').update(text).digest('hex') }])) });
  assert.ok(out.ok, JSON.stringify(out));
  return out;
};

/** The mapped model, with the mapping's own report checked: nothing is left uncited unless the test says so. */
const mapped = (out: Awaited<ReturnType<typeof compile>>, name = 'cli'): Mapped => {
  const result = toK1Model(out.model, out.composition, name);
  assert.deepEqual(result.uncited, [], JSON.stringify(result.uncited));
  return result;
};

test('the expanded model maps to the markdown@1 shape: sections, blocks, selectors and paths', async () => {
  const out = await compile({
    'main.adoc': '= Book\n\n== First\n\nintro text.\n\n=== Nested\n\nnested text.\n',
  });
  const model = mapped(out).model;
  assert.equal(model.sections.length, 3, 'the document section plus First and Nested (the `= Book` title is the document itself, no extra section)');
  assert.equal(model.sections[1]!.title, 'First');
  assert.equal(model.sections[2]!.title, 'Nested');
  const nested = model.blocks.find((b) => b.text === 'nested text.');
  assert.ok(nested !== undefined);
  assert.deepEqual(nested.path, ['First', 'Nested'], 'the heading path rides along');
  assert.equal(nested.selector, `cite/${model.blocks.indexOf(nested)}`, 'K1 carries a citation key of the mapped model, never a packed reference');
  assert.equal(nested.cite.file, 'main.adoc', 'the nested paragraph cites its own chapter file');
  assert.equal(nested.cite.selector, 'l/9', 'and its own verified source line');
  assert.match(nested.cite.sha256, /^[0-9a-f]{64}$/);
});

test('discrete headings are marked and invalid ======= lines are reported, not headings', async () => {
  const out = await compile({
    'main.adoc': [
      '= Book',
      '',
      '[discrete]',
      '== Discrete One',
      '',
      'text under discrete.',
      '',
      '======= Seven',
      '',
      'after invalid.',
      '',
    ].join('\n'),
  });
  const model = mapped(out).model;
  const discrete = model.blocks.find((b: { kind: string; text: string }) => b.kind === 'discrete_heading');
  assert.ok(discrete !== undefined && discrete.text === 'Discrete One', JSON.stringify(model.blocks.map((b: { kind: string; text: string }) => [b.kind, b.text])));
  assert.equal(model.sections.filter((s: { title: string }) => s.title === 'Discrete One').length, 0, 'a discrete heading is no section');
  assert.ok(out.report.invalid_headings.length === 1 && out.report.invalid_headings[0]!.line === 8, JSON.stringify(out.report.invalid_headings));
  assert.equal(model.blocks.some((b: { text: string }) => b.text === '======= Seven'), true, 'the invalid line is an ordinary block');
});

test('chapter placement and row citations survive without admitting definitions from mapped text', async () => {
  const out = await compile({
    'main.adoc': [
      '= Book',
      '',
      '== 配置命令',
      '',
      '[cols="2,3",options="header"]',
      '|===',
      '| 命令 | 说明',
      '| *demo pool add* _<name>_ | 添加成员',
      '| *demo route static* _<net>_ | 静态路由',
      '|===',
      '',
      '本节介绍 `demo pool mode` 的用法。',
    ].join('\n'),
  });
  const placed=produceAdocEntries(mapped(out),{name:'cli',catalog});assert.ok(placed.ok,JSON.stringify(placed));
  const result=placed;
  assert.deepEqual(result.entries.filter(entry=>entry.data.form==='signature'),[],'table markup is not paragraph structure');
  const mention=result.entries.find(entry=>entry.statement.includes('用法'))!;assert.deepEqual(mention.data.command_mentions,['demo pool mode']);assert.deepEqual(mention.data.command_literals,['demo pool mode']);
  const row=result.entries.find(entry=>entry.statement.includes('添加成员'))!;assert.equal(row.path,'/manual/cli/配置命令');assert.equal(row.fragments[0].selector,'l/8');
  assert.ok(result.entries.every(entry=>entry.fragments.every(fragment=>fragment.parser==='text@1'&&fragment.selector!=='')));

});

test('the mapped model is stable: the same input twice gives the same bytes', async () => {
  const files = { 'main.adoc': '= Book\n\n== A\n\ntext.\n\n== B\n\nifdef::brand-famx[]\nfamx only.\nendif::[]\n' };
  const first = await compile(files, 'main.adoc', { 'brand-famx': true });
  const second = await compile(files, 'main.adoc', { 'brand-famx': true });
  const a = JSON.stringify(mapped(first, 'cli'));
  const b = JSON.stringify(mapped(second, 'cli'));
  assert.equal(a, b);
});

test('a description list, marked list items, an admonition and a retained single-line conditional are placed', async () => {
  const out = await compile(
    {
      'main.adoc': [
        '= Book',                             // 1
        '',                                   // 2
        '== 参数',                             // 3
        '',                                   // 4
        'name:: 成员名称',                      // 5
        'weight:: 权重，取值 1 到 100',          // 6
        '',                                   // 7
        '* 使用 `demo pool add` 添加',          // 8
        '* {product} 支持热备',                 // 9
        "* Don't change it",                  // 10
        '',                                   // 11
        'NOTE: 需要管理员权限。',                // 12
        '',                                   // 13
        'ifdef::brand-famx[FAMX 独有的一行说明。]', // 14
        '',                                   // 15
      ].join('\n'),
    },
    'main.adoc',
    { product: 'FAMX', 'brand-famx': true },
  );
  const result = mapped(out);
  assert.ok(result.model.blocks.every((block) => typeof block.selector === 'string' && block.selector !== ''), 'every mapped block carries a citation');
  const produced = produceAdocEntries(result, { name: 'cli',catalog });
  assert.ok(produced.ok, JSON.stringify(produced));
  const placed = { entries: produced.entries, warnings: produced.warnings };
  assert.deepEqual(placed.warnings.filter(warning=>!warning.startsWith('适用条件统计：')), [], placed.warnings.join('；'));
  const statements = placed.entries.map((entry) => String(entry.statement));
  for (const text of ['name:: 成员名称', 'weight:: 权重，取值 1 到 100', 'demo pool add', '支持热备', 'change it', '需要管理员权限', 'FAMX 独有的一行说明']) {
    assert.ok(statements.some((statement) => statement.includes(text)), `${text} is missing from ${JSON.stringify(statements)}`);
  }
  // The description-list entry cites the one source line that holds both of its items.
  const described = placed.entries.find((entry) => String(entry.statement).startsWith('name::'));
  assert.ok(described !== undefined);
  assert.equal(described.fragments[0]!.parser, ADOC_PARSER);
  assert.equal(described.fragments[0]!.selector, 'l/5');
});

test('a block that cannot be cited stays out of the model and is reported with file, line and reason', async () => {
  const out = await compile({
    'main.adoc': [
      '= Book',        // 1
      '',              // 2
      '== 说明',        // 3
      '',              // 4
      '第一段说明。',    // 5
      '',              // 6
      '* 一个列表项',    // 7
      '',              // 8
      '第二段说明。',    // 9
      '',              // 10
    ].join('\n'),
  });
  // Constructed: step one verified every block of this group, so a block with no citation is made here to test what the
  // mapping does with one (it must not hand K1 a block without a selector: K1 counts it as malformed and skips it).
  const model = structuredClone(out.model);
  const target = model.blocks.find((block) => block.raw === '第二段说明。');
  assert.ok(target !== undefined);
  target.origins = [];
  target.origin = null;
  target.unverifiedReason = '构造的缺口：这个块回核不到原文行';
  const result = toK1Model(model, out.composition, 'cli');
  assert.ok(result.model.blocks.every((block) => typeof block.selector === 'string' && block.selector !== ''), 'no block is mapped without a citation');
  assert.equal(result.model.blocks.some((block) => block.text === '第二段说明。'), false, 'an uncited block is not placed');
  assert.ok(result.model.blocks.some((block) => block.text === '第一段说明。'), 'the blocks that are cited stay');
  assert.deepEqual(
    result.uncited.map((one) => ({ kind: one.kind, file: one.file, line: one.line, reason: one.reason !== '', next_action: one.next_action !== '' })),
    [{ kind: 'paragraph', file: 'main.adoc', line: 9, reason: true, next_action: true }],
    JSON.stringify(result.uncited),
  );
  const placed = produceManualEntries(result.model, null, { name: 'cli',catalog });
  assert.deepEqual(placed.warnings.filter(warning=>!warning.startsWith('适用条件统计：')), [], 'K1 sees no malformed block, so it counts none');
  assert.equal(placed.entries.some((entry) => String(entry.statement).includes('第二段说明')), false);
  assert.ok(result.warnings.some((warning) => warning.includes('回核不到原文行') && warning.includes('main.adoc:9')), result.warnings.join('；'));
});

test('a block whose verified lines are not contiguous becomes one block per range, each citing its own lines', async () => {
  const source = [
    '= Book',                    // 1
    '',                          // 2
    '== 说明',                    // 3
    '',                          // 4
    '第一行说明。',                // 5
    'ifdef::brand-famx[]',         // 6
    'FAMX 独有的第二行。',          // 7
    'endif::[]',                  // 8
    '第三行说明。',                // 9
    '',                          // 10
  ].join('\n');
  const out = await compile({ 'main.adoc': source }, 'main.adoc', { 'brand-famx': true });
  const paragraph = out.model.blocks.find((block) => block.kind === 'paragraph');
  assert.ok(paragraph !== undefined);
  assert.deepEqual(paragraph.origins.map((origin) => origin.selector), ['l/5', 'l/7', 'l/9'], 'step one verified three ranges, not one');
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual',catalog });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(
    produced.entries.map((entry) => [String(entry.statement), entry.fragments.map((fragment) => fragment.selector)]),
    [
      ['第一行说明。', ['l/5']],
      ['FAMX 独有的第二行。', ['l/7']],
      ['第三行说明。', ['l/9']],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.fragments])),
  );
  // Every cited line holds the words of the entry that cites it — the brand line decision 35 is about is among them.
  const lines = source.split('\n');
  for (const entry of produced.entries) {
    const line = lines[Number(entry.fragments[0]!.selector.slice(2)) - 1]!;
    assert.ok(line.includes(String(entry.statement)), `${JSON.stringify(entry.statement)} is not on ${JSON.stringify(line)}`);
  }
});

test('a paragraph that runs across an include boundary cites each chapter file for its own part', async () => {
  const out = await compile(
    {
      'book.adoc': '= Book\n\ninclude::a.adoc[]\ninclude::b.adoc[]\n',
      'a.adoc': '甲文件的最后一行。\n',
      'b.adoc': '乙文件的第一行。\n',
    },
    'book.adoc',
  );
  const paragraph = out.model.blocks.find((block) => block.kind === 'paragraph');
  assert.ok(paragraph !== undefined);
  assert.deepEqual(paragraph.origins.map((origin) => `${origin.file}:${origin.selector}`), ['a.adoc:l/1', 'b.adoc:l/1']);
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual',catalog });
  assert.ok(produced.ok, JSON.stringify(produced));
  const digests = Object.fromEntries(mapped.model.blocks.map((block) => [block.cite.file, block.cite.sha256]));
  assert.deepEqual(
    produced.entries.map((entry) => [String(entry.statement), entry.fragments[0]!.selector, entry.fragments[0]!.source === digests[entry.statement.includes('甲') ? 'a.adoc' : 'b.adoc']]),
    [
      ['甲文件的最后一行。', 'l/1', true],
      ['乙文件的第一行。', 'l/1', true],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.fragments])),
  );
});

test('a report names the chapter file and that file\'s own line, not the line of the expanded text', async () => {
  const out = await compile({
    'book.adoc': '= Synthetic\n\ninclude::ch1.adoc[]\n\ninclude::ch2.adoc[]\n',
    'ch1.adoc': '== 第一章\n\n第一节正文。\n',
    // A checklist item: the engine drops the `[x]` mark, so no source line folds to the item's text and it is reported.
    'ch2.adoc': '== 第二章\n\n* [x] 保存配置\n\n第二节正文。\n',
  }, 'book.adoc');
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.equal(mapped.uncited.length, 1, JSON.stringify(mapped.uncited));
  const uncited = mapped.uncited[0]!;
  assert.equal(uncited.file, 'ch2.adoc');
  assert.equal(uncited.line, 3, 'the chapter\'s own line, which is what a reader opens');
  assert.equal(uncited.expanded_line, 9, 'the line of the expanded text is kept apart, for the line map and step one\'s report');
  assert.notEqual(uncited.line, uncited.expanded_line, 'the two line numbers are not the same in an included chapter');
  assert.ok(mapped.warnings.some((warning) => warning.includes('ch2.adoc:3') && !warning.includes('ch2.adoc:9')), mapped.warnings.join('；'));
  // What is cited is placed, and the entries of the chapter keep their own paths.
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual',catalog });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(
    produced.entries.map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
    [
      ['第一节正文。', '/manual/cli/第一章', 'l/3'],
      ['第二节正文。', '/manual/cli/第二章', 'l/5'],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.path, entry.fragments])),
  );
});

test('a statement carries the reader spelling: a hard break is a line break, and an admonition or quote gives its words', async () => {
  const out = await compile(
    {
      'main.adoc': [
        '= Book',                              // 1
        '',                                    // 2
        '== 说明',                              // 3
        '',                                    // 4
        '第一行 +',                             // 5
        '第二行。',                             // 6
        '',                                    // 7
        '[%hardbreaks]',                       // 8
        '甲行',                                 // 9
        '乙行',                                 // 10
        '',                                    // 11
        'NOTE: 执行 *demo pool add* 前先保存。',  // 12
        '',                                    // 13
        '[quote]',                             // 14
        '执行 *demo pool del* 前先保存。',        // 15
        '',                                    // 16
      ].join('\n'),
    },
    'main.adoc',
  );
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual',catalog });
  assert.ok(produced.ok, JSON.stringify(produced));
  const statements = produced.entries.map((entry) => String(entry.statement));
  assert.ok(statements.includes('第一行\n第二行。'), JSON.stringify(statements));
  assert.ok(statements.includes('甲行\n乙行'), JSON.stringify(statements));
  assert.ok(!statements.some((statement) => statement.includes('<br>')), JSON.stringify(statements));
  assert.ok(!statements.some((statement) => statement.includes('<strong>')), JSON.stringify(statements));
  // The same words in an admonition and in a quote give the same reader spelling as in a paragraph, so K1 records the
  // command literal a read-time link resolves (K05 R[2]).
  const note = produced.entries.find((entry) => String(entry.statement) === '执行 **demo pool add** 前先保存。');
  assert.ok(note !== undefined, JSON.stringify(statements));
  assert.deepEqual(note.data.command_literals, ['demo pool add']);
  assert.equal(note.fragments[0]!.selector, 'l/12');
  const quote = produced.entries.find((entry) => String(entry.statement) === '执行 **demo pool del** 前先保存。');
  assert.ok(quote !== undefined, JSON.stringify(statements));
  assert.deepEqual(quote.data.command_literals, ['demo pool del']);
  assert.equal(quote.fragments[0]!.selector, 'l/15');
  // The hard-broken paragraph still cites the two lines it was verified on, one fragment for both.
  const broken = produced.entries.find((entry) => String(entry.statement) === '第一行\n第二行。');
  assert.ok(broken !== undefined);
  assert.equal(broken.fragments[0]!.selector, 'l/5-6');
});

test('a single-line comment inside a block is not content, and a comment inside a listing stays verbatim', async () => {
  const out = await compile(
    {
      'main.adoc': [
        '= Book',                 // 1
        '',                       // 2
        '== 说明',                 // 3
        '',                       // 4
        '第一行。',                // 5
        '// 作者的注释',           // 6
        '第二行。',                // 7
        '',                       // 8
        '----',                   // 9
        'demo one',               // 10
        '// 这不是注释，是内容',     // 11
        '----',                   // 12
        '',                       // 13
      ].join('\n'),
    },
    'main.adoc',
  );
  const paragraph = out.model.blocks.find((block) => block.kind === 'paragraph');
  assert.ok(paragraph !== undefined);
  assert.deepEqual(paragraph.origins.map((origin) => origin.selector), ['l/5', 'l/7'], 'the reader drops the comment line, so the block cites the lines on either side');
  assert.equal(out.report.unverified_count, 0, JSON.stringify(out.report.unverified));
  const listing = out.model.blocks.find((block) => block.kind === 'listing');
  assert.ok(listing !== undefined);
  assert.equal(listing.raw, 'demo one\n// 这不是注释，是内容', 'a listing is verbatim: its comment line is content');
  assert.deepEqual(listing.origins.map((origin) => origin.selector), ['l/10-11']);
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual',catalog });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(
    produced.entries.map((entry) => [String(entry.statement), entry.fragments[0]!.selector]),
    [
      ['第一行。', 'l/5'],
      ['第二行。', 'l/7'],
      ['demo one\n// 这不是注释，是内容', 'l/10-11'],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.fragments])),
  );
});

test('splitting a block by its source ranges does not make a signature the author never wrote', async () => {
  // One paragraph of two lines, its first line only a bold command: as one block K1 reads no anchor (the text spans
  // lines), so however its source ranges fall, no definition may appear and nothing may hang under a command.
  const cases: Array<[string, Record<string, string>, string]> = [
    ['one file, one range', { 'main.adoc': '= Book\n\n== 命令\n\n*demo pool add*\n这只是段内说明，不是独立签名。\n' }, 'main.adoc'],
    ['two files, no blank line between the includes', { 'main.adoc': '= Book\n\ninclude::a.adoc[]\ninclude::b.adoc[]\n', 'a.adoc': '*demo pool add*\n', 'b.adoc': '这只是段内说明，不是独立签名。\n' }, 'main.adoc'],
    ['a retained branch inside the paragraph', { 'main.adoc': '= Book\n\n== 命令\n\n*demo pool add*\nifdef::brand-famx[]\n这只是段内说明，不是独立签名。\nendif::[]\n' }, 'main.adoc'],
    ['a comment line inside the paragraph', { 'main.adoc': '= Book\n\n== 命令\n\n*demo pool add*\n// 作者的注释\n这只是段内说明，不是独立签名。\n' }, 'main.adoc'],
  ];
  for (const [label, files, main] of cases) {
    const out = await compile(files, main, { 'brand-famx': true });
    const mapped = toK1Model(out.model, out.composition, 'cli');
    assert.deepEqual(mapped.uncited, [], `${label}: ${JSON.stringify(mapped.uncited)}`);
    const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual',catalog });
    assert.ok(produced.ok, `${label}: ${JSON.stringify(produced)}`);
    assert.deepEqual(produced.entries.filter((entry) => entry.data.form === 'signature'), [], `${label}: ${JSON.stringify(produced.entries.map((entry) => [entry.data.form, entry.statement, entry.path]))}`);
    assert.ok(produced.entries.every((entry) => String(entry.path).startsWith('/manual/cli')), `${label}: ${JSON.stringify(produced.entries.map((entry) => entry.path))}`);
    // Every part cites its own range, and the words of both parts are in the knowledge.
    const statements = produced.entries.map((entry) => String(entry.statement));
    assert.ok(statements.some((statement) => statement.includes('demo pool add')), `${label}: ${JSON.stringify(statements)}`);
    assert.ok(statements.some((statement) => statement.includes('段内说明')), `${label}: ${JSON.stringify(statements)}`);
    assert.equal(
      new Set(produced.entries.map((entry) => `${entry.fragments[0]!.source}/${entry.fragments[0]!.selector}`)).size,
      produced.entries.length,
      `${label}: each part cites its own range of its own file`,
    );
  }
});

test('adoc forwards frozen closed vocabularies without turning prose into applicability declarations', async () => {
  const out = await compile({'main.adoc': '= Book\n\n== Outer 装有 Card-A 时\n\n内存至少8GB。\n\n=== Child\n\n普通正文。\n'});
  const produced = produceAdocEntries(mapped(out), {name:'cli',slot:'manual',components:['Card-A'],licenses:[],deployment_forms:[]});
  assert.ok(produced.ok, JSON.stringify(produced));
  const entry = produced.entries.find(row => row.statement === '普通正文。')!;
  assert.ok(entry);
  assert.equal(entry.applicability,null);
  assert.equal((entry.data.applicability_state as {declaration_status:string}).declaration_status,'undeclared');
  assert.deepEqual(entry.fragments.map(fragment=>fragment.selector),['l/9']);
  const changed=produceAdocEntries(mapped(out),{name:'cli',slot:'manual',components:['Card-B'],licenses:[],deployment_forms:[]});assert.ok(changed.ok);
  const other=changed.entries.find(row=>row.statement==='普通正文。')!;
  assert.notDeepEqual(other.data.applicability_state,entry.data.applicability_state,'the frozen closed vocabulary changes the criterion, never the prose judgment');
});
