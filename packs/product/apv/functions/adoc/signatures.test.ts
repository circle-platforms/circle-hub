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
import { catalogOnAdocLine, catalogRefusal, produceAdocEntries } from './entries.ts';
import type { CommandCatalog } from '../cases-commands.ts';
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
    'book.adoc': '= Book\n\n== 命令\n\n[role=signature]\n----\n*demo pool add* _<name> [weight]_\n----\n\n该命令用于添加成员。\n',
  });
  const signature = result.entries.find((entry) => entry.data.form === 'signature');
  assert.ok(signature !== undefined, JSON.stringify(result.entries.map((e) => [e.data.form, e.path])));
  assert.equal(signature.path, '/commands/demo/pool/add');
  assert.equal(String(signature.statement), 'demo pool add <name> [weight]');
  assert.deepEqual(
    (signature.data.params as Array<{ name: string; required: boolean }>).map((param) => [param.name, param.required]),
    [['name', true], ['weight', false]],
  );
});

test('every line of a signature block is read on its own, cited on its own line, and a line that reads as no signature is reported', async () => {
  const out = await compile({
    'book.adoc': [
      '= Book',                            // 1
      '',                                  // 2
      '== 命令',                            // 3
      '',                                  // 4
      '[role=signature]',                  // 5
      '----',                              // 6
      'demo pool add <name> [weight]',     // 7
      '*demo pool del* _<name>_',          // 8
      '',                                  // 9
      'demo pool timeout seconds',         // 10
      '配置成员池。',                        // 11
      '----',                              // 12
      '',                                  // 13
    ].join('\n'),
  });
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  // A blank line makes no entry, and no line is wrapped in marks the source does not have.
  assert.ok(
    produced.entries.every((entry) => !/^\*{3,}/.test(String(entry.statement)) && String(entry.statement) !== '****'),
    JSON.stringify(produced.entries.map((entry) => entry.statement)),
  );
  assert.deepEqual(
    produced.entries.filter((entry) => entry.data.form === 'signature').map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
    [
      ['demo pool add <name> [weight]', '/commands/demo/pool/add', 'l/7'],
      ['demo pool del <name>', '/commands/demo/pool/del', 'l/8'],
      ['demo pool timeout seconds', '/commands/demo/pool/timeout/seconds', 'l/10'],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.data.form, entry.statement, entry.fragments])),
  );
  assert.deepEqual(
    (produced.entries.find((entry) => entry.statement === 'demo pool add <name> [weight]')!.data.params as Array<{ name: string; required: boolean }>).map((param) => [param.name, param.required]),
    [['name', true], ['weight', false]],
    'a group is a parameter, not a variant of the command',
  );
  assert.equal(
    produced.entries.some((entry) => String(entry.statement) === 'demo pool del <name> [weight]'),
    false,
    'the second line is read on its own and does not inherit the first line’s parameter',
  );
  assert.deepEqual((produced.entries.find((entry) => entry.statement === 'demo pool del <name>')!.data.variants ?? null), null, 'no variants are invented for a plain line');
  // The line that reads as no signature stays the text it is, on its own line, and is reported with file, line, reason.
  assert.deepEqual(
    mapped.unparsed.map((one) => ({ file: one.file, line: one.line, text: one.text, reason: one.reason !== '', next_action: one.next_action !== '' })),
    [{ file: 'book.adoc', line: 11, text: '配置成员池。', reason: true, next_action: true }],
    JSON.stringify(mapped.unparsed),
  );
  const kept = produced.entries.find((entry) => String(entry.statement) === '配置成员池。');
  assert.ok(kept !== undefined, JSON.stringify(produced.entries.map((entry) => entry.statement)));
  assert.equal(kept.data.form, 'text');
  assert.equal(kept.fragments[0]!.selector, 'l/11');
  assert.ok(produced.warnings.some((warning) => warning.includes('读不成命令签名') && warning.includes('book.adoc:11')), produced.warnings.join('；'));
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

