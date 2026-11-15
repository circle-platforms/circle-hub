// The authoring brief of a case (functions/authoring-brief.ts) and the tool that writes one per item of a downloaded run. The
// reference implementation builds each writer's brief in code and has the writer reuse the recompose stage's command grounding
// before it queries anything; here the brief is taken, by structure alone, from the files the run download wrote. Synthetic
// tree, policy and record only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { authoringBrief, canonicalPath, commandPath, inverseOf, nodeBlock, pairedSibling, parameterRows, planEnvelope, policyOf, referencedPaths } from '../functions/authoring-brief.ts';
import { knowledgeFiles } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import * as authoringBriefTool from './authoring-brief.ts';
import { readKnowledge, writeBriefs } from './authoring-brief.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', ROOT = 'a'.repeat(64), OTHER_ROOT = 'b'.repeat(64);
const digest = (seed: number) => seed.toString(16).padStart(2, '0').repeat(32);
let seed = 1;
type Row = { path: string; children: string[]; statements: Array<[string, string] | [string, string, Record<string, unknown>]> };
const rows: Row[] = [
  { path: '/', children: ['commands', 'manual'], statements: [] },
  { path: '/commands', children: ['widget', 'no', 'show'], statements: [] },
  { path: '/commands/widget', children: ['name', 'off', 'on', 'reset', 'sync'], statements: [] },
  { path: '/commands/widget/name', children: [], statements: [['definition', 'widget name <arg1:string> [<arg2:int 1..60="5">]\n  Add a widget\n  arg1: 合成参数说明'], ['definition', 'widget name <label> [interval]']] },
  { path: '/commands/widget/off', children: [], statements: [['definition', 'widget off']] },
  { path: '/commands/widget/on', children: [], statements: [['definition', 'widget on']] },
  { path: '/commands/widget/reset', children: [], statements: [['definition', 'widget reset']] },
  { path: '/commands/widget/sync', children: ['rollback', 'to'], statements: [] },
  { path: '/commands/widget/sync/rollback', children: [], statements: [['definition', 'widget sync rollback <arg1:string>']] },
  { path: '/commands/widget/sync/to', children: [], statements: [['definition', 'widget sync to <arg1:string>']] },
  { path: '/commands/no', children: ['widget'], statements: [] },
  { path: '/commands/no/widget', children: ['name'], statements: [] },
  { path: '/commands/no/widget/name', children: [], statements: [['definition', 'no widget name <arg1:string>']] },
  { path: '/commands/show', children: ['widget'], statements: [] },
  { path: '/commands/show/widget', children: [], statements: [['definition', 'show widget [<arg1:string="">]']] },
  { path: '/manual', children: ['guide'], statements: [] },
  { path: '/manual/guide', children: ['parameters', 'two words', 'whole chapter'], statements: [] },
  // Rows of a manual table: the producer records on a row the command forms and the parameter it states.
  { path: '/manual/guide/parameters', children: [], statements: [
    ['behaviour', '| peer_name | 合成参数说明：特殊字符仅支持“._-”。 |', { form: 'table_row', parameter: { commands: ['widget sync to', 'widget sync from'], name: 'peer_name' } }],
    ['behaviour', '| mode | 合成参数说明：取值为 full 或 delta。 |', { form: 'table_row', parameter: { commands: ['widget sync to'], name: 'mode' } }],
    ['behaviour', '| 合成表头 | 不是参数行。 |', { form: 'table_row' }],
    ['behaviour', '| broken | 合成的不完整数据。 |', { form: 'table_row', parameter: { commands: [], name: 'broken' } }],
  ] },
  { path: '/manual/guide/two words', children: [], statements: [['behaviour', '合成手册句：部件默认关闭。']] },
  { path: '/manual/guide/whole chapter', children: [], statements: [['behaviour', '合成长章节。'.repeat(700)]] },
];
const child = (parent: string, name: string) => (parent === '/' ? '' : parent) + '/' + name;
const batch = () => {
  const nodes = rows.map((row) => ({
    path: row.path, reference: `tree:${ROOT}${row.path}`, name: row.path.split('/').at(-1), level: row.children.length ? 'branch' : 'leaf', digest: digest(seed++),
    children: row.children.map((name) => ({ name, path: child(row.path, name), digest: digest(seed++) })),
    entries: row.statements.map(([kind, statement, data], at) => ({ entry: digest(200 + at), kind, statement, reference: `tree:${ROOT}${row.path}@${digest(200 + at)}`, data: data ?? {} })),
  }));
  const head = { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: nodes.length, entries: nodes.reduce((sum, node) => sum + node.entries.length, 0) };
  return Buffer.from([head, ...nodes].map((line) => JSON.stringify(line)).join('\n') + '\n');
};
const POLICY = {
  schema: 'command-policy@1', confirmations: [], read_only: ['/commands/show'], inverse_alternatives: [['on', 'off']],
  inverse_rules: [{ source_prefix: '/commands', inverse_prefix: '/commands/no' }, { source_prefix: '/commands/no', inverse_prefix: '/commands' }, { source_prefix: '/commands/widget/sync/to', inverse_prefix: '/commands/widget/sync/rollback', leading_parameters: 1 }],
};
const entry = digest(99);
const ITEM = {
  id: 'doc-1:c-1',
  fields: {
    title: '合成用例', steps: [{ text: '合成步骤' }],
    expected_nodes: [{ reference: `src:${digest(8)}/kityminder@1/n/e-1`, text: '合成期望一' }, { reference: `src:${digest(8)}/kityminder@1/n/e-2`, text: '合成期望二', declaration: { kind: 'literal' } }],
    recomposition: {
      receipt: `rec:${digest(7)}`,
      record: {
        case: { id: 'case-0001', title: '合成用例' }, expectation_slots: [{ slot: 'e1', atom: 'a4' }, { slot: 'e2', atom: 'a5' }],
        atoms: [{ id: 'a1', kind: 'action', text: 'widget sync to peer-b' }, { id: 'a2', kind: 'action', text: '合成步骤，不是命令' }, { id: 'a3', kind: 'action', text: 'widget sync' }],
        ledgers: {
          adapted: [{
            atom: 'a2', commands: ['widget name "x" 9', 'widget on', 'widget reset'],
            equivalence_reason: `说明见 tree:${ROOT}/commands/show/widget@${entry} 一条`,
            equivalence_refs: [`tree:${ROOT}/commands/widget/name@${entry}`, `tree:${ROOT}/manual/guide/two%20words@${entry}`, `tree:${ROOT}/manual/guide/whole%20chapter`, `tree:${OTHER_ROOT}/commands/widget/off@${entry}`, `tree:${ROOT}/commands/widget/gone@${entry}`],
          }],
        },
      },
    },
  },
};

