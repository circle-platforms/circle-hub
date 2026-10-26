// Synthetic subject snapshots paired by the fact that is removed/restored. No real knowledge or external reads.
import {VerdictSchema,type Verdict} from '../../../../contracts/generated/vocabulary.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withoutCategory, withCase, witnessCase, render, type DocumentSpec } from './mindmap.ts';
import { bind, isFailure, projectionInput } from './support.ts';
import { projectDocuments } from '../functions/project.ts';
import { commandSubject } from '../functions/command-subject.ts';
import TEMPLATE from '../tables/template-v3.json' with { type: 'json' };
import { BUILD, LOCK, ROOT, assignedCases, bindIndex, digest, indexView } from './index.ts';
const document = '900001';
const categories = TEMPLATE.categories.filter(c => c.group === 'command');
export function commandSampleSubjects(): { id: string; polarity: 'positive' | 'negative'; note: string; subject: any; verdicts: Verdict[] }[] {
  const cases = categories.map((category, i) => ({ id: `${document}:case${i}`, visit: i + 1, status: 'classified', categories: [category.id] }));
  const base = { item: document, document, location: `src:${digest('synthetic mindmap')}/kityminder@1/i`, uploaded: false, case_rule: 'marked', cases, nodes: { texts: ['合成根', ...categories.map(c => `合成${c.id}`)], parents: [-1, ...categories.map(() => 0)] }, case_count: cases.length, skipped: [], index: indexView(cases.map(c => ({ document, node: c.id.slice(document.length + 1), title: `合成${c.categories[0]}`, path_labels: ['合成根'], commands: ['/CLI/widget/probe'] }))), index_reference: `src:${digest('synthetic index')}`, scope: [document], lock: { product: LOCK.product, build: BUILD, root: ROOT } };
  const make = (id: string, polarity: 'positive' | 'negative', note: string, verdicts: Verdict[], change: (s: any) => void) => { const subject = structuredClone(base); change(subject); return { id, polarity, note, subject, verdicts }; };
  return [
    make('command_all', 'positive', '完整索引和九类用例；与缺类别、未连接、无命令和缺输入各反例配对', ['support'], () => {}),
    make('command_skip', 'positive', '缺一类但用户声明跳过；与未跳过的缺类别反例配对', ['support'], s => { s.cases[0].categories = []; s.skipped = [{ category: categories[0]!.id, reason: '合成用户声明不适用' }]; }),
    make('command_shortfall', 'negative', '完整索引缺一类别；恢复该类别即 command_all 正例', ['refute'], s => { s.cases[0].categories = []; }),
    make('command_absent', 'negative', '完整索引没有文档；收进索引即 command_all 正例', ['refute'], s => { s.index = indexView([], [document]); }),
    make('command_upload', 'negative', '上传文件没有敏捷平台文档身份；换为已收录的文档即 command_all 正例', ['refute'], s => { s.uploaded = true; }),
    make('command_none', 'negative', '用例全部连接但没有已解析命令；给用例分配命令即 command_all 正例', ['refute'], s => { for (const e of Object.values(s.index.entries) as any[]) {e.data.commands = [];e.data.command_identities=[];} }),
    make('command_rule_mismatch', 'negative', 'tagged 与默认 marked 索引用例规则不一致：用默认规则重跑后为 command_all 正例', ['refute'], s => { s.case_rule = 'tagged'; }),
    make('command_unbound', 'negative', '缺用例索引；补绑即 command_all 正例，陈述必须给出重跑动作', ['unknown'], s => { s.index = null; }),
    make('command_partial_shortfall', 'negative', '来源不全且已知类别不齐：命令和文档各给一条带出口的缺输入；补来源和类别即 command_all 正例', ['unknown', 'unknown'], s => { s.index.skipped = 2; s.index.notes = ['未归位条目 3 个，标在根下']; s.cases[0].categories = []; }),
    make('command_partial_support', 'positive', '来源不全但已知九类齐全：保留支持并追加文档缺输入；完整反例不能假报覆盖完整', [...VerdictSchema.extract(['support', 'unknown']).options], s => { s.index.skipped = 2; s.index.notes = ['未归位条目 3 个，标在根下']; }),
    make('command_unmatched', 'negative', '脑图多了未收录用例：保留已知支持并追加文档缺输入；同步收录后为完整正例', [...VerdictSchema.extract(['support', 'unknown']).options], s => { s.cases.push({ id: `${document}:fresh`, visit: s.nodes.texts.length, categories: [] }); s.nodes.texts.push('新增用例'); s.nodes.parents.push(0); s.case_count++; }),
  ];
}
function declaredSample(example: ReturnType<typeof commandSampleSubjects>[number]) {
  const codes: Record<string, string> = { command_shortfall: 'template-gap.command_shortfall', command_absent: 'template-gap.not_indexed', command_upload: 'template-gap.not_indexed', command_none: 'template-gap.no_commands', command_rule_mismatch: 'template-gap.case_rule_mismatch' };
  return { id: example.id, source: 'author', check: 'command_coverage', note: example.note, subject: example.subject, expect: example.verdicts.map(verdict => ({ verdict, ...(verdict === 'refute' ? { code: codes[example.id] } : {}), ...(verdict === 'unknown' ? { reason: 'missing_input' } : {}), item: document, tier: 'advisory' })) };
}
export function commandTransitionalExamples() {
  return commandSampleSubjects().filter(e => e.verdicts.includes('unknown')).map(example => {
    const baseline: DocumentSpec = { rootId: `transition-${example.id}`, title: '合成按命令覆盖场景', children: [{ kind: 'group', id: 'transition-group', created: 0, text: '其他', shows: [], children: categories.map((category, i) => witnessCase(category.id, 2000 + i)) }] };
    const source = example.id === 'command_partial_shortfall' ? withoutCategory(baseline, 'audit_log') : example.id === 'command_unmatched' ? withCase(baseline, '其他', witnessCase('audit_log', 9876)) : baseline;
    const pendingView = example.id === 'command_unbound' ? null : indexView(assignedCases(example.id === 'command_unmatched' ? baseline : source, document), [document]);
    if (pendingView && example.id.startsWith('command_partial')) { pendingView.skipped = 2; pendingView.notes = ['未归位条目 3 个，标在根下']; }
    const restoredView = indexView(assignedCases(source, document), [document]);
    restoredView.notes = pendingView?.notes.filter(note => note.startsWith('未归位')) ?? [];
    const snapshot = (view: ReturnType<typeof indexView> | null) => {
      const brain = bind(source, { external: `agile:mindmap:${document}` });
      const projected = projectDocuments({ ...projectionInput([brain, ...(view ? [bindIndex(view)] : [])]), context: LOCK });
      if (isFailure(projected)) throw new Error(projected.error.message);
      const item = projected.items[0]!;
      return commandSubject({ item: { ...item, location: `src:${brain.sha256}/${item.location.parser}/${item.location.selector}` }, context: { ...LOCK, groups: projected.groups } });
    };
    const refute = example.id === 'command_partial_shortfall';
    const pending = declaredSample({ ...example, subject: snapshot(pendingView) });
    const restored = declaredSample({ ...example, id: `${example.id}_restored`, subject: snapshot(restoredView), verdicts: [refute ? 'refute' : 'support'] });
    if (refute) restored.expect[0]!.code = 'template-gap.command_shortfall';
    return { schema: 'template-gap.transitional-example@1', id: example.id, note: '成对的合成脑图、索引输入、过渡未知及补齐后的确定结果；当前样例合约不接受期望未知，模型修订后迁入 samples/', inputs: { document: render(source), index: pendingView }, restored_inputs: { document: render(source), index: restoredView }, pending, restored };
  });
}
export async function writeCommandSamples(dir: string): Promise<void> {
  for (const example of commandSampleSubjects().filter(e => !e.verdicts.includes('unknown'))) {
    await writeFile(join(dir, `samples/${example.polarity}/${example.id}.json`), `${JSON.stringify(declaredSample(example), null, 2)}\n`);
  }
  for (const example of commandTransitionalExamples()) await writeFile(join(dir, `examples/${example.id}.json`), `${JSON.stringify(example, null, 2)}\n`);
}
if (import.meta.main) await writeCommandSamples(new URL('../', import.meta.url).pathname);
