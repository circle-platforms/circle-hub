// Tests of the adoc signature rules (task kb-adoc item 6): signatures, value domains and examples are read only
// from explicit structures — a command table row, a `[role=signature]` block, or a bold/mono line that verifies
// verbatim against its source; titles, ordinary bold prose and examples never become signatures, and example blocks
// are reference only. Synthetic adoc only.
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relationFacts } from '../../../../../hub/knowledge/api.ts';
import { ProductDeclaration } from '../../../../../contracts/src/product.ts';
import declaration from '../../product.json' with { type: 'json' };
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
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual', catalog: catalogOf([['demo','pool','add'],['demo','pool','del'],['demo','pool','show'],['demo','pool','mode'],['demo','pool','state'],['demo','route','static'],['demo','probe']]) });
  assert.ok(produced.ok, JSON.stringify(produced));
  return produced;
};

test('a legacy signature-role listing stays verbatim chapter content with no parameter claims', async () => {
  const result = await entriesOf({
    'book.adoc': '= Book\n\n== 命令\n\n[role=signature]\n----\n*demo pool add* _<name> [weight]_\n----\n\n该命令用于添加成员。\n',
  });
  assert.deepEqual(result.entries.filter(entry=>entry.data.form==='signature'),[]);
  assert.ok(result.entries.some(entry=>entry.statement==='*demo pool add* _<name> [weight]_'));
  assert.ok(result.entries.every(entry=>entry.path?.startsWith('/manual/cli')));
});

test('legacy signature-role lines retain exact text and per-line citations without definitions', async () => {
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
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual', catalog: catalogOf([['demo','pool','add'],['demo','pool','del'],['demo','pool','show'],['demo','pool','mode'],['demo','pool','state'],['demo','route','static'],['demo','probe']]) });
  assert.ok(produced.ok, JSON.stringify(produced));
  assert.deepEqual(produced.entries.filter(entry=>entry.data.form==='signature'),[]);
  assert.deepEqual(produced.entries.map(entry=>[entry.statement,entry.fragments[0]!.selector]),[
    ['demo pool add <name> [weight]','l/7'],['*demo pool del* _<name>_','l/8'],['demo pool timeout seconds','l/10'],['配置成员池。','l/11'],
  ]);
  assert.deepEqual(mapped.unparsed,[],'a listing is not a signature candidate');
});