/** A downloaded run directory: the knowledge files exactly as the run download writes them, the run record and the items. */
async function downloaded(items: unknown[], policy: unknown = POLICY): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cc-brief-'));
  for (const { name, bytes } of knowledgeFiles(batch(), RUN).outputs) { await mkdir(dirname(join(directory, name)), { recursive: true }); await writeFile(join(directory, name), bytes); }
  await writeFile(join(directory, 'run.json'), JSON.stringify({ run: RUN, groups: [{ kind: 'other' }, { kind: 'case-compile', profile: { bed: 'bed-a' } }], ...(policy === null ? {} : { command_policy: policy }) }));
  await mkdir(join(directory, 'items'));
  for (const [at, item] of items.entries()) await writeFile(join(directory, 'items', `${String(at).padStart(2, '0')}.json`), JSON.stringify(item));
  return directory;
}

test('the tree paths a record references are read off its strings: whole references, and ones written with their entry inside a sentence', () => {
  assert.deepEqual(referencedPaths(ITEM.fields.recomposition, ROOT).sort(), ['/commands/show/widget', '/commands/widget/gone', '/commands/widget/name', '/manual/guide/two%20words', '/manual/guide/whole%20chapter']);
  assert.deepEqual(referencedPaths(ITEM.fields.recomposition, OTHER_ROOT), ['/commands/widget/off'], 'another root is another tree');
  assert.deepEqual(referencedPaths({ note: `提到 tree:${ROOT}/commands/widget/on 但没有写条目` }, ROOT), [], 'a path inside a sentence ends nowhere without its entry');
  assert.equal(canonicalPath('/manual/guide/two words'), canonicalPath('/manual/guide/two%20words'), 'the text files and the references spell one node two ways');
  assert.notEqual(canonicalPath('/manual/a%2Fb'), canonicalPath('/manual/a/b'), 'a slash inside a name is not a level');
});