test('an example is reference only: its paragraphs, tables and signature blocks anchor no command', async () => {
  const result = await entriesOf({
    'book.adoc': [
      '= Book',                                       // 1
      '',                                             // 2
      '== 配置命令',                                    // 3
      '',                                             // 4
      '.示例',                                         // 5
      '====',                                         // 6
      '*demo probe run* _<target>_',                  // 7
      '',                                             // 8
      '输出如下。',                                     // 9
      '',                                             // 10
      '|===',                                          // 11
      '| *demo probe show* _<target>_ | 显示探测结果',   // 12
      '|===',                                          // 13
      '',                                             // 14
      '[role=signature]',                              // 15
      '----',                                          // 16
      'demo probe reset <target>',                     // 17
      '----',                                          // 18
      '====',                                          // 19
      '',                                             // 20
      '后面的普通段落。',                                // 21
      '',                                             // 22
      '[role=example]',                                // 23
      '----',                                          // 24
      'demo probe list <target>',                      // 25
      '----',                                          // 26
      '',                                             // 27
    ].join('\n'),
  });
  assert.deepEqual(result.entries.filter((entry) => entry.data.form === 'signature'), [], JSON.stringify(result.entries.map((entry) => [entry.data.form, entry.statement])));
  assert.ok(result.entries.every((entry) => String(entry.path) === '/manual/cli/配置命令'), JSON.stringify(result.entries.map((entry) => entry.path)));
  // The example's own words stay in the knowledge at their section node, and the paragraph after the example does not
  // follow a command from inside it.
  const statements = result.entries.map((entry) => String(entry.statement));
  for (const text of ['demo probe run', '输出如下', '显示探测结果', 'demo probe reset', '后面的普通段落', 'demo probe list']) {
    assert.ok(statements.some((statement) => statement.includes(text)), `${text} is missing from ${JSON.stringify(statements)}`);
  }
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

test('a signature block that verifies on no source line is reported and cites nothing', async () => {
  const out = await compile({
    'book.adoc': [
      '= Book',                    // 1
      '',                          // 2
      '== 命令',                    // 3
      '',                          // 4
      '说明如下。',                  // 5
      'demo pool add <name>',      // 6
      '[role=signature]',          // 7
      '----',                      // 8
      'demo pool add <name>',      // 9
      '----',                      // 10
      '',                          // 11
    ].join('\n'),
  });
  // The text the block holds stands on two lines inside the locator's neighbourhood and at neither of them the engine's
  // own cursor, so no line is proven for it: the block keeps empty origins and says why.
  const listing = out.model.blocks.find((block) => block.kind === 'listing');
  assert.ok(listing !== undefined);
  assert.deepEqual(listing.origins, []);
  assert.match(listing.unverifiedReason, /候选行不唯一/);
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.unparsed, [], 'a line that is not cited is never read as a signature');
  assert.deepEqual(
    mapped.uncited.map((one) => ({ kind: one.kind, file: one.file, line: one.line, reason: /候选行不唯一/.test(one.reason), next_action: one.next_action !== '' })),
    [{ kind: 'listing', file: 'book.adoc', line: 8, reason: true, next_action: true }],
    JSON.stringify(mapped.uncited),
  );
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(produced.entries.filter((entry) => entry.data.form === 'signature'), [], 'no signature is invented for an uncited block');
  // The paragraph that holds the same words is cited on its own lines, and K1 counts no malformed block.
  const prose = produced.entries.find((entry) => String(entry.statement).includes('demo pool add'));
  assert.ok(prose !== undefined, JSON.stringify(produced.entries.map((entry) => entry.statement)));
  assert.equal(prose.data.form, 'text');
  assert.equal(prose.fragments[0]!.selector, 'l/5-6');
  assert.deepEqual(produced.warnings.filter((warning) => /个块格式不对，已跳过/.test(warning)), [], 'K1 skips nothing: it was handed no block without a citation');
  assert.ok(produced.warnings.some((warning) => warning.includes('回核不到原文行') && warning.includes('book.adoc:8')), produced.warnings.join('；'));
});

test('a line with an adoc source refuses the transitional catalog by a typed reason, not by an empty production', () => {
  const catalog = { schema: 'ist.manual-command-catalog', product: 'apv', version: '10.7', signatures: [] };
  // The decision is made where the source is known — the adoc producer's own guard reads the slot's parser and schema —
  // and not inside K1's placement code, which reads a catalog whenever it is handed one.
  assert.equal(catalogOnAdocLine({ parser: 'json@1', model: catalog }), true);
  assert.equal(catalogOnAdocLine({ parser: 'markdown@1', model: { charset: 'utf-8', sections: [], blocks: [] } }), false, 'a markdown manual is not the transitional catalog');
  assert.equal(catalogOnAdocLine({ parser: 'json@1', model: { schema: 'other@1' } }), false, 'another json source is not it either');
  assert.equal(catalogOnAdocLine(null), false);
  assert.equal(catalogOnAdocLine(undefined), false);
  const refusal = catalogRefusal('APV');
  assert.equal(refusal.code, 'apv.adoc.catalog_reading_off');
  assert.ok(refusal.message.includes('名称族 APV') && refusal.message.includes('ist.manual-command-catalog'), refusal.message);
  // A real next action for a line that already has an adoc source: how the slot is changed, and what stays until then.
  assert.ok(refusal.next_action.includes('adoc 文件表') && refusal.next_action.includes('旧知识根不动'), refusal.next_action);
  assert.equal('entries' in refusal, false, 'a refusal carries no entries: it is not an empty production');
  assert.equal(catalogRefusal().message.includes('这一版本线'), true, 'without a family the line is named');
});

test('a signature line keeps the characters of its command words: only paired marks at token edges go', async () => {
  const result = await entriesOf({
    'book.adoc': [
      '= Book',                                    // 1
      '',                                          // 2
      '== 命令',                                    // 3
      '',                                          // 4
      '[role=signature]',                           // 5
      '----',                                       // 6
      'demo set max_conn <count>',                  // 7
      'demo health_check add <name>',               // 8
      'demo cipher add aes128+sha <name>',          // 9
      '*demo pool del* _<name>_',                   // 10
      '**demo pool add** *\\<name\\>*',              // 11
      '----',                                       // 12
      '',                                          // 13
      '[cols="2,3",options="header"]',               // 14
      '|===',                                        // 15
      '| 命令 | 说明',                                // 16
      '| *demo health_check show* _<name>_ | 显示',   // 17
      '|===',                                        // 18
      '',                                          // 19
    ].join('\n'),
  });
  const signatures = result.entries.filter((entry) => entry.data.form === 'signature');
  assert.deepEqual(
    signatures.map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
    [
      ['demo set max_conn <count>', '/commands/demo/set/max_conn', 'l/7'],
      ['demo health_check add <name>', '/commands/demo/health_check/add', 'l/8'],
      ['demo cipher add aes128+sha <name>', '/commands/demo/cipher/add/aes128+sha', 'l/9'],
      ['demo pool del <name>', '/commands/demo/pool/del', 'l/10'],
      ['demo pool add <name>', '/commands/demo/pool/add', 'l/11'],
      ['demo health_check show <name>', '/commands/demo/health_check/show', 'l/17'],
    ],
    JSON.stringify(signatures.map((entry) => [entry.statement, entry.path, entry.data.words])),
  );
  // The same command read from a signature block and from a command table row lands on the same node.
  const words = signatures.map((entry) => (entry.data.words as string[]).join(' '));
  assert.ok(words.includes('demo health_check add') && words.includes('demo health_check show'), JSON.stringify(words));
  assert.ok(!words.some((word) => word.includes('healthcheck') || word.includes('maxconn') || word.includes('aes128sha')), JSON.stringify(words));
});

test('example content is marked reference only, so a reader does not take it for a behaviour of the command before it', async () => {
  const result = await entriesOf({
    'book.adoc': [
      '= Book',                          // 1
      '',                                // 2
      '== 命令',                          // 3
      '',                                // 4
      '*demo probe* _<target>_',         // 5
      '',                                // 6
      '探测目标。',                        // 7
      '',                                // 8
      '.示例',                            // 9
      '====',                            // 10
      '*demo probe* _192.0.2.1_',        // 11
      '',                                // 12
      '输出如下。',                        // 13
      '====',                            // 14
      '',                                // 15
      '[role=example]',                   // 16
      '----',                             // 17
      'demo probe <target>',              // 18
      '----',                             // 19
      '',                                // 20
      '后面的普通段落。',                   // 21
      '',                                // 22
    ].join('\n'),
  });
  const marked = result.entries.filter((entry) => entry.data.reference_only === true).map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]);
  assert.deepEqual(
    marked,
    [
      ['**demo probe** *192.0.2.1*', '/commands/demo/probe', 'l/11'],
      ['输出如下。', '/commands/demo/probe', 'l/13'],
      ['demo probe <target>', '/commands/demo/probe', 'l/18'],
    ],
    JSON.stringify(result.entries.map((entry) => [entry.statement, entry.data])),
  );
  // The real behaviour, the signature and the paragraph after the example carry no such mark.
  for (const statement of ['探测目标。', 'demo probe <target>', '后面的普通段落。']) {
    const entry = result.entries.find((one) => String(one.statement) === statement && one.data.reference_only === undefined);
    assert.ok(entry !== undefined, `${statement} is not marked as an example`);
  }
  const signature = result.entries.find((entry) => entry.data.form === 'signature');
  assert.ok(signature !== undefined && signature.data.reference_only === undefined, JSON.stringify(signature?.data));
});

