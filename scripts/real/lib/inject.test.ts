import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { caseNodesOf, parseMindMap } from '../gold/cases.ts';
import { caseNodes, firstCases, inject, type ManualFragment, type MindNode, type MindTree, type Planned } from './inject.ts';

const leaf = (id: string, text: string): MindNode => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'configuration'): MindNode => ({ data: { id, text, resource: [tag], priority: 2 }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: MindNode[]): MindNode => ({ data: { id, text }, children });

// a synthetic document: two groups, five cases, one empty note node before the second group's cases
const document = (): MindTree => ({
  root: group('r', '文档', group('g1', '压力', kase('c1', '压力一', '设备正常', 'stress'), kase('c2', '压力二', '设备正常', 'stress')), group('g2', '配置', leaf('n1', '拓扑说明'), kase('c3', '生成甲', '生成甲成功'), kase('c4', '生成乙', '生成乙成功'), kase('c5', '不合法输入', '按默认处理', 'negative'))),
  template: 'default',
});

const textsOf = (node: MindNode): string[] => [node.data.text ?? '', ...(node.children ?? []).flatMap(textsOf)];

test('the case nodes are the tagged nodes in document order', () => {
  assert.deepEqual(caseNodes(document()).map((n) => n.data.id), ['c1', 'c2', 'c3', 'c4', 'c5']);
});

test('firstCases cuts the document after the n-th case and keeps the groups and notes before it', () => {
  const cut = firstCases(document(), 3);
  assert.deepEqual(caseNodes(cut).map((n) => n.data.id), ['c1', 'c2', 'c3']);
  assert.ok(textsOf(cut.root).includes('拓扑说明'), 'the note before the cut stays');
  assert.ok(!textsOf(cut.root).includes('生成乙'), 'the cases after the cut are gone');
  assert.deepEqual(caseNodes(document()).length, 5, 'the source is not changed');
  assert.equal(caseNodes(firstCases(document(), 99)).length, 5, 'a larger n keeps everything');
});

test('each operation does what it says, on a copy, and the gold names it', () => {
  const source = document();
  const plan: Planned[] = [
    { label: '期望结果缺失', seen_by: 'mechanical', op: { kind: 'delete_expected', node: 'c3' } },
    { label: '期望结果含糊', seen_by: 'judgment', op: { kind: 'replace_expected', node: 'c4', text: '成功' } },
    { label: '重复的用例', seen_by: 'mechanical', op: { kind: 'duplicate', node: 'c1' } },
    { label: '用例放错分组', seen_by: 'judgment', op: { kind: 'move', node: 'c5', to: 'g1' } },
  ];
  const { tree, gold } = inject(source, plan);
  assert.deepEqual(caseNodes(source).map((n) => n.data.id), ['c1', 'c2', 'c3', 'c4', 'c5'], 'the source is untouched');
  const byId = new Map(caseNodes(tree).map((n) => [n.data.id, n]));
  assert.deepEqual(byId.get('c3')?.children, [], 'c3 lost its expected result');
  assert.equal(byId.get('c4')?.children?.[0].data.text, '成功');
  const copy = gold.find((g) => g.label === '重复的用例')?.copy;
  assert.ok(copy !== undefined && copy !== 'c1' && /^[0-9a-f]{12}$/.test(copy), 'the copy has an id of its own');
  assert.equal(byId.get(copy)?.data.text, '压力一');
  assert.deepEqual(byId.get(copy)?.children?.map((c) => c.data.text), ['设备正常'], 'the copy is identical in content');
  assert.notEqual(byId.get(copy)?.children?.[0].data.id, 'c1e', 'a copied child has an id of its own too');
  const g1 = tree.root.children?.find((c) => c.data.id === 'g1');
  assert.ok(g1?.children?.some((c) => c.data.id === 'c5'), 'c5 moved under the first group');
  assert.ok(!tree.root.children?.find((c) => c.data.id === 'g2')?.children?.some((c) => c.data.id === 'c5'), 'and left the second');
  assert.deepEqual(gold.map((g) => [g.label, g.node, g.seen_by]), [
    ['期望结果缺失', 'c3', 'mechanical'],
    ['期望结果含糊', 'c4', 'judgment'],
    ['重复的用例', 'c1', 'mechanical'],
    ['用例放错分组', 'c5', 'judgment'],
  ]);
});

test('the same plan on the same document gives the same copy', () => {
  const plan: Planned[] = [{ label: 'x', seen_by: 'mechanical', op: { kind: 'duplicate', node: 'c2' } }];
  assert.deepEqual(inject(document(), plan), inject(document(), plan));
});

test('a plan that names a missing node, a group as a case, the root or a case as a target is refused', () => {
  const bad = (op: Planned['op']): void => assert.throws(() => inject(document(), [{ label: 'x', seen_by: 'judgment', op }]));
  bad({ kind: 'delete_expected', node: 'nope' });
  bad({ kind: 'delete_expected', node: 'g1' });
  bad({ kind: 'duplicate', node: 'r' });
  bad({ kind: 'move', node: 'c1', to: 'c2' });
  bad({ kind: 'replace_command_word', node: 'c1', from: 'nonexistent_word_xyz', to: 'bad' });
  bad({ kind: 'delete_negative_group', node: 'r' });
  bad({ kind: 'delete_negative_group', node: 'g1' }); // g1 contains stress cases, not negative
  bad({ kind: 'delete_negative_group', node: 'c1' }); // c1 is a case, not a group
});

test('replace_command_word replaces command word only on target case and records from/to in gold', () => {
  const doc: MindTree = {
    root: group(
      'r',
      '测试文档',
      group('g1', '配置', kase('c1', 'widget pool add pool1', '成功', 'configuration'), kase('c2', 'widget pool delete pool1', '成功', 'configuration')),
    ),
  };

  const plan: Planned[] = [
    {
      label: '构建里不存在的命令',
      seen_by: 'mechanical',
      op: { kind: 'replace_command_word', node: 'c1', from: 'add', to: 'insert_bogus' },
    },
  ];

  const { tree, gold } = inject(doc, plan);

  // c1 has the command word replaced
  const c1 = tree.root.children?.[0]?.children?.[0];
  assert.equal(c1?.data.text, 'widget pool insert_bogus pool1');

  // c2 is untouched
  const c2 = tree.root.children?.[0]?.children?.[1];
  assert.equal(c2?.data.text, 'widget pool delete pool1');

  // gold records details
  assert.equal(gold.length, 1);
  assert.equal(gold[0].label, '构建里不存在的命令');
  assert.equal(gold[0].seen_by, 'mechanical');
  assert.equal(gold[0].node, 'c1');
  assert.equal(gold[0].from, 'add');
  assert.equal(gold[0].to, 'insert_bogus');
  assert.match(gold[0].note, /换成了目录中不存在的“insert_bogus”/);

  // original doc untouched
  assert.equal(doc.root.children?.[0]?.children?.[0]?.data.text, 'widget pool add pool1');
});

test('delete_negative_group deletes a group containing only negative cases and records deletedCases in gold', () => {
  const doc: MindTree = {
    root: group(
      'r',
      '测试文档',
      group('g_pos', '正向功能', kase('c1', '正常创建', '成功', 'configuration')),
      group(
        'g_neg',
        '反向异常',
        kase('c_neg1', '非法端口创建', '提示非法端口', 'negative'),
        kase('c_neg2', '超长名称创建', '提示名称超长', '负向'),
      ),
    ),
  };

  const plan: Planned[] = [
    {
      label: '删掉一组反向用例',
      seen_by: 'judgment',
      op: { kind: 'delete_negative_group', node: 'g_neg' },
    },
  ];

  const { tree, gold } = inject(doc, plan);

  // g_neg is deleted from root
  assert.equal(tree.root.children?.length, 1);
  assert.equal(tree.root.children?.[0]?.data.id, 'g_pos');

  // g_pos and c1 untouched
  assert.equal(tree.root.children?.[0]?.children?.length, 1);
  assert.equal(tree.root.children?.[0]?.children?.[0]?.data.id, 'c1');

  // gold records deleted group and case IDs
  assert.equal(gold.length, 1);
  assert.equal(gold[0].label, '删掉一组反向用例');
  assert.equal(gold[0].seen_by, 'judgment');
  assert.equal(gold[0].node, 'g_neg');
  assert.deepEqual(gold[0].deletedCases, ['c_neg1', 'c_neg2']);
  assert.match(gold[0].note, /删掉了只含反向用例的分组 g_neg/);

  // original doc untouched
  assert.equal(doc.root.children?.length, 2);
});

const manualDoc = (): MindTree => ({
  root: group('r', '文档',
    group('g1', '配置',
      kase('c1', 'widget pool add pool1', ' aging 时间为 3600 秒 ', 'configuration'),
      kase('c2', 'widget pool delete pool1', '删除成功', 'configuration'),
    ),
  ),
});

const FRAGMENT = 'widget pool add 命令的 aging 参数取值范围是 60 到 604800 秒，缺省 3600 秒。';
const fragmentOf = (text: string): ManualFragment => ({ text, sha256: createHash('sha256').update(text).digest('hex') });

test('contradict_manual replaces the word in the first expected result containing it and records quote and fragment sha256', () => {
  const source = manualDoc();
  const plan: Planned[] = [{ label: '期望与手册矛盾', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'c1', from: '3600', to: '36000', quote: '取值范围是 60 到 604800 秒' } }];
  const { tree, gold } = inject(source, plan, { manual: fragmentOf(FRAGMENT) });
  const c1 = caseNodes(tree).find((n) => n.data.id === 'c1')!;
  assert.equal(c1.children?.[0]?.data.text, ' aging 时间为 36000 秒 ');
  assert.equal(caseNodes(source).find((n) => n.data.id === 'c1')?.children?.[0]?.data.text, ' aging 时间为 3600 秒 ');
  assert.deepEqual(gold.map((g) => [g.kind, g.node, g.from, g.to, g.quote, g.manual_sha256]), [
    ['contradict_manual', 'c1', '3600', '36000', '取值范围是 60 到 604800 秒', fragmentOf(FRAGMENT).sha256],
  ]);
});

