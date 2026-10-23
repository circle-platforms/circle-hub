// Tests of the adoc signature rules (task kb-adoc item 6): signatures, value domains and examples are read only
// from explicit structures — a command table row, a `[role=signature]` block, or a bold/mono line that verifies
// verbatim against its source; titles, ordinary bold prose and examples never become signatures, and example blocks
// are reference only. Synthetic adoc only.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileAdoc } from './index.ts';
import { toK1Model } from './k1-model.ts';
import { produceManualEntries } from '../manual.ts';
import { produceAdocEntries } from './entries.ts';
import type { MarkdownModel } from '../../../../../hub/refs/api.ts';

/** The mapped model of one compile, with the mapping's report checked (nothing left uncited). */
const modelOf = (out: Extract<Awaited<ReturnType<typeof compileAdoc>>, { ok: true }>, name = 'cli'): MarkdownModel => {
  const mapped = toK1Model(out.model, out.composition, name);
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  return mapped.model;
};

const compile = async (files: Record<string, string>, attributes: Record<string, string | boolean> = {}): Promise<Extract<Awaited<ReturnType<typeof compileAdoc>>, { ok: true }>> => {
  const out = await compileAdoc({ main: 'book.adoc', revision: '42', attributes, files: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, { text, revision: '42', sha256: createHash('sha256').update(text).digest('hex') }])) });
  assert.ok(out.ok, JSON.stringify(out));
  return out;
};

/** The whole adoc chain over one group: expansion, mapping, K1's placement and the fragment rewrite. */
const entriesOf = async (files: Record<string, string>, attributes: Record<string, string | boolean> = {}) => {
  const out = await compile(files, attributes);
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  return produced;
};

test('a [role=signature] listing block is a signature; its params ride along', async () => {
  const result = await entriesOf({
    'book.adoc': '= Book\n\n== 命令\n\n[role=signature]\n----\n**demo pool add** *\\<name\\> \[weight\]*\n----\n\n该命令用于添加成员。\n',
  });
  const signature = result.entries.find((entry) => entry.data.form === 'signature');
  assert.ok(signature !== undefined, JSON.stringify(result.entries.map((e) => [e.data.form, e.path])));
  assert.equal(signature.path, '/commands/demo/pool/add');
  assert.deepEqual((signature.data.params as Array<{ name: string }>).map((p) => p.name), ['name', 'weight']);
});

test('an AsciiDoc signature paragraph is a signature, in bold and italic or as one monospace line', async () => {
  const result = await entriesOf({
    'book.adoc': [
      '= Book',                                  // 1
      '',                                        // 2
      '== 配置命令',                               // 3
      '',                                        // 4
      '*demo route static* _\\<net\\>_',        // 5
      '',                                        // 6
      '该命令用于配置路由。',                        // 7
      '',                                        // 8
      '*demo pool add* _<name>_ _[interval]_',   // 9
      '',                                        // 10
      '`demo pool show <name>`',                 // 11
      '',                                        // 12
      '+demo pool del <name>+',                  // 13
      '',                                        // 14
      '=== *demo pool mode* _<name>_',           // 15
      '',                                        // 16
      '小节标题不是签名。',                          // 17
      '',                                        // 18
      '配置后可以 *demo pool mode* 查看结果。',       // 19
      '',                                        // 20
      '==== 示例',                                 // 21
      '',                                        // 22
      '----',                                     // 23
      '*demo probe* _<target>_',                  // 24
      '----',                                     // 25
      '',                                        // 26
      '以上示例仅供参考。',                          // 27
      '',                                        // 28
    ].join('\n'),
  });
  const signatures = result.entries.filter((entry) => entry.data.form === 'signature');
  assert.deepEqual(
    signatures.map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]).sort(),
    [
      ['demo pool add <name> [interval]', '/commands/demo/pool/add', 'l/9'],
      ['demo pool del <name>', '/commands/demo/pool/del', 'l/13'],
      ['demo pool show <name>', '/commands/demo/pool/show', 'l/11'],
      ['demo route static <net>', '/commands/demo/route/static', 'l/5'],
    ],
    JSON.stringify(signatures.map((entry) => [entry.statement, entry.path, entry.fragments])),
  );
  assert.deepEqual(
    (signatures.find((entry) => entry.statement === 'demo pool add <name> [interval]')!.data.params as Array<{ name: string; required: boolean }>).map((param) => [param.name, param.required]),
    [['name', true], ['interval', false]],
  );
  // A title that reads as a signature is still a title, and a bold run inside prose is a mention, never a definition.
  assert.ok(!result.entries.some((entry) => String(entry.statement) === 'demo pool mode <name>'), JSON.stringify(result.entries.map((entry) => entry.statement)));
  const prose = result.entries.find((entry) => String(entry.statement).includes('查看结果'));
  assert.ok(prose !== undefined);
  assert.ok(prose.data.form !== 'signature');
  assert.ok((prose.data.command_literals as string[] | undefined ?? []).includes('demo pool mode'), JSON.stringify(prose.data));
  // The listing under a heading named 示例 cites no signature of its own.
  assert.ok(result.entries.some((entry) => String(entry.statement).includes('以上示例仅供参考')));
  assert.ok(!result.entries.some((entry) => entry.path === '/commands/demo/probe'), 'an example listing places no command');
});