test('a command line names the node its words lead to; a branch, a sentence and an unknown word name none', async () => {
  const knowledge = (await readKnowledge(await downloaded([])))!;
  assert.equal(commandPath(knowledge, 'widget name "x" 9'), '/commands/widget/name');
  assert.equal(commandPath(knowledge, '  show widget'), '/commands/show/widget');
  assert.equal(commandPath(knowledge, 'widget sync'), null, 'a node that defines nothing');
  assert.equal(commandPath(knowledge, '合成步骤，不是命令'), null);
  assert.equal(commandPath(knowledge, 'gadget on'), null);
});

test('the inverse is the product’s: a declared pair of sibling words first, else the rule with the longest prefix', async () => {
  const knowledge = (await readKnowledge(await downloaded([])))!, policy = policyOf(POLICY)!;
  assert.equal(pairedSibling(policy, knowledge, '/commands/widget/on')?.node.path, '/commands/widget/off');
  assert.equal(pairedSibling(policy, knowledge, '/commands/widget/name'), null);
  assert.deepEqual(inverseOf(policy, '/commands/widget/name'), { path: '/commands/no/widget/name', rule: { source_prefix: '/commands', inverse_prefix: '/commands/no' } });
  assert.deepEqual(inverseOf(policy, '/commands/no/widget/name')?.path, '/commands/widget/name');
  assert.deepEqual(inverseOf(policy, '/commands/widget/sync/to'), { path: '/commands/widget/sync/rollback', rule: { source_prefix: '/commands/widget/sync/to', inverse_prefix: '/commands/widget/sync/rollback', leading_parameters: 1 } });
  assert.equal(inverseOf({ ...policy, inverse_rules: [...policy.inverse_rules, { source_prefix: '/commands', inverse_prefix: '/commands/undo' }] }, '/commands/widget/name'), null, 'two rules of the same prefix decide nothing');
  assert.equal(policyOf({ schema: 'something-else' }), null);
});