test('a spaced literal mark is no markup: such a line reads as no signature and is reported, not turned into a command', async () => {
  const out = await compile({
    'book.adoc': [
      '= Book',                          // 1
      '',                                // 2
      '== 命令',                          // 3
      '',                                // 4
      '[role=signature]',                 // 5
      '----',                             // 6
      'demo + pool + add <name>',         // 7
      'demo * cipher * add <name>',       // 8
      'demo _ route _ add <name>',        // 9
      'demo *pool* add <name>',           // 10
      'demo set max_conn <count>',        // 11
      '----',                             // 12
      '',                                // 13
    ].join('\n'),
  });
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  // The three spaced-mark lines are not markup, so they are not signatures: they are reported with their line and
  // reason, and stay the text they are — the source characters are not deleted to make a command word.
  assert.deepEqual(
    mapped.unparsed.map((one) => [one.file, one.line, one.text, one.reason !== '']),
    [
      ['book.adoc', 7, 'demo + pool + add <name>', true],
      ['book.adoc', 8, 'demo * cipher * add <name>', true],
      ['book.adoc', 9, 'demo _ route _ add <name>', true],
    ],
    JSON.stringify(mapped.unparsed),
  );
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual' });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(
    produced.entries.filter((entry) => entry.data.form === 'signature').map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
    [
      ['demo pool add <name>', '/commands/demo/pool/add', 'l/10'],
      ['demo set max_conn <count>', '/commands/demo/set/max_conn', 'l/11'],
    ],
    JSON.stringify(produced.entries.map((entry) => [entry.data.form, entry.statement, entry.path])),
  );
  assert.deepEqual(
    produced.entries.filter((entry) => entry.data.form !== 'signature').map((entry) => [String(entry.statement), entry.fragments[0]!.selector]),
    [
      ['demo + pool + add <name>', 'l/7'],
      ['demo * cipher * add <name>', 'l/8'],
      ['demo _ route _ add <name>', 'l/9'],
    ],
    'each line stays the words the source has, on its own line',
  );
  assert.ok(produced.warnings.some((warning) => warning.includes('读不成命令签名') && warning.includes('book.adoc:7')), produced.warnings.join('；'));
});