test('strong and emphasis paragraphs define exact tree paths while monospace and headings stay references', async () => {
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
      '*demo pool add* _<name> [interval]_',   // 9
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
      ['demo route static \\<net\\>', '/commands/demo/route/static', 'l/5'],
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

test('command and value tables stay cited chapter rows while a standalone signature paragraph defines its path', async () => {
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
      '*demo pool state* _<value>_',
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
  assert.deepEqual([...signatures].sort(), ['demo pool state <value>'], JSON.stringify(signatures));
  assert.ok(!signatures.some((s) => s === 'enable' || s === 'disable'), 'value rows never become signatures');
  const enableRow = result.entries.find((entry) => String(entry.statement).includes('启用'));
  assert.ok(enableRow !== undefined && enableRow.path?.startsWith('/manual/cli'), 'table rows retain their chapter citation and never invent command ownership');
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
  const produced = produceAdocEntries(mapped, { name: 'cli', slot: 'manual', catalog: catalogOf([['demo','pool','add'],['demo','pool','del'],['demo','pool','show'],['demo','pool','mode'],['demo','pool','state'],['demo','route','static'],['demo','probe']]) });
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
  const catalog = { schema: 'ist.manual-command-catalog', product: 'famx', version: '10.7', signatures: [] };
  // The decision is made where the source is known — the adoc producer's own guard reads the slot's parser and schema —
  // and not inside K1's placement code, which reads a catalog whenever it is handed one.
  assert.equal(catalogOnAdocLine({ parser: 'json@1', model: catalog }), true);
  assert.equal(catalogOnAdocLine({ parser: 'markdown@1', model: { charset: 'utf-8', sections: [], blocks: [] } }), false, 'a markdown manual is not the transitional catalog');
  assert.equal(catalogOnAdocLine({ parser: 'json@1', model: { schema: 'other@1' } }), false, 'another json source is not it either');
  assert.equal(catalogOnAdocLine(null), false);
  assert.equal(catalogOnAdocLine(undefined), false);
  const refusal = catalogRefusal('FAMX');
  assert.equal(refusal.code, 'famx.adoc.catalog_reading_off');
  assert.ok(refusal.message.includes('名称族 FAMX') && refusal.message.includes('ist.manual-command-catalog'), refusal.message);
  // A real next action for a line that already has an adoc source: how the slot is changed, and what stays until then.
  assert.ok(refusal.next_action.includes('adoc 文件表') && refusal.next_action.includes('旧知识根不动'), refusal.next_action);
  assert.equal('entries' in refusal, false, 'a refusal carries no entries: it is not an empty production');
  assert.equal(catalogRefusal().message.includes('这一版本线'), true, 'without a family the line is named');
});

test('listing and table words preserve underscores, plus signs and escaping without invented command paths', async () => {
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
  assert.deepEqual(result.entries.filter(entry=>entry.data.form==='signature'),[]);
  for(const [text,line] of [['demo set max_conn <count>','l/7'],['demo health_check add <name>','l/8'],['demo cipher add aes128+sha <name>','l/9'],['*demo pool del* _<name>_','l/10'],['**demo pool add** *\\<name\\>*','l/11']]){
    assert.ok(result.entries.some(entry=>entry.statement===text&&entry.fragments[0]!.selector===line));
  }
  assert.ok(result.entries.some(entry=>entry.statement.includes('demo health_check show')&&entry.fragments[0]!.selector==='l/17'));
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
      ['**demo probe** *192.0.2.1*', '/manual/cli/命令', 'l/11'],
      ['输出如下。', '/manual/cli/命令', 'l/13'],
      ['demo probe <target>', '/manual/cli/命令', 'l/18'],
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

test('spaced and inline marks in a listing remain exact source characters', async () => {
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
  assert.deepEqual(mapped.unparsed,[],'listing content is not reclassified as a paragraph signature');
  const produced=produceAdocEntries(mapped,{name:'cli',slot:'manual'});assert.ok(produced.ok,JSON.stringify(produced));
  assert.deepEqual(produced.entries.filter(entry=>entry.data.form==='signature'),[]);
  assert.deepEqual(produced.entries.map(entry=>[entry.statement,entry.fragments[0]!.selector]),[
    ['demo + pool + add <name>','l/7'],['demo * cipher * add <name>','l/8'],['demo _ route _ add <name>','l/9'],['demo *pool* add <name>','l/10'],['demo set max_conn <count>','l/11'],
  ]);
});

/** A synthetic command catalog of complete commands, in the shape K1's placement and drift checks read. */
const catalogOf = (commands: string[][]): CommandCatalog => {
  type Node = { children: Map<string, Node>; path: string | null };
  const root: Node = { children: new Map(), path: null };
  for (const words of commands) {
    let node = root;
    words.forEach((word, index) => {
      const key = word;
      let next = node.children.get(key);
      if (next === undefined) {
        next = { children: new Map(), path: null };
        node.children.set(key, next);
      }
      if (index === words.length - 1) next.path = `/commands/${words.join('/')}`;
      node = next;
    });
  }
  return { root, heads: [...new Set(commands.map((words) => words[0] ?? ''))], size: commands.length } as unknown as CommandCatalog;
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
  const rules = ProductDeclaration.parse(declaration).links!;
  const definition = Object.assign(new Set(['definition']), { producersByKind: new Map([['definition', new Set(['command-tree'])]]) });
  const nodes = new Map<string, Set<string>>([
    ['/commands', new Set()], ['/commands/demo', new Set()], ['/commands/demo/probe', definition],
  ]);
  const sources = produced.entries.map((entry, index) => ({
    path: entry.path ?? '/', unplaced: entry.path === null, entry: createHash('sha256').update(String(index)).digest('hex'), producers: ['manual-famx'],
    content: { kind: entry.kind, statement: String(entry.statement), data: entry.data, applicability: entry.applicability ?? null },
  }));
  const facts = relationFacts('a'.repeat(64), rules, nodes, sources);
  assert.deepEqual(facts.drift.map(row => row.literal), []);
  assert.ok(!facts.links.some(row => row.literal === 'demo ghost add'));
  // Matching targets must not turn an example into a link either.
  nodes.set('/commands/demo/ghost', new Set()); nodes.set('/commands/demo/ghost/add', definition);
  const withExampleTarget = relationFacts('a'.repeat(64), rules, nodes, sources);
  assert.ok(!withExampleTarget.links.some(row => row.literal === 'demo ghost add'));
  assert.deepEqual(withExampleTarget.drift.map(row => row.literal), []);
  assert.equal(Object.hasOwn(examples[0]!.data, 'command_literals'), false);
  assert.equal(Object.hasOwn(examples[0]!.data, 'signature_literals'), false);
  assert.deepEqual(examples[0]!.data.reference, { command_mentions: ['demo ghost add'] });
  // The mark and what a consumer still has to do are said out loud.
  assert.ok(
    produced.warnings.some((warning) => warning.includes('data.reference_only') && warning.includes('分流')),
    produced.warnings.join('；'),
  );
  // The real behaviour of the command carries no such mark.
  const real = produced.entries.find((entry) => String(entry.statement).includes('探测目标'));
  assert.ok(real !== undefined && real.data.reference_only === undefined, JSON.stringify(real?.data));
  assert.deepEqual(real!.data.command_mentions,['demo ghost show']);
  assert.equal(real!.data.command_literals,undefined);
});

test('escaped closing marks in listings stay literal and never create paragraph definitions', async () => {
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
  assert.deepEqual(mapped.unparsed,[]);
  const produced=produceAdocEntries(mapped,{name:'cli',slot:'manual'});assert.ok(produced.ok,JSON.stringify(produced));
  assert.deepEqual(produced.entries.filter(entry=>entry.data.form==='signature'),[]);
  assert.deepEqual(produced.entries.map(entry=>[entry.statement,entry.fragments[0]!.selector]),lines.slice(6,12).map((line,index)=>[line,'l/'+(7+index)]));
});
