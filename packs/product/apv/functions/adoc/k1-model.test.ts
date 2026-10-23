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
import { produceManualEntries } from '../manual.ts';
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

test('K1 placement applies unchanged: signatures, table rows and literals from the adoc model', async () => {
  const out = await compile({
    'main.adoc': [
      '= Book',
      '',
      '== 配置命令',
      '',
      '|===',
      '| 命令 | 说明',
      '| **demo pool add** *\\<name\\>* | 添加成员 |',
      '| **demo route static** *\\<net\\>* | 静态路由 |',
      '|===',
      '',
      '本节介绍 `demo pool mode` 的用法。',
    ].join('\n'),
  });
  const model = mapped(out).model;
  const result = produceManualEntries(model, null, { name: 'cli' });
  const forms = result.entries.map((entry) => [entry.data.form, entry.path]);
  assert.ok(forms.some(([form, path]) => form === 'signature' && path === '/commands/demo/pool/add'), JSON.stringify(forms));
  assert.ok(forms.some(([form, path]) => form === 'signature' && path === '/commands/demo/route/static'), JSON.stringify(forms));
  const mention = result.entries.find((entry) => String(entry.statement).includes('用法'));
  assert.ok(mention !== undefined && (mention.data.command_literals as string[]).includes('demo pool mode'), 'prose literals ride along');
  const rowText = result.entries.find((entry) => String(entry.statement).includes('添加成员'));
  assert.ok(rowText !== undefined && rowText.path === '/commands/demo/pool/add', 'the row text follows its command');
  assert.ok(result.entries.every((entry) => (entry.fragments[0].parser ?? '') !== '' && entry.fragments[0].selector !== ''), 'every entry cites a fragment');
});

test('the mapped model is stable: the same input twice gives the same bytes', async () => {
  const files = { 'main.adoc': '= Book\n\n== A\n\ntext.\n\n== B\n\nifdef::brand-apv[]\napv only.\nendif::[]\n' };
  const first = await compile(files, 'main.adoc', { 'brand-apv': true });
  const second = await compile(files, 'main.adoc', { 'brand-apv': true });
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
        'ifdef::brand-apv[APV 独有的一行说明。]', // 14
        '',                                   // 15
      ].join('\n'),
    },
    'main.adoc',
    { product: 'APV', 'brand-apv': true },
  );
  const result = mapped(out);
  assert.ok(result.model.blocks.every((block) => typeof block.selector === 'string' && block.selector !== ''), 'every mapped block carries a citation');
  const produced = produceAdocEntries(result, { name: 'cli' });
  assert.ok(produced.ok, JSON.stringify(produced));
  const placed = { entries: produced.entries, warnings: produced.warnings };
  assert.deepEqual(placed.warnings, [], placed.warnings.join('；'));
  const statements = placed.entries.map((entry) => String(entry.statement));
  for (const text of ['name:: 成员名称', 'weight:: 权重，取值 1 到 100', 'demo pool add', '支持热备', 'change it', '需要管理员权限', 'APV 独有的一行说明']) {
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
  const placed = produceManualEntries(result.model, null, { name: 'cli' });
  assert.deepEqual(placed.warnings, [], 'K1 sees no malformed block, so it counts none');
  assert.equal(placed.entries.some((entry) => String(entry.statement).includes('第二段说明')), false);
  assert.ok(result.warnings.some((warning) => warning.includes('回核不到原文行') && warning.includes('main.adoc:9')), result.warnings.join('；'));
});