test('a brief holds the commands the record names with their entries word for word, the declared inverse, the read-only form and the siblings', async () => {
  const directory = await downloaded([ITEM]);
  const knowledge = (await readKnowledge(directory))!;
  const brief = authoringBrief(ITEM, '00', knowledge, policyOf(POLICY))!;
  assert.deepEqual(brief.commands, ['/commands/show/widget', '/commands/widget/name', '/commands/widget/on', '/commands/widget/reset', '/commands/widget/sync/to']);
  assert.deepEqual(brief.others, ['/manual/guide/two%20words', '/manual/guide/whole%20chapter']);
  assert.deepEqual(brief.missing, ['/commands/widget/gone']);
  const text = brief.text;
  assert.match(text, /^# 编写简报 00：合成用例\n/);
  assert.match(text, /只有事实，没有判断，也不是计划/);
  assert.ok(text.includes(`条目 doc-1:c-1；锁定根 ${ROOT}。`));
  assert.ok(text.includes('只读前缀 /commands/show；互逆取值 on/off。核验认逆操作的顺序：'));
  // An entry is the text the run download wrote, line for line, so what a writer cites is what it would have found by searching.
  const commands = await readFile(join(directory, 'knowledge', 'commands.txt'), 'utf8');
  const block = nodeBlock(knowledge.nodes.get('/commands/widget/name')!).join('\n');
  assert.ok(commands.includes(block + '\n\n') && text.includes('### widget name\n' + block + '\n'));
  assert.ok(text.includes(`### widget name\n${block}\n逆操作（产品规则 /commands → /commands/no）：\n# /commands/no/widget/name\n· no widget name <arg1:string>\n`));
  assert.ok(text.includes('只读前缀 /commands/show 下同样的词走到的命令：\n（/commands/show/widget 的条目已在上文）\n'), 'the words end one level up, at a command; shown once');
  assert.match(text, /同级命令（\/commands\/widget 下另有 4 个，完整条目在 knowledge\/commands\.txt 第 \d+ 行起）：\n· widget off\n· widget on\n· widget reset\n· widget sync …（下面有 2 个子节点）\n/);
  assert.ok(text.includes('### widget on\n# /commands/widget/on\n· widget on\n'));
  assert.ok(text.includes('逆操作（产品声明的互逆取值 on/off：同级的另一条命令）：\n# /commands/widget/off\n· widget off\n'), 'the declared pair comes before the prefix rule');
  assert.ok(text.includes('逆操作（产品规则 /commands → /commands/no）：\n按这条规则算出的 /commands/no/widget/reset 不在锁定命令树里。\n'));
  assert.ok(text.includes('逆操作（产品规则 /commands/widget/sync/to → /commands/widget/sync/rollback，逆操作带这条命令的前 1 个参数）：\n# /commands/widget/sync/rollback\n· widget sync rollback <arg1:string>\n'));
  assert.ok(text.includes('### show widget\n# /commands/show/widget\n· show widget [<arg1:string="">]\n'));
  assert.ok(text.includes('这条命令在产品声明的只读前缀下。'));
  assert.ok(!text.includes('/commands/widget/off@' + entry) && !text.includes(OTHER_ROOT), 'nothing of another root');
  // Other nodes: a short one is quoted with where it is, a long one only says where it is.
  assert.match(text, /## 重组记录点到的其它节点（2 个）\n\nknowledge\/manual\.txt 第 \d+ 行起，共 3 行：\n# \/manual\/guide\/two words\n· 合成手册句：部件默认关闭。\n/);
  assert.match(text, /# \/manual\/guide\/whole chapter\n（knowledge\/manual\.txt 第 \d+ 行起，共 3 行，没有抄在这里）\n/);
  assert.ok(text.includes('## 记录点到、锁定根里没有的路径\n- /commands/widget/gone\n\n## 这条用例的计划文件外壳\n'));
  // The line the brief gives is the line of the block in the file.
  const at = knowledge.lines.get('/manual/guide/two%20words')!;
  assert.equal((await readFile(join(directory, 'knowledge', at.file), 'utf8')).split('\n')[at.line - 1], '# /manual/guide/two words');
});

// Run 23: the writer of a case gave a host name a character the manual's row for that parameter excludes, three dispatches
// in a row; the row was not in the locked root (the producer dropped block-style cells) and nothing put a parameter's row
// beside its command. The reference hands the writer the value domain in the vendor's own words with the argument contract.
test('a brief lists under a command the manual rows that state its parameters, word for word with their references', async () => {
  const directory = await downloaded([ITEM]);
  const knowledge = (await readKnowledge(directory))!;
  assert.deepEqual([...knowledge.parameters!.keys()].sort(), ['widget sync from', 'widget sync to'], 'by the words of each command form a row names; a row without a whole statement names none');
  assert.deepEqual(parameterRows(knowledge.nodes.values()).get('widget sync from')!.map((row) => row.name), ['peer_name']);
  const text = authoringBrief(ITEM, '00', knowledge, policyOf(POLICY))!.text;
  assert.match(text, /命令在锁定命令树里的条目、手册对这些命令各参数的说明、产品声明的逆操作/);
  const block = nodeBlock(knowledge.nodes.get('/commands/widget/sync/to')!).join('\n');
  assert.ok(text.includes([
    '### widget sync to', block,
    '手册对这条命令各参数的说明（2 行，原文）：',
    '· | peer_name | 合成参数说明：特殊字符仅支持“._-”。 |', `  引用 tree:${ROOT}/manual/guide/parameters@${digest(200)}`,
    '· | mode | 合成参数说明：取值为 full 或 delta。 |', `  引用 tree:${ROOT}/manual/guide/parameters@${digest(201)}`,
    '逆操作（产品规则 /commands/widget/sync/to → /commands/widget/sync/rollback，逆操作带这条命令的前 1 个参数）：',
  ].join('\n') + '\n'), text);
  assert.ok(!text.includes('不是参数行') && !text.includes('不完整数据'), 'only rows that state a parameter of a command the brief lists');
  const on = text.slice(text.indexOf('### widget on\n'));
  assert.ok(!on.slice(0, on.indexOf('\n### ', 1)).includes('手册对这条命令各参数的说明'), 'a command whose parameters no row states gets no such list');
});

// Run 22: the main session's hand-written template made the plan slot an object and put `bucket` beside `data`; fourteen plans
// copied it and were refused. The shape is the Hub's own and is shown whole only by the pack's example.
test('the brief ends with the envelope of the plan file: the Hub’s shape, the item’s identities filled in, the writer’s parts empty', async () => {
  const knowledge = (await readKnowledge(await downloaded([])))!;
  const envelope = planEnvelope(ITEM, 'bed-a')!;
  assert.deepEqual(envelope, {
    item: 'doc-1:c-1', handling: 'handled',
    slots: { plan: [{
      text: '',
      quotes: [{ reference: `src:${digest(8)}/kityminder@1/n/e-1`, text: '合成期望一' }, { reference: `src:${digest(8)}/kityminder@1/n/e-2`, text: '合成期望二' }],
      data: { bucket: 'bed-a', blocks: [], replacements: [], steps: [], expects: [], recomposition: { receipt: `rec:${digest(7)}`, case_id: 'case-0001', slots: [{ slot: 'e1', assertions: [] }, { slot: 'e2', assertions: [] }], rebindings: [] } },
    }] },
  });
  // The same outer keys as the pack's example submission, one statement as the slot schema asks, and every key the plan schema requires.
  const example = JSON.parse(readFileSync(new URL('../examples/submit-result.json', import.meta.url), 'utf8')).items[0];
  const schema = JSON.parse(readFileSync(new URL('../slots.schema.json', import.meta.url), 'utf8')).item.plan;
  const statement = (envelope.slots as { plan: Array<Record<string, unknown>> }).plan[0];
  assert.deepEqual([Object.keys(envelope), Object.keys(statement)], [Object.keys(example), Object.keys(example.slots.plan[0])]);
  assert.deepEqual([schema.min, schema.max, (envelope.slots as { plan: unknown[] }).plan.length], [1, 1, 1]);
  for (const key of schema.data.required) assert.ok(Object.hasOwn(statement.data as object, key), key);
  for (const key of Object.keys(statement.data as object)) assert.ok(Object.hasOwn(schema.data.properties, key), key);
  const text = authoringBrief(ITEM, '00', knowledge, policyOf(POLICY), 'bed-a')!.text;
  assert.ok(text.endsWith('\n```json\n' + JSON.stringify(envelope, null, 2) + '\n```\n'));
  assert.match(text, /## 这条用例的计划文件外壳\n\n一个条目一份 JSON 文件。Hub 收的形状是：plan 槽是只有一条陈述的列表，陈述是 \{text, quotes, data\}/);
  assert.ok(text.includes('bucket（本运行配置选定的自动化测试环境）、重组回执') && text.includes('空着的不填会被拒。'));
  // Without a profile that names a bed the bucket is left to the writer and is not claimed as filled.
  const open = authoringBrief(ITEM, '00', knowledge, policyOf(POLICY))!.text;
  assert.ok(open.includes('"bucket": ""') && !open.includes('bucket（本运行配置选定的自动化测试环境）'));
  assert.equal(planEnvelope({ fields: {} }, 'bed-a'), null, 'an item without an id has no file to name');
});

test('without a declared policy no inverse is stated; without a record there is no brief; more siblings than fit are counted', async () => {
  const knowledge = (await readKnowledge(await downloaded([])))!;
  const plain = authoringBrief(ITEM, '00', knowledge, null)!;
  assert.ok(plain.text.includes('run.json 里没有产品声明的命令规则（command_policy），下面不列逆操作和只读命令。'));
  assert.ok(!plain.text.includes('逆操作（') && !plain.text.includes('只读前缀 /commands/show 下'));
  assert.equal(authoringBrief({ id: 'doc-1:c-2', fields: { title: '没有重组记录' } }, '01', knowledge, policyOf(POLICY)), null);
  const none = authoringBrief({ id: 'doc-1:c-3', fields: { title: '没有点到命令', recomposition: { record: { atoms: [{ id: 'a1', text: '合成步骤' }], ledgers: { adapted: [] } } } } }, '02', knowledge, policyOf(POLICY))!;
  assert.ok(none.text.includes('## 重组记录点到的命令（0 条）\n\n重组记录没有点到命令树里的命令；要用的命令到 knowledge/ 里搜。'));
  const wide = structuredClone(knowledge), parent = wide.nodes.get('/commands/widget')!;
  for (let at = 0; at < 45; at++) { const path = `/commands/widget/extra${at}`; parent.children.push({ name: `extra${at}`, path }); wide.nodes.set(path, { path, children: [], entries: [{ kind: 'definition', statement: `widget extra${at}`, reference: `tree:${ROOT}${path}@${entry}` }] }); }
  assert.match(authoringBrief(ITEM, '00', wide, policyOf(POLICY))!.text, /同级命令（\/commands\/widget 下另有 49 个，[^\n]+\n(?:· [^\n]+\n){40}（还有 9 个没有列出）\n/);
});

test('the tool writes one brief per item that carries a record, beside items/ and knowledge/, and never overwrites one', async () => {
  const directory = await downloaded([ITEM, { id: 'doc-1:c-2', fields: { title: '没有重组记录' } }]);
  assert.deepEqual(await writeBriefs(directory), { briefs: 1, kept: 0, without_record: 1 });
  assert.deepEqual(await readdir(join(directory, 'briefs')), ['00.md']);
  const first = await readFile(join(directory, 'briefs', '00.md'), 'utf8');
  assert.equal(first, authoringBrief(ITEM, '00', (await readKnowledge(directory))!, policyOf(POLICY), 'bed-a')!.text, 'the policy and the bed are the run record’s');
  await writeFile(join(directory, 'briefs', '00.md'), '写手自己的批注');
  assert.deepEqual(await writeBriefs(directory), { briefs: 0, kept: 1, without_record: 1 });
  assert.equal(await readFile(join(directory, 'briefs', '00.md'), 'utf8'), '写手自己的批注', 'left as it is');
  // Standalone CLI entrypoint (`main`) was removed so all brief invocations flow solely through `task-brief.ts`.
  assert.equal('main' in authoringBriefTool, false);
});

test('a run that brought no knowledge root gets no briefs and no briefs directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-brief-'));
  await mkdir(join(directory, 'items')); await writeFile(join(directory, 'items', '00.json'), JSON.stringify(ITEM)); await writeFile(join(directory, 'run.json'), '{}');
  assert.deepEqual(await writeBriefs(directory), { briefs: 0, kept: 0, without_record: 0 });
  assert.deepEqual((await readdir(directory)).sort(), ['items', 'run.json']);
});

test('authoringBrief and writeBriefs disclose contract.cleanup rules and ban writing them into cleanup:true', async () => {
  const { CONTRACT_DOC } = await import('../functions/test-support.ts');
  const { parseRuntimeContract, runtimeDigest } = await import('../functions/runtime-contract.ts');
  const directory = await downloaded([ITEM]);
  const demoNode = { path: '/commands/demo', children: [{ name: 'save', path: '/commands/demo/save' }], entries: [] };
  const saveNode = { path: '/commands/demo/save', children: [], entries: [{ kind: 'definition', statement: 'demo save', reference: `tree:${ROOT}/commands/demo/save@` + 'e'.repeat(64) }] };
  const knowledge = (await readKnowledge(directory))!;
  knowledge.nodes.get('/commands')!.children.push({ name: 'demo', path: '/commands/demo' });
  knowledge.nodes.set('/commands/demo', demoNode);
  knowledge.nodes.set('/commands/demo/save', saveNode);
  const saveItem = {
    id: 'doc-1:c-save',
    fields: {
      title: '运行器收尾命令披露',
      recomposition: { receipt: 'rec:save', record: { atoms: [], ledgers: { adapted: [{ commands: ['demo save', 'widget health pool1 1'] }] } } },
    },
  };
  const contractDoc = structuredClone(CONTRACT_DOC) as Record<string, any>;
  contractDoc.cleanup = {
    source: 'lib/demo/clear.py',
    sha256: 'e'.repeat(64),
    objects: ['widget-seat'],
    order: { rule_match: 'first_hit', tail: ['demo save'], before: [['clear a', 'clear b']] },
    rules: [{ prefixes: ['demo save'], clears: ['demo save'], line: 120 }],
  };
  contractDoc.contract_sha256 = runtimeDigest(contractDoc);
  await writeFile(join(directory, 'sources.json'), JSON.stringify([{ slot: 'contract', file: 'contract.json' }]));
  await writeFile(join(directory, 'contract.json'), JSON.stringify(contractDoc));
  await writeFile(join(directory, 'items', '00.json'), JSON.stringify(saveItem));
  const rawNodes = (await readFile(join(directory, 'knowledge', 'nodes.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const cmdsRoot = rawNodes.find((n: any) => n.path === '/commands');
  cmdsRoot.children.push({ name: 'demo', path: '/commands/demo' });
  await writeFile(join(directory, 'knowledge', 'nodes.jsonl'), [...rawNodes, demoNode, saveNode].map((n) => JSON.stringify(n)).join('\n') + '\n');
  const parsed = parseRuntimeContract(contractDoc);
  assert.ok(parsed.ok && parsed.contract.cleanup);
  const withPolicy = authoringBrief(saveItem, '00', knowledge, policyOf(POLICY), 'bed-a', parsed.contract.cleanup)!;
  assert.match(withPolicy.text, /执行器自动清理（lib\/demo\/clear\.py@eeeeeeeeeeee）：对清配对象 widget-seat，自第 2 条用例开始前及整本关闭连接时/);
  assert.match(withPolicy.text, /以下动作放收尾末尾：demo save/);
  assert.match(withPolicy.text, /另受运行器自动清理涵盖（清配对象 widget-seat 命中规则 1（lib\/demo\/clear\.py 第 120 行），前缀“demo save”，触发清理命令 “demo save”，收尾阶段末尾执行），在清配对象上可省略 cleanup:true，禁止把运行器收尾清理或保存命令写入 cleanup:true/);
  const noRulePolicy = { schema: 'command-policy@1' as const, read_only: [], inverse_rules: [], inverse_alternatives: [] };
  const withoutInverse = authoringBrief(saveItem, '00', knowledge, policyOf(noRulePolicy), 'bed-a', parsed.contract.cleanup)!;
  assert.match(withoutInverse.text, /执行器收尾（无需手写 cleanup:true）：清配对象 widget-seat 命中规则 1（lib\/demo\/clear\.py 第 120 行），前缀“demo save”，触发清理命令 “demo save”，收尾阶段末尾执行；禁止写入 cleanup:true（需在用例过程内执行时只写进 main）/);
  assert.doesNotMatch(withoutInverse.text, /### demo save[\s\S]*产品没有为这条命令声明唯一的逆操作规则/);
  assert.deepEqual(await writeBriefs(directory), { briefs: 1, kept: 0, without_record: 0 });
  const written = await readFile(join(directory, 'briefs', '00.md'), 'utf8');
  assert.match(written, /执行器自动清理（lib\/demo\/clear\.py@eeeeeeeeeeee）/);
  assert.match(written, /禁止把运行器收尾清理或保存命令写入 cleanup:true/);
});