test('contradict_manual refuses: no fragment, quote not verbatim, to inside quote, no expected containing from, wrong seen_by, target not a case by the rule', () => {
  const op = (over: Partial<Extract<Planned['op'], { kind: 'contradict_manual' }>>): Planned => ({ label: 'x', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'c1', from: '3600', to: '36000', quote: '取值范围是 60 到 604800 秒', ...over } });
  const bad = (plan: Planned[], options?: { manual?: ManualFragment; caseRule?: 'tagged' }): void => assert.throws(() => inject(manualDoc(), plan, options));
  bad([op({})]); // plan has the kind but no fragment was given
  bad([op({ quote: '取值范围是 60 到 999999 秒' })], { manual: fragmentOf(FRAGMENT) }); // not verbatim from the fragment
  bad([op({ quote: '缺省 3600 秒', to: '3600' })], { manual: fragmentOf(FRAGMENT) }); // to appears in quote
  bad([op({ from: '不存在的词' })], { manual: fragmentOf(FRAGMENT) }); // no expected result contains from
  bad([{ label: 'x', seen_by: 'mechanical', op: op({}).op }], { manual: fragmentOf(FRAGMENT) }); // seen_by not judgment
  bad([op({ node: 'g1' })], { manual: fragmentOf(FRAGMENT) }); // a group is not a case
});

