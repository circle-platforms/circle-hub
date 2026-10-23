// Tests of the adoc-to-K1 mapping (task kb-adoc item 4): the expanded model becomes a markdown@1-shaped model —
// sections from `=` levels, discrete headings marked, invalid `=======` not a heading, blocks carry their section
// paths and text@1 line selectors — and K1's produceManualEntries applies to it unchanged (placement, tables,
// literals). Synthetic adoc only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { toK1Model } from './k1-model.ts';
import { compileAdoc } from './index.ts';
import { produceManualEntries } from '../manual.ts';

const compile = async (files: Record<string, string>, main = 'main.adoc', attributes: Record<string, string | boolean> = {}): Promise<Extract<Awaited<ReturnType<typeof compileAdoc>>, { ok: true }>> => {
  const out = await compileAdoc({ main, revision: '42', attributes, files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: createHash('sha256').update(text).digest('hex') }])) });
  assert.ok(out.ok, JSON.stringify(out));
  return out;
};

test('the expanded model maps to the markdown@1 shape: sections, blocks, selectors and paths', async () => {
  const out = await compile({
    'main.adoc': '= Book\n\n== First\n\nintro text.\n\n=== Nested\n\nnested text.\n',
  });
  const model = toK1Model(out.model, out.composition, 'cli');
  assert.equal(model.sections.length, 3, 'the document section plus First and Nested (the `= Book` title is the document itself, no extra section)');
  assert.equal(model.sections[1]!.title, 'First');
  assert.equal(model.sections[2]!.title, 'Nested');
  const nested = model.blocks.find((b: { text: string }) => b.text === 'nested text.');
  assert.ok(nested !== undefined);
  assert.deepEqual(nested.path, ['First', 'Nested'], 'the heading path rides along');
  assert.match(nested.selector ?? '', /^src:[0-9a-f]{64}\/text@1\/l\/9$/, 'the nested paragraph cites its verified source line');
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
  const model = toK1Model(out.model, out.composition, 'cli');
  const discrete = model.blocks.find((b: { kind: string }) => b.kind === 'discrete_heading');
  assert.ok(discrete !== undefined && discrete.kind === 'discrete_heading', JSON.stringify(model.blocks.map((b: { kind: string }) => b.kind)));
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
  const model = toK1Model(out.model, out.composition, 'cli');
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
  const a = JSON.stringify(toK1Model(first.model, first.composition, 'cli'));
  const b = JSON.stringify(toK1Model(second.model, second.composition, 'cli'));
  assert.equal(a, b);
});
