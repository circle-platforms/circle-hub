// Prerequisites in compile-brief@1 must be read from record.sources.states (real recompose shape),
// not record.adjudication.states / record.states (wrong paths that silently yield none).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompileBrief, renderCompileBriefMd, SCOPE_RULINGS_ORIGIN } from './authoring-brief.ts';
import type { BriefKnowledge } from './authoring-brief.ts';
import { extractScopeUserRulings } from './scope.ts';

const ROOT = 'a'.repeat(64);

function emptyKnowledge(): BriefKnowledge {
  return { root: ROOT, nodes: new Map(), lines: new Map(), parameters: new Map() };
}

/** Synthetic shape matching real recomposition records (sources.states), not production case text. */
function itemWithSourceStates(prerequisites: string[]) {
  return {
    id: 'synth-doc:case-1',
    fields: {
      autoid: '990000000000000401',
      title: '合成用例：前置读位',
      expected_nodes: [],
      recomposition: {
        receipt: `rec:${'b'.repeat(64)}`,
        record: {
          schema: 'recompose-record@1',
          case: { id: 'synth-case', title: '合成用例：前置读位' },
          atoms: [
            { id: 'a1', kind: 'action', text: 'synthetic action', quote_ref: `src:${'c'.repeat(64)}/n/1` },
            { id: 'a2', kind: 'action', text: 'synthetic setup', quote_ref: `src:${'c'.repeat(64)}/n/2` },
          ],
          expectation_slots: [],
          ledgers: { adapted: [], original: [], concretizations: [] },
          unknowns: [],
          status: 'complete',
          sources: {
            candidates: [],
            governing: [],
            states: [
              {
                atom: 'a1',
                state: 'settled',
                reason: '合成：本条无前置',
                prerequisites: null,
                adjudicated_by: null,
                exit: { owner: '程序', next: '继续' },
              },
              {
                atom: 'a2',
                state: 'missing_prerequisite',
                reason: '合成：手册点名的功能前置尚未写入计划',
                prerequisites,
                adjudicated_by: null,
                exit: { owner: '编写模型', next: '补前置或 unmet' },
              },
            ],
          },
        },
      },
    },
  };
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
  const item = {
    id: 'synth-doc:case-2',
    fields: {
      autoid: '990000000000000402',
      title: '合成用例：缺 states 形状',
      recomposition: {
        receipt: `rec:${'d'.repeat(64)}`,
        record: {
          schema: 'recompose-record@1',
          case: { id: 'synth-case-2', title: '合成用例：缺 states 形状' },
          atoms: [],
          expectation_slots: [],
          ledgers: { adapted: [] },
          unknowns: [],
          // Wrong legacy shape only — no sources.states
          adjudication: { states: [{ atom: 'a1', state: 'missing_prerequisite', prerequisites: ['旧路径前置'], reason: '不应再读' }] },
        },
      },
    },
  };
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
  const item = {
    id: 'synth-doc:case-3',
    fields: {
      autoid: '990000000000000403',
      title: '合成用例：使用者决定读位',
      expected_nodes: [],
      recomposition: {
        receipt: `rec:${'e'.repeat(64)}`,
        record: {
          schema: 'recompose-record@1',
          case: { id: 'synth-case-3', title: '合成用例：使用者决定读位' },
          atoms: [{ id: 'a1', kind: 'intent', text: 'synthetic intent', quote_ref: `src:${'c'.repeat(64)}/n/1` }],
          expectation_slots: [],
          ledgers: { adapted: [], original: [], concretizations: [] },
          unknowns: [],
          status: 'complete',
          sources: {
            candidates: [],
            governing: [],
            states: [
              {
                atom: 'a1',
                state: 'settled',
                reason: ruling,
                prerequisites: null,
                adjudicated_by: null,
                exit: { owner: '程序', next: '按决定继续或排除' },
              },
            ],
          },
          // Decoy: pack never writes this; must not be read for rulings.
          adjudication: {
            states: [{ atom: 'a1', state: 'settled', reason: '使用者决定：旧路径诱饵，不得出现在任务书' }],
          },
        },
      },
    },
  };
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
  const item = {
    id: 'synth-doc:case-4',
    fields: {
      autoid: '990000000000000404',
      title: '合成用例：无 sources 裁定诱饵',
      recomposition: {
        receipt: `rec:${'f'.repeat(64)}`,
        record: {
          schema: 'recompose-record@1',
          case: { id: 'synth-case-4', title: '合成用例：无 sources 裁定诱饵' },
          atoms: [],
          expectation_slots: [],
          ledgers: { adapted: [] },
          unknowns: [],
          adjudication: {
            states: [{ atom: 'a9', state: 'settled', reason: '使用者决定：仅写在 adjudication，不应进任务书' }],
          },
        },
      },
    },
  };
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

  const item = {
    id: 'synth-doc:case-5',
    fields: {
      autoid,
      title: '合成用例：重组后 scope.md 界面裁定并入 user_rulings',
      recomposition: {
        receipt: `rec:${'1'.repeat(64)}`,
        record: {
          schema: 'recompose-record@1',
          case: { id: 'synth-case-5', title: '合成用例：重组后 scope.md 界面裁定并入 user_rulings' },
          atoms: [{ id: 'a1', kind: 'intent', text: 'synthetic step', quote_ref: `src:${'2'.repeat(64)}/n/1` }],
          expectation_slots: [],
          ledgers: { adapted: [] },
          unknowns: [],
          sources: {
            candidates: [],
            governing: [],
            states: [
              // Already settled pre-submit with identical line -> deduplicated cleanly.
              { atom: 'a1', state: 'settled', reason: '使用者决定：保留原配置，本条按现有设备行为校验', adjudicated_by: null, exit: null },
            ],
          },
          adjudication: {
            states: [{ atom: 'a2', state: 'settled', reason: '使用者决定：旧 adjudication 路径仍不得读取' }],
          },
        },
      },
    },
  };
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
  assert.ok(md.includes('## 已生效使用者裁定'));
  assert.ok(md.includes('使用者决定：全局禁止改动默认区域文件'));
  assert.doesNotMatch(JSON.stringify(brief!.task.user_rulings), /其他用例决定|旧 adjudication|普通范围说明/);
});