test('contradict_manual refuses a marked-only case under the tagged rule', () => {
  const doc: MindTree = { root: group('r', '文档', group('g1', '配置', { data: { id: 'm1', text: '未打标用例', priority: 2 }, children: [leaf('m1e', ' aging 时间为 3600 秒 ')] })) };
  const plan: Planned[] = [{ label: 'x', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'm1', from: '3600', to: '36000', quote: '取值范围是 60 到 604800 秒' } }];
  assert.throws(() => inject(doc, plan, { manual: fragmentOf(FRAGMENT), caseRule: 'tagged' }));
  const { gold } = inject(doc, plan, { manual: fragmentOf(FRAGMENT), caseRule: 'marked' });
  assert.equal(gold.length, 1);
});

test('vague_expected replaces every expected result with the same vague phrase and only that case turns vague', () => {
  const source = manualDoc();
  const plan: Planned[] = [{ label: '期望全部含糊', seen_by: 'judgment', op: { kind: 'vague_expected', node: 'c2', text: '正常' } }];
  const { tree, gold } = inject(source, plan);
  const c2 = caseNodes(tree).find((n) => n.data.id === 'c2')!;
  assert.deepEqual(c2.children?.map((c) => c.data.text), ['正常']);
  assert.equal(gold[0]?.kind, 'vague_expected');
  assert.equal(caseNodes(source).find((n) => n.data.id === 'c2')?.children?.[0]?.data.text, '删除成功');
});

