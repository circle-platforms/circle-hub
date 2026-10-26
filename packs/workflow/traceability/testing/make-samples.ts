// Generates the pack's samples with the real projection and subject builder, so a sample's subject is exactly what the
// check receives in a run. Regenerate after changing the scheme: node packs/workflow/traceability/testing/make-samples.ts
// (then pack-files.ts --write). The samples are static author samples; this tool is a test fixture, never published.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { projectItems } from '../functions/project.ts';
import { buildSubject } from '../functions/subject.ts';
import { boundPair, caseEntry, defectEntry } from '../functions/test-support.ts';

const PACK_DIR = fileURLToPath(new URL('../', import.meta.url));
const CONTEXT = { product: 'famx', names: ['FAMX', 'FAMY'], line: null, build: null, root: null, parameters: {}, groups: [] };

function subjectOf(defects: ReturnType<typeof defectEntry>[], cases: ReturnType<typeof caseEntry>[], options: { defectsView?: Record<string, unknown>; casesView?: Record<string, unknown> } = {}) {
  const pair = boundPair(defects, cases, options);
  const projected = projectItems({ inputs: pair.inputs, parameters: {}, context: CONTEXT });
  if ('error' in projected) throw new Error(`projection refused: ${projected.error.code}`);
  const items = projected.items.map((it) => ({ id: it.id, label: it.label, location: `src:${it.location.source}/json@1/${it.location.selector}`, fields: it.fields }));
  return buildSubject({ applies: 'run', items, context: { ...CONTEXT, groups: projected.groups ?? [] } });
}

async function write(dir: string, name: string, sample: unknown): Promise<void> {
  await writeFile(join(PACK_DIR, 'samples', dir, `${name}.json`), `${JSON.stringify(sample, null, 2)}\n`);
}

async function main(): Promise<void> {
  // Positive of traced: two defects, both traced (one fixed with two cases, one known with one).
  const traced = subjectOf(
    [defectEntry({ bug: '71001', statement: '告警阈值修改后不生效' }), defectEntry({ bug: '71002', status: 'known', statement: '会话保持在切换后失效' })],
    [caseEntry({ defects: ['71001'], case: 'C-101', title: '修改告警阈值后查询生效' }), caseEntry({ defects: ['71001'], case: 'C-102', title: '阈值超出范围报错' }), caseEntry({ defects: ['71002'], case: 'C-103', title: '主备切换后会话保持' })],
  );
  await write('positive', 'traced-with-cases', {
    id: 'traced_with_cases',
    source: 'author',
    check: 'traced',
    note: '合成样例：两个缺陷各有已索引用例，数据里按用例编号排序列出（编号、标题、文档），依据是缺陷条目和用例条目的树引用',
    subject: traced,
    expect: [
      { verdict: 'support', item: '71001', tier: 'advisory' },
      { verdict: 'support', item: '71002', tier: 'advisory' },
    ],
  });

  // Negative of traced: one bug with conflicting statuses (refuted), one untraced (unknown, never a failure).
  const conflict = subjectOf(
    [defectEntry({ bug: '71011', status: 'fixed', statement: '71011 已修复' }), defectEntry({ bug: '71011', status: 'known', statement: '71011 遗留' }), defectEntry({ bug: '71012', statement: '没有用例的缺陷' })],
    [caseEntry({ defects: ['71011'], case: 'C-111', title: '矛盾状态的缺陷的用例' })],
  );
  await write('negative', 'status-conflict', {
    id: 'status_conflict',
    source: 'author',
    check: 'traced',
    note: '合成样例：同一个缺陷既列为已修复又列为已知，记不通过（提示档）；没有已索引用例的缺陷记未知（缺输入），从不记为不通过',
    subject: conflict,
    expect: [
      { verdict: 'refute', code: 'traceability.status_conflict', item: '71011', tier: 'advisory' },
      { verdict: 'unknown', reason: 'missing_input', item: '71012', tier: 'advisory' },
    ],
  });

  // Negative of traced: a listed case whose raw defect ids do not carry the bug — the frozen subject contradicts itself.
  const tampered = subjectOf([defectEntry({ bug: '71021' })], [caseEntry({ defects: ['71021'], case: 'C-121', title: '编号对不上的用例' })]);
  (tampered.items[0].fields as { cases: Array<{ defects: string[] }> }).cases[0].defects = ['79999'];
  await write('negative', 'join-mismatch', {
    id: 'join_mismatch',
    source: 'author',
    check: 'traced',
    note: '合成样例：条目冻结的用例列表里，用例的原始缺陷编号不含这个缺陷——检查不信字段，按原始编号重核，对不上记不通过（提示档）',
    subject: tampered,
    expect: [{ verdict: 'refute', code: 'traceability.join_mismatch', item: '71021', tier: 'advisory' }],
  });

  // Positive of counts: consistent views.
  await write('positive', 'counts-consistent', {
    id: 'counts_consistent',
    source: 'author',
    check: 'counts',
    note: '合成样例：两个视图声明的总数与列出的内容一致，计数记支持（缺陷 2 个，已追溯 1 个，未追溯 1 个）',
    subject: subjectOf([defectEntry({ bug: '71031' }), defectEntry({ bug: '71032' })], [caseEntry({ defects: ['71031'], case: 'C-131', title: '追溯到的用例' })]),
    expect: [{ verdict: 'support', tier: 'advisory' }],
  });

  // Negative of counts: a view that declares itself complete but lists fewer keys than its totals.
  const mismatched = subjectOf([defectEntry({ bug: '71041' })], [caseEntry({ defects: ['71041'], case: 'C-141', title: '追溯到的用例' })]);
  (mismatched.context.groups[0] as { views: { defects: { total_keys: number; truncated: boolean } } }).views.defects.total_keys = 7;
  await write('negative', 'count-mismatch', {
    id: 'count_mismatch',
    source: 'author',
    check: 'counts',
    note: '合成样例：缺陷索引声明未截断，却列出 1 个键而声明共 7 个，视图自相矛盾，计数记不通过（提示档）而不是照写',
    subject: mismatched,
    expect: [{ verdict: 'refute', code: 'traceability.count_mismatch', tier: 'advisory' }],
  });
  const collisions=subjectOf([defectEntry({bug:'71061',system:'plm'}),defectEntry({bug:'71061',system:'bugzilla'})],[caseEntry({defects:['71061'],case:'C-ambiguous'})]);
  await write('negative','system-collision',{
    id:'system_collision',source:'author',check:'traced',note:'Two named systems share a number; an unqualified case is not attributed to either',subject:collisions,
    expect:['bugzilla:71061','plm:71061'].map(item=>({verdict:'refute',code:'traceability.id_collision',item,tier:'advisory'})),
  });

}

await main();
console.log('samples written');