/** A synthetic command catalog of complete commands, in the shape K1's placement and drift checks read. */
const catalogOf = (commands: string[][]): CommandCatalog => {
  type Node = { children: Map<string, Node>; path: string | null };
  const root: Node = { children: new Map(), path: null };
  for (const words of commands) {
    let node = root;
    words.forEach((word, index) => {
      const key = word.toLowerCase();
      let next = node.children.get(key);
      if (next === undefined) {
        next = { children: new Map(), path: null };
        node.children.set(key, next);
      }
      if (index === words.length - 1) next.path = `/commands/${words.join('/')}`;
      node = next;
    });
  }
  return { root, heads: [...new Set(commands.map((words) => (words[0] ?? '').toLowerCase()))], size: commands.length } as unknown as CommandCatalog;
};

test('an example takes no part in judgment: its literal is no drift candidate, and the mark is disclosed', async () => {
  const out = await compile({
    'book.adoc': [
      '= Book',                            // 1
      '',                                  // 2
      '== 命令',                            // 3
      '',                                  // 4
      '*demo probe* _<target>_',           // 5
      '',                                  // 6
      '探测目标，另见 `demo ghost show`。',   // 7
      '',                                  // 8
      '.示例',                              // 9
      '====',                              // 10
      '先用 `demo ghost add` 建立目标。',     // 11
      '====',                              // 12
      '',                                  // 13
    ].join('\n'),
  });
  const mapped = toK1Model(out.model, out.composition, 'cli');
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual', catalog: catalogOf([['demo', 'probe']]) });
  assert.ok(produced.ok, JSON.stringify(produced));
  const examples = produced.entries.filter((entry) => entry.data.reference_only === true);
  assert.equal(examples.length, 1, JSON.stringify(produced.entries.map((entry) => [entry.statement, entry.data])));
  assert.deepEqual(examples[0]!.data.command_literals, ['demo ghost add']);
  // The example's literal is not a drift candidate of the manual; the same-shaped literal in real prose is.
  const drift = produced.warnings.filter((warning) => warning.includes('解析不到，是漂移候选'));
  assert.equal(drift.length, 1, produced.warnings.join('；'));
  assert.ok(drift[0]!.includes('demo ghost show'), drift[0]);
  assert.ok(!drift[0]!.includes('demo ghost add'), `an example takes no part in judgment: ${drift[0]}`);
  // The mark and what a consumer still has to do are said out loud.
  assert.ok(
    produced.warnings.some((warning) => warning.includes('data.reference_only') && warning.includes('分流')),
    produced.warnings.join('；'),
  );
  // The real behaviour of the command carries no such mark.
  const real = produced.entries.find((entry) => String(entry.statement).includes('探测目标'));
  assert.ok(real !== undefined && real.data.reference_only === undefined, JSON.stringify(real?.data));
  assert.deepEqual(real!.data.command_literals, ['demo ghost show']);
});