test('vague_expected refuses: phrase outside the list, no expected results, already all vague, wrong seen_by', () => {
  const doc = (): MindTree => ({
    root: group('r', '文档',
      group('g1', '配置',
        kase('c1', 'widget pool add pool1', '老化时间为 3600 秒', 'configuration'),
        kase('c2', '只有前置条件', '成功', 'configuration'),
        kase('c3', '已经含糊', '正常', 'configuration'),
      ),
    ),
  });
  const noExpected: MindTree = { root: group('r', '文档', group('g1', '配置', { data: { id: 'c2', text: '只有前置条件', resource: ['configuration'], priority: 2 }, children: [{ data: { id: 'c2p', text: '先清空', priority: 3 }, children: [] }] })) };
  const bad = (over: Partial<Extract<Planned['op'], { kind: 'vague_expected' }>>, tree?: MindTree): void =>
    assert.throws(() => inject(tree ?? doc(), [{ label: 'x', seen_by: 'judgment', op: { kind: 'vague_expected', node: 'c1', text: '正常', ...over } }]));
  bad({ text: '一点都不含糊的话' }); // not in the vague list (by foldKey)
  bad({ node: 'c2' }, noExpected); // only a priority-3 precondition, no expected results
  bad({ node: 'c3' }); // already all vague
  assert.throws(() => inject(doc(), [{ label: 'x', seen_by: 'mechanical', op: { kind: 'vague_expected', node: 'c1', text: '正常' } }]));
});

test('every gold entry carries the injection kind', () => {
  const plan: Planned[] = [
    { label: '期望结果缺失', seen_by: 'mechanical', op: { kind: 'delete_expected', node: 'c1' } },
    { label: '重复的用例', seen_by: 'mechanical', op: { kind: 'duplicate', node: 'c2' } },
  ];
  const { gold } = inject(manualDoc(), plan);
  assert.deepEqual(gold.map((g) => g.kind), ['delete_expected', 'duplicate']);
});

test('review 18: blank nested-case tags and empty operands are refused', () => {
  const source: MindTree = { root: group('r', 'synthetic', { data: { id: 'c1', text: 'case', priority: 2, resource: ['configuration'] }, children: [{ data: { id: 'inner', text: 'step', resource: [' '] }, children: [leaf('e', 'before 10')] }] }) };
  assert.throws(()=>inject(source, [{ label: 'vague', seen_by: 'judgment', op: { kind: 'vague_expected', node: 'c1', text: '正常' } }]),e=>e instanceof Error && 'reason' in e && e.reason==='blank_tags');
  for (const over of [{ from: '' }, { quote: ' ' }, { to: '' }]) assert.throws(() => inject(source, [{ label: 'manual', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'c1', from: 'before', to: 'after', quote: 'before allowed', ...over } }], { manual: { text: 'before allowed', sha256: 'a'.repeat(64) } }));
  const duplicated: MindTree = { root: group('r', 'synthetic', kase('c1', 'first', 'before 10'), kase('c1', 'second', '正常')) };
  assert.throws(() => inject(duplicated, [{ label: 'vague', seen_by: 'judgment', op: { kind: 'vague_expected', node: 'c1', text: '正常' } }]), error => error instanceof Error && 'detail' in error && String(error.detail).includes('没有变成含糊'));
});

test('review 19: keep counts marked cases using the selected case rule', () => {
  const source: MindTree = { root: group('r', 'synthetic', ...Array.from({ length: 5 }, (_, i) => ({ data: { id: `marked-${i}`, text: 'marked', priority: 2 }, children: [leaf(`e${i}`, 'expected')] }))) };
  assert.equal(caseNodesOf(parseMindMap(firstCases(source, 2)), { caseRule: 'marked' }).length, 2);
  assert.equal(caseNodesOf(parseMindMap(firstCases(source, 2, { caseRule: 'tagged' })), { caseRule: 'tagged' }).length, 0);
});

test('closure refusal reasons are fixed at throw sites even when private values resemble another reason', async t => {
 const source=document(); source.root.children!.push(group('empty','empty'));
 const manual={text:'manual allows 10',sha256:'a'.repeat(64)};
 const op={kind:'contradict_manual' as const,node:'c3',from:'生成甲',to:'999',quote:'manual allows 10'};
 const checks:Array<{op:Planned['op'];seen_by?:Planned['seen_by'];manual?:ManualFragment;reason:string;line:string}>=[
  {op:{...op,to:'10'},manual,reason:'to_in_quote',line:'to 不构成矛盾'},
  {op:{...op,from:'manual'},manual,reason:'from_not_found',line:'期望中找不到 from'},
  {op:{...op,from:''},manual,reason:'empty_operand',line:'from、to、quote 或 text 必须为非空文本'},
  {op:{...op,quote:'not verbatim'},manual,reason:'quote_not_verbatim',line:'quote 不在片段里或格式不合法'},
  {op,reason:'missing_manual',line:'缺少 --manual 输入'},
  {op,manual,seen_by:'mechanical',reason:'seen_by',line:'seen_by 不符合可见性'},
  {op:{kind:'delete_negative_group',node:'g1'},reason:'group_not_negative',line:'分组包含非反向用例'},
  {op:{kind:'delete_negative_group',node:'empty'},reason:'group_empty',line:'分组没有用例'},
  {op:{kind:'delete_expected',node:'private-manual-node'},reason:'node_not_found',line:'目标节点不存在'},
 ];
 for(const c of checks) await t.test(c.reason,()=>assert.throws(()=>inject(source,[{label:'synthetic',seen_by:c.seen_by ?? 'judgment',op:c.op}],{manual:c.manual}),e=>e instanceof Error && 'reason' in e && e.reason===c.reason && e.message===`计划第 1 条（${c.op.kind}）：${c.line}`));
});