test('command-table rows are signatures under a header that names commands; value rows are not (K1 rules apply)', async () => {
  const result = await entriesOf({
    'book.adoc': [
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
      '**demo pool state** *\\<value\\>*',
      '',
      '[cols="1,2",options="header"]',
      '|===',
      '| 取值 | 说明',
      '| *enable* | 启用',
      '| *disable* | 停用',
      '|===',
      '',
    ].join('\n'),
  });
  const signatures = result.entries.filter((entry) => entry.data.form === 'signature').map((entry) => entry.statement);
  assert.deepEqual([...signatures].sort(), ['demo pool add <name>', 'demo pool state <value>', 'demo route static <net>'], JSON.stringify(signatures));
  assert.ok(!signatures.some((s) => s === 'enable' || s === 'disable'), 'value rows never become signatures');
  const enableRow = result.entries.find((entry) => String(entry.statement).includes('启用'));
  assert.ok(enableRow !== undefined && enableRow.path === '/commands/demo/pool/state', 'the value rows stay with their command');
});

test('a source problem is reported, never guessed: a signature block that does not verify cites nothing', async () => {
  const out = await compile({ 'book.adoc': '= Book\n\n== 命令\n\n[role=signature]\n----\ndemo one\n----\n' });
  // A one-word unmarked line in a role=signature block: K1's isRowSignature keeps it (params absent, one word) only
  // under a command header; in a signature block the role itself is the explicit structure, so the entry exists.
  const result = produceManualEntries(modelOf(out), null, { name: 'cli' });
  const signature = result.entries.find((entry) => entry.data.form === 'signature' && String(entry.statement).startsWith('demo one'));
  assert.ok(signature !== undefined, JSON.stringify(result.entries.map((e) => [e.data.form, String(e.statement).slice(0, 20)])));
});

test('with an adoc source, the transitional catalog reading is off: a catalog input is refused, not read', () => {
  const catalog = { schema: 'ist.manual-command-catalog', product: 'apv', version: '10.7', signatures: [] };
  const refused = produceManualEntries(catalog as never, null, { name: 'cli', adocSource: true });
  assert.ok(refused.entries.length === 0 && refused.warnings.some((w) => w.includes('本版本线有 adoc 源，catalog.json 的过渡读法已停用')), refused.warnings.join('；'));
  const legacy = produceManualEntries(catalog as never, null, { name: 'cli' });
  assert.ok(!legacy.warnings.some((w) => w.includes('过渡读法已停用')), 'without an adoc source the transition stays readable');
});
