// Prerequisites in compile-brief@1 must be read from record.sources.states (real recompose shape),
// not record.adjudication.states / record.states (wrong paths that silently yield none).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCompileBrief,
  formatRecomposeUnknown,
  PREREQ_PARTIAL_RECOMPOSE_REASON,
  PREREQ_SCAN_REASON,
  renderCompileBriefMd,
  SCOPE_RULINGS_ORIGIN,
  validateCompileBrief,
} from './authoring-brief.ts';
import type { BriefKnowledge } from './authoring-brief.ts';
import { extractScopeUserRulings } from './scope.ts';
import { renderTaskBrief, resolveSubagentRole } from './subagent-roles.ts';
import { formatToolLocalMinute } from './text.ts';

const ROOT = 'a'.repeat(64);
const Q1 = `src:${'c'.repeat(64)}/kityminder@1/n/1`;
const Q2 = `src:${'c'.repeat(64)}/kityminder@1/n/2`;

function emptyKnowledge(): BriefKnowledge {
  return { root: ROOT, nodes: new Map(), lines: new Map(), parameters: new Map() };
}

type SynthAtom = { id: string; kind: 'intent' | 'action' | 'expectation'; text: string; quote_ref: string; span: [number, number] };
type SynthExit = { action: string; object: string; owner: string; due: string } | null;
type SynthState = {
  atom: string;
  state: 'settled' | 'missing_prerequisite';
  reason: string;
  prerequisites?: string[];
  adjudicated_by: string | null;
  exit: SynthExit;
};

/** Synthetic shape matching trimmed real items/1.json + recompose-record@1 schema. */
function makeRealShapeItem(opts: {
  id: string;
  autoid: string;
  title: string;
  receipt: string;
  atoms: SynthAtom[];
  states?: SynthState[];
  unknowns?: Array<{ atom: string; missing: string; next_action: string; audience: string; due: string }>;
  adjudication?: { states: Array<{ atom: string; state: string; reason: string; prerequisites?: string[] }> };
}) {
  const atoms = opts.atoms;
  const lastAtomId = atoms[atoms.length - 1]?.id ?? 'a1';
  const record: Record<string, unknown> = {
    schema: 'recompose-record@1',
    case: {
      id: opts.id,
      source_ref: Q1,
      node: opts.autoid,
    },
    contract: {
      intent: { text: `验证${opts.title}`, quote_ref: Q1, verbatim: true },
      method: { kind: 'recomposed', text: '按知识树命令执行前置与配置', sources: ['knowledge/manual.txt#synth'], basis: '合成对照' },
      expectation: { text: '对端预期回显一致', quote_ref: Q2, verbatim: true },
    },
    expectation_slots: [
      {
        slot: 'e1',
        atom: lastAtomId,
        knowledge_location: 'has_verification_knowledge',
        evidence: ['knowledge/commands/synth.md'],
        proposal: 'show widget status',
      },
    ],
    coverage: {
      author_atoms: atoms.map((a) => a.id),
      mapped: Object.fromEntries(atoms.map((a) => [a.id, [`knowledge/synth/${a.id}`]])),
      unmapped: [],
    },
    atoms,
    ledgers: { original: [], adapted: [], concretizations: [], rebindings: [] },
    status: 'complete',
    unknowns: opts.unknowns ?? [],
  };
  if (opts.states !== undefined) {
    record.sources = {
      candidates: [],
      governing: [],
      states: opts.states,
    };
  }
  if (opts.adjudication !== undefined) {
    record.adjudication = opts.adjudication;
  }
  return {
    id: opts.id,
    label: opts.title,
    location: `/synth/${opts.autoid}`,
    summary: `合成用例摘要：${opts.title}`,
    digest: `sha256:${'a'.repeat(64)}`,
    fields: {
      autoid: opts.autoid,
      title: opts.title,
      expected_nodes: [{ reference: Q2, text: '对端预期回显一致' }],
      recomposition: {
        receipt: opts.receipt,
        record,
      },
    },
  };
}