test('closure refusal records are new private files and safe refusals keep their actionable text', async t => {
 const {recordRefusal,refusalSummary}=await import('./inject.ts');const {score}=await import('./score.ts');
 const {mkdtempSync,readFileSync,rmSync,statSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const out=mkdtempSync(join(tmpdir(),'refusal-records-'));t.after(()=>rmSync(out,{recursive:true,force:true}));
 const first=recordRefusal(out,new Error('first private detail'));const second=recordRefusal(out,new Error('second private detail'));
 assert.ok(first && second && first!==second);
 assert.match(readFileSync(join(out,first),'utf8'),/first private detail/);assert.match(readFileSync(join(out,second),'utf8'),/second private detail/);
 assert.equal(statSync(join(out,second)).mode & 0o777,0o600);
 try{score([{node:'synthetic'} as any],{partitions:{delivered:[]}});assert.fail('must refuse');}catch(e){assert.match(refusalSummary(e),/第 1 条.*重新注入/);}
});

test('closure blank tags: ambiguous targets and keep boundaries refuse without rewriting another case', () => {
 const blank=kase('blank','blank','inner expected');blank.data.resource=[''];
 const marked=group('marked','marked',blank,leaf('marked-e','old expected'));marked.data.priority=2;
 const source:MindTree={root:group('root','synthetic',marked,kase('healthy','healthy','healthy expected'))};
 const before=JSON.stringify(source);
 assert.throws(()=>inject(source,[{label:'synthetic',seen_by:'judgment',op:{kind:'vague_expected',node:'marked',text:'正常'}}]),e=>e instanceof Error && 'reason' in e && e.reason==='blank_tags' && e.message.includes('换一个用例'));
 assert.throws(()=>firstCases(source,1),e=>e instanceof Error && 'reason' in e && e.reason==='blank_tags');
 assert.equal(JSON.stringify(source),before);
 const outer=kase('outer','outer','outer expected');outer.children!.push(blank);
 assert.throws(()=>inject({root:group('root','synthetic',outer)},[{label:'synthetic',seen_by:'judgment',op:{kind:'vague_expected',node:'outer',text:'正常'}}]),e=>e instanceof Error && 'reason' in e && e.reason==='blank_tags');
});

test('decision 37 injection guard preserves Latin word, numeric and symbol boundaries', () => {
  const plan = (quote: string): Planned[] => [{ label: 'synthetic', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'c1', from: '3600', to: '99999', quote } }];
  for (const [text, quote] of [['set 10 0', 'set 100'], ['two words', 'twowords'], ['a + b', 'a+b'], ['α β', 'αβ'], ['ｱ A', 'ｱA'], ['中文', '\u0085\u3000'], ['🙂', '\ude42']]) {
    assert.throws(() => inject(manualDoc(), plan(quote), { manual: fragmentOf(text) }), error => error instanceof Error && 'reason' in error && error.reason === 'quote_not_verbatim');
  }
});

test('decision 37 injection guard requires exact whitespace in quotations', () => {
  for (const [text, quote] of [['返回\n成功', '返回成功'], ['Ａ\tB', 'ＡB'], ['A\r\n中文', 'A中文'], ['𠀀\nA', '𠀀A'], ['set\t10\n0', 'set 10 0'], ['a\u0085b', 'a b']]) {
    const exact: Planned[] = [{ label: 'synthetic', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'c1', from: '3600', to: '99999', quote: text } }];
    assert.equal(inject(manualDoc(), exact, { manual: fragmentOf(text) }).gold.length, 1);
    const variant: Planned[] = [{ label: 'synthetic', seen_by: 'judgment', op: { kind: 'contradict_manual', node: 'c1', from: '3600', to: '99999', quote } }];
    assert.throws(() => inject(manualDoc(), variant, { manual: fragmentOf(text) }), error => error instanceof Error && 'reason' in error && error.reason === 'quote_not_verbatim');
  }
});