test('an escaped closing mark is a literal character: it stays in the line and the line reads as no signature', async () => {
  const lines = [
    '= Book',                       // 1
    '',                             // 2
    '== 命令',                       // 3
    '',                             // 4
    '[role=signature]',              // 5
    '----',                          // 6
    'demo *pool\\*_ add <name>',     // 7
    'demo +pool\\+_ add <name>',     // 8
    'demo #pool\\#_ add <name>',     // 9
    'demo `pool\\`_ add <name>',     // 10
    'demo *pool\\* add <name>',      // 11
    'demo *pool* add <name>',        // 12
    '----',                          // 13
    '',                             // 14
  ];
  const out = await compile({ 'book.adoc': lines.join('\n') });
  const mapped = toK1Model(out.model, out.composition, 'cli');
  assert.deepEqual(mapped.uncited, [], JSON.stringify(mapped.uncited));
  // The five escaped lines are no markup: their literal marks stay in the text, the words are no command words, and the
  // lines are reported instead of becoming a definition of a command the source does not have.
  assert.deepEqual(
    mapped.unparsed.map((one) => [one.file, one.line, one.text]),
    [
      ['book.adoc', 7, 'demo *pool\\*_ add <name>'],
      ['book.adoc', 8, 'demo +pool\\+_ add <name>'],
      ['book.adoc', 9, 'demo #pool\\#_ add <name>'],
      ['book.adoc', 10, 'demo `pool\\`_ add <name>'],
      ['book.adoc', 11, 'demo *pool\\* add <name>'],
    ],
    JSON.stringify(mapped.unparsed),
  );
  for (const withoutCatalog of [produceAdocEntries(mapped, { name: 'cli', slot: 'manual' }), produceAdocEntries(mapped, { name: 'cli', slot: 'manual', catalog: catalogOf([['demo', 'pool_', 'add'], ['demo', 'pool', 'add']]) })]) {
    assert.ok(withoutCatalog.ok, JSON.stringify(withoutCatalog));
    assert.deepEqual(
      withoutCatalog.entries.filter((entry) => entry.data.form === 'signature').map((entry) => [String(entry.statement), entry.path, entry.fragments[0]!.selector]),
      [['demo pool add <name>', '/commands/demo/pool/add', 'l/12']],
      'the unescaped line is still a signature, and a catalog that holds the fabricated command changes nothing',
    );
    assert.deepEqual(
      withoutCatalog.entries.filter((entry) => entry.data.form !== 'signature').map((entry) => [String(entry.statement), entry.fragments[0]!.selector]),
      [
        ['demo *pool\\*_ add <name>', 'l/7'],
        ['demo +pool\\+_ add <name>', 'l/8'],
        ['demo #pool\\#_ add <name>', 'l/9'],
        ['demo `pool\\`_ add <name>', 'l/10'],
        ['demo *pool\\* add <name>', 'l/11'],
      ],
      'a listing is verbatim: each line keeps the characters the source has, escapes included, on its own line',
    );
  }
});