function itemWithSourceStates(prerequisites: string[]) {
  return makeRealShapeItem({
    id: 'synth-doc:case-1',
    autoid: '990000000000000401',
    title: '合成用例：前置读位',
    receipt: `rec:${'b'.repeat(64)}`,
    atoms: [
      { id: 'a1', kind: 'action', text: 'synthetic action', quote_ref: Q1, span: [0, 16] },
      { id: 'a2', kind: 'action', text: 'synthetic setup', quote_ref: Q2, span: [17, 32] },
    ],
    states: [
      {
        atom: 'a1',
        state: 'settled',
        reason: '合成：本条无前置',
        adjudicated_by: null,
        exit: { action: '继续编写脚本', object: 'synth-doc:case-1#a1', owner: '程序', due: '脚本编写之前' },
      },
      {
        atom: 'a2',
        state: 'missing_prerequisite',
        reason: '合成：手册点名的功能前置尚未写入计划',
        prerequisites,
        adjudicated_by: null,
        exit: { action: '补前置或按缺少前置处理', object: 'synth-doc:case-1#a2', owner: '编写模型', due: '脚本编写之前' },
      },
    ],
  });
}

test('buildCompileBrief lists prerequisites from record.sources.states (real shape)', () => {
  const prerequisites = [
    '合成前置甲：对端节点已登记',
    '合成前置乙：挑战码两端一致',
    '合成前置丙：启动时同步为禁用',
    '合成前置丁：软件版本前两位相同',
    '合成前置戊：主备通信正常',
  ];
  const item = itemWithSourceStates(prerequisites);
  const brief = buildCompileBrief({
    item,
    index: '16',
    knowledge: emptyKnowledge(),
    policy: null,
    round: 1,
    mode: 'initial',
  });
  assert.ok(brief, 'brief must build');
  assert.equal(brief!.materials.prerequisites.status, 'partial_recompose_only');
  assert.equal(brief!.materials.prerequisites.from_recompose_states.length, 1);
  const row = brief!.materials.prerequisites.from_recompose_states[0]!;
  assert.equal(row.atom, 'a2');
  assert.deepEqual(row.prerequisites, prerequisites);
  assert.equal(row.state, 'missing_prerequisite');
  assert.equal(row.origin, 'record.sources.states');
  const md = renderCompileBriefMd(brief!);
  for (const line of prerequisites) assert.match(md, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(md, /none_declared_or_found_in_recompose/);
});

test('buildCompileBrief discloses when sources.states is missing instead of claiming none', () => {
  const item = makeRealShapeItem({
    id: 'synth-doc:case-2',
    autoid: '990000000000000402',
    title: '合成用例：缺 states 形状',
    receipt: `rec:${'d'.repeat(64)}`,
    atoms: [],
    // Intentional legacy-shape decoy — no sources.states
    adjudication: {
      states: [{ atom: 'a1', state: 'missing_prerequisite', prerequisites: ['旧路径前置'], reason: '不应再读' }],
    },
  });
  const brief = buildCompileBrief({
    item,
    index: '17',
    knowledge: emptyKnowledge(),
    policy: null,
    round: 1,
    mode: 'initial',
  });
  assert.ok(brief);
  assert.equal(brief!.materials.prerequisites.status, 'recompose_states_unreadable');
  assert.equal(brief!.materials.prerequisites.from_recompose_states.length, 0);
  assert.match(brief!.materials.prerequisites.scan_reason, /读不到|sources\.states/);
  assert.match(brief!.materials.prerequisites.scan_reason, /重组返回的记录形状/);
  assert.doesNotMatch(brief!.materials.prerequisites.scan_reason, /回执/);
  assert.doesNotMatch(JSON.stringify(brief!.materials.prerequisites), /旧路径前置/);
});

/** Shape of a settled user ruling once written into the recompose record (recompose/SKILL + submit-records). */
test('buildCompileBrief lists user rulings from record.sources.states settled「使用者决定：」', () => {
  const ruling = '使用者决定：合成决定——保留原步骤，本条先不编';
  const item = makeRealShapeItem({
    id: 'synth-doc:case-3',
    autoid: '990000000000000403',
    title: '合成用例：使用者决定读位',
    receipt: `rec:${'e'.repeat(64)}`,
    atoms: [{ id: 'a1', kind: 'intent', text: 'synthetic intent', quote_ref: Q1, span: [0, 16] }],
    states: [
      {
        atom: 'a1',
        state: 'settled',
        reason: ruling,
        adjudicated_by: null,
        exit: { action: '按决定继续或排除', object: 'synth-doc:case-3#a1', owner: '程序', due: '脚本编写之前' },
      },
    ],
    // Decoy: pack never writes this; must not be read for rulings.
    adjudication: {
      states: [{ atom: 'a1', state: 'settled', reason: '使用者决定：旧路径诱饵，不得出现在任务书' }],
    },
  });
  const brief = buildCompileBrief({
    item,
    index: '18',
    knowledge: emptyKnowledge(),
    policy: null,
    round: 1,
    mode: 'initial',
  });
  assert.ok(brief);
  assert.equal(brief!.task.user_rulings.length, 1);
  assert.equal(brief!.task.user_rulings[0]!.source, 'record.sources.states');
  assert.equal(brief!.task.user_rulings[0]!.target, 'a1');
  assert.equal(brief!.task.user_rulings[0]!.ruling, ruling);
  // Decoy on the non-schema path must not leak into the brief payload.
  assert.doesNotMatch(JSON.stringify(brief!.task.user_rulings), /旧路径诱饵/);
});

test('buildCompileBrief does not take user rulings from record.adjudication.states', () => {
  const item = makeRealShapeItem({
    id: 'synth-doc:case-4',
    autoid: '990000000000000404',
    title: '合成用例：无 sources 裁定诱饵',
    receipt: `rec:${'f'.repeat(64)}`,
    atoms: [],
    adjudication: {
      states: [{ atom: 'a9', state: 'settled', reason: '使用者决定：仅写在 adjudication，不应进任务书' }],
    },
  });
  const brief = buildCompileBrief({
    item,
    index: '19',
    knowledge: emptyKnowledge(),
    policy: null,
    round: 1,
    mode: 'initial',
  });
  assert.ok(brief);
  assert.equal(brief!.task.user_rulings.length, 0);
  assert.doesNotMatch(JSON.stringify(brief!.task.user_rulings), /仅写在 adjudication/);
});

test('extractScopeUserRulings + buildCompileBrief lift post-recompose scope.md rulings without reading adjudication.states', () => {
  const autoid = '990000000000000405';
  const otherAutoid = '990000000000000406';
  const scopeMd = [
    '# 使用者原话，由主会话记录',
    '只做 dnssec 两条；其余暂缓。',
    '使用者决定：全局禁止改动默认区域文件',
    '',
    `## ${autoid}（单案决定）`,
    '### 补充追问',
    '- 使用者决定：保留原配置，本条按现有设备行为校验',
    '这条只是普通范围说明，不算裁定前缀。',
    '',
    `## ${otherAutoid}`,
    '使用者决定：其他用例决定不得串入当前用例',
  ].join('\n');
  const extracted = extractScopeUserRulings(scopeMd, new Set(['synth-doc:case-5', autoid]), autoid);
  assert.deepEqual(extracted, [
    { target: autoid, ruling: '使用者决定：全局禁止改动默认区域文件' },
    { target: autoid, ruling: '使用者决定：保留原配置，本条按现有设备行为校验' },
  ]);

  const item = makeRealShapeItem({
    id: 'synth-doc:case-5',
    autoid,
    title: '合成用例：重组后 scope.md 界面决定并入 user_rulings',
    receipt: `rec:${'1'.repeat(64)}`,
    atoms: [{ id: 'a1', kind: 'intent', text: 'synthetic step', quote_ref: Q1, span: [0, 14] }],
    states: [
      // Already settled pre-submit with identical line -> deduplicated cleanly.
      { atom: 'a1', state: 'settled', reason: '使用者决定：保留原配置，本条按现有设备行为校验', adjudicated_by: null, exit: null },
    ],
    adjudication: {
      states: [{ atom: 'a2', state: 'settled', reason: '使用者决定：旧 adjudication 路径仍不得读取' }],
    },
  });
  const brief = buildCompileBrief({
    item,
    index: '20',
    knowledge: emptyKnowledge(),
    policy: null,
    round: 1,
    mode: 'initial',
    scopeRulings: extracted,
  });
  assert.ok(brief);
  assert.equal(brief!.task.user_rulings.length, 2);
  assert.deepEqual(brief!.task.user_rulings[0], {
    source: 'record.sources.states',
    target: 'a1',
    ruling: '使用者决定：保留原配置，本条按现有设备行为校验',
  });
  assert.deepEqual(brief!.task.user_rulings[1], {
    source: SCOPE_RULINGS_ORIGIN,
    target: autoid,
    ruling: '使用者决定：全局禁止改动默认区域文件',
  });
  const md = renderCompileBriefMd(brief!);
  assert.ok(md.includes('## 已生效的使用者决定'));
  assert.ok(md.includes('- [990000000000000405]（scope.md）：全局禁止改动默认区域文件'));
  assert.doesNotMatch(JSON.stringify(brief!.task.user_rulings), /其他用例决定|旧 adjudication|普通范围说明/);
});

test('Boss 15:02: scan_reason matches prerequisites status, unknowns format readable fields, and all exits disclose none_found / available / manifest_unavailable honestly', () => {
  const prereqs = ['合成前置甲：已就绪', '合成前置乙：对端校验启用'];
  const itemPartial = itemWithSourceStates(prereqs);
  ((itemPartial.fields.recomposition.record as { unknowns: unknown[] }).unknowns).push({
    atom: 'a2',
    missing: '合成缺失参数：对端节点真实地址',
    next_action: '编写模型按环境清单补全',
    audience: '编写模型',
    due: '脚本编写之前',
  });
  const briefPartial = buildCompileBrief({
    item: itemPartial,
    index: '21',
    knowledge: emptyKnowledge(),
    policy: null,
    round: 1,
    mode: 'initial',
    executionFailureMarkers: ['SYNTH_FAIL_MARKER'],
    triggerTypes: ['client', 'server'],
    forbiddenCombinations: ['forbidden_pair_a+b'],
  })!;
  assert.equal(briefPartial.materials.prerequisites.status, 'partial_recompose_only');
  assert.equal(briefPartial.materials.prerequisites.scan_reason, PREREQ_PARTIAL_RECOMPOSE_REASON);
  assert.ok(!briefPartial.materials.prerequisites.scan_reason.includes('均未声明'));
  assert.equal(validateCompileBrief(briefPartial, itemPartial).ok, true);
  assert.ok(briefPartial.materials.original_case.recomposition.unresolved_unknowns[0]?.includes('合成缺失参数：对端节点真实地址'));
  assert.ok(briefPartial.materials.original_case.recomposition.unresolved_unknowns[0]?.includes('下一步：编写模型按环境清单补全'));
  assert.ok(!briefPartial.materials.original_case.recomposition.unresolved_unknowns[0]?.startsWith('{'));
  assert.equal(formatRecomposeUnknown({ missing: 'X', next_action: 'Y' }), 'X（下一步：Y）');
  const formattedDue = formatToolLocalMinute('2026-11-10T00:00:00.000Z');
  const unknownIso = formatRecomposeUnknown({ missing: 'X', next_action: 'Y', audience: '编写模型', due: '2026-11-10T00:00:00.000Z' });
  assert.ok(unknownIso.includes('由谁办：编写模型'));
  assert.ok(unknownIso.includes(`截止：${formattedDue}`));
  assert.ok(!unknownIso.includes('2026-11-10T00:00:00.000Z'));

  // Corrupted brief: partial_recompose_only with "均未声明" scan_reason or wrong status must fail validateCompileBrief.
  const contradictory = structuredClone(briefPartial);
  contradictory.materials.prerequisites.scan_reason = PREREQ_SCAN_REASON;
  assert.equal(validateCompileBrief(contradictory).ok, false);
  const wrongStatus = structuredClone(briefPartial);
  wrongStatus.materials.prerequisites.status = 'none_declared_or_found_in_recompose';
  assert.equal(validateCompileBrief(wrongStatus).ok, false);

  // Truly empty states -> none_declared_or_found_in_recompose MUST say 均未声明.
  const itemNone = makeRealShapeItem({
    id: 'synth-doc:case-none',
    autoid: '990000000000000407',
    title: '合成用例：真无前置',
    receipt: `rec:${'3'.repeat(64)}`,
    atoms: [{ id: 'a1', kind: 'action', text: 'synth step', quote_ref: Q1, span: [0, 10] }],
    states: [{ atom: 'a1', state: 'settled', reason: '无前置', adjudicated_by: null, exit: null }],
  });
  const briefNone = buildCompileBrief({ item: itemNone, index: '22', knowledge: emptyKnowledge(), policy: null, round: 1, mode: 'initial' })!;
  assert.equal(briefNone.materials.prerequisites.status, 'none_declared_or_found_in_recompose');
  assert.equal(briefNone.materials.prerequisites.scan_reason, PREREQ_SCAN_REASON);
  assert.ok(briefNone.materials.prerequisites.scan_reason.includes('均未声明'));

  const role = resolveSubagentRole('脚本编写')!;
  const mdPartial = renderCompileBriefMd(briefPartial);
  const taskPartial = renderTaskBrief({
    role,
    caseRef: briefPartial.identity.autoid,
    caseTitle: briefPartial.identity.title,
    briefPath: 'briefs/21.md',
    outPath: 'plans/21.json',
    skillDir: '/tmp/synth-skill',
    scopeText: '合成范围\n',
    round: 1,
    compileBrief: briefPartial,
  });
  for (const doc of [mdPartial, taskPartial]) {
    assert.ok(doc.includes('用例重组记录（record.sources.states）'));
    for (const line of prereqs) assert.ok(doc.includes(line));
    assert.ok(!doc.includes('均未声明'));
    assert.ok(doc.includes('合成缺失参数：对端节点真实地址'));
    assert.ok(doc.includes('环境清单不可用，manifest_unavailable'));
    assert.ok(doc.includes('Hub 暂不提供'));
    assert.ok(doc.includes('unavailable_from_hub'));
    assert.ok(doc.includes('SYNTH_FAIL_MARKER'));
    assert.ok(doc.includes('forbidden_pair_a+b'));
  }
  assert.ok(taskPartial.includes('Hub 暂不提供，unavailable_from_hub'));
  assert.ok(taskPartial.includes('- 原始用例 / 对象：990000000000000401 合成用例：前置读位'));

  // prior_device_history: none_found must never print the historical disclaimer; available must print entries.
  const briefNoneFound = structuredClone(briefPartial);
  briefNoneFound.prior_device_history.status = 'none_found';
  delete briefNoneFound.prior_device_history.unavailable_reason;
  for (const doc of [
    renderCompileBriefMd(briefNoneFound),
    renderTaskBrief({ role, caseRef: briefNoneFound.identity.autoid, briefPath: 'briefs/21.md', outPath: 'plans/21.json', skillDir: '/tmp/synth-skill', scopeText: '合成范围\n', round: 1, compileBrief: briefNoneFound }),
  ]) {
    assert.ok(doc.includes('未找到此前已上机验证记录（0 条）'));
    assert.ok(!doc.includes('以下为同一原始用例'));
  }

  const briefAvail = structuredClone(briefPartial);
  briefAvail.prior_device_history.status = 'available';
  delete briefAvail.prior_device_history.unavailable_reason;
  briefAvail.prior_device_history.entries = [
    {
      verification_run: 'vrun-991',
      plan_run: 'prun-881',
      build: 'Rel_SYNTH_1_0',
      ended_at: '2026-11-10T00:00:00.000Z',
      verdict: 'pass',
      apv_cmds: ['widget health interval 60', 'show widget health'],
      attribution: { layer: 'product', summary: '合成原因摘要' },
    },
    {
      verification_run: 'vrun-992',
      plan_run: 'prun-882',
      build: 'Rel_SYNTH_1_1',
      ended_at: '2026-11-11T00:00:00.000Z',
      verdict: 'fail',
      apv_cmds: [],
      attribution: { layer: 'data_gap', summary: '合成缺资料摘要' },
    },
    {
      verification_run: 'vrun-993',
      plan_run: 'prun-883',
      build: 'Rel_SYNTH_1_2',
      ended_at: '2026-11-12T00:00:00.000Z',
      verdict: 'fail',
      apv_cmds: [],
      attribution: { layer: 'internal_raw_enum', summary: '合成未查清摘要' },
    },
  ];
  for (const doc of [
    renderCompileBriefMd(briefAvail),
    renderTaskBrief({ role, caseRef: briefAvail.identity.autoid, briefPath: 'briefs/21.md', outPath: 'plans/21.json', skillDir: '/tmp/synth-skill', scopeText: '合成范围\n', round: 1, compileBrief: briefAvail }),
  ]) {
    assert.ok(doc.includes('vrun-991'));
    assert.ok(doc.includes('脚本编写运行 prun-881'));
    assert.ok(!doc.includes('计划 prun-881'));
    assert.ok(doc.includes(`结束 ${formattedDue}`));
    assert.ok(!doc.includes('2026-11-10T00:00:00.000Z'));
    assert.ok(doc.includes('widget health interval 60 ; show widget health'));
    assert.ok(doc.includes('原因（设备的问题）：合成原因摘要'));
    assert.ok(doc.includes('原因（缺资料）：合成缺资料摘要'));
    assert.ok(doc.includes('原因（还没查清）：合成未查清摘要'));
    assert.ok(!doc.includes('归因（'));
    assert.ok(!doc.includes('原因（product）'));
    assert.ok(!doc.includes('原因（data_gap）'));
    assert.ok(!doc.includes('internal_raw_enum'));
  }
});
