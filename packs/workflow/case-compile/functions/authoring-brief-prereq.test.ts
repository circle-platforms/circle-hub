// Prerequisites in compile-brief@1 must be read from record.sources.states (real recompose shape),
// not record.adjudication.states / record.states (wrong paths that silently yield none).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCompileBrief, renderCompileBriefMd } from './authoring-brief.ts';
import type { BriefKnowledge } from './authoring-brief.ts';

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
  assert.doesNotMatch(JSON.stringify(brief!.materials.prerequisites), /旧路径前置/);
});
