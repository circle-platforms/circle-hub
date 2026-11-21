import assert from 'node:assert/strict';
import { test } from 'node:test';
import { embedFidelity, fidelityBrief, fidelityJudgmentProblems, fidelityProblems } from './fidelity.ts';
import { partitionFidelityBlocks } from './fidelity-render.ts';
import { buildFidelityVerdictDocument, mapPlumbSequenceToFidelityRow, mapStepIndices } from './fidelity-bind.ts';

const RECORD = {
  schema: 'recompose-record@1',
  contract: { intent: { text: '验证接口启用与静态路由' } },
  atoms: [
    { id: '1', kind: 'action', text: '配置接口 eth0 地址 192.0.2.10/24' },
    { id: '2', kind: 'action', text: '配置静态路由 198.51.100.0/24 下一跳 192.0.2.1' },
  ],
  ledgers: { original: [], adapted: [], rebindings: [] },
};

const PLAN = {
  bucket: 'bed-1',
  blocks: [],
  steps: [
    { object: 'dut1', method: 'cmd_config', args: ['ip address 192.0.2.10/24'], keywords: {}, author_step_refs: ['1'] },
    { object: 'dut1', method: 'cmd_config', args: ['ip route 198.51.100.0/24 192.0.2.1'], keywords: {}, author_step_refs: ['2'] },
  ],
  expects: [],
  replacements: [],
};

test('mapStepIndices binds explicit references and exact command literals without token or positional inference', () => {
  const brief = fidelityBrief('doc:1', RECORD, PLAN)!;
  const part = partitionFidelityBlocks(brief);
  assert.deepEqual(mapStepIndices(brief, brief.author_steps[0]!, part), { indices: [1], tier: 'author_step_refs' });
  assert.deepEqual(mapStepIndices(brief, brief.author_steps[1]!, part), { indices: [2], tier: 'author_step_refs' });

  const unannotated = structuredClone(PLAN);
  delete (unannotated.steps[0] as Record<string, unknown>).author_step_refs;
  delete (unannotated.steps[1] as Record<string, unknown>).author_step_refs;
  const briefNoRefs = fidelityBrief('doc:2', RECORD, unannotated)!;
  const partNoRefs = partitionFidelityBlocks(briefNoRefs);
  assert.throws(()=>mapPlumbSequenceToFidelityRow({brief:briefNoRefs,authorStep:briefNoRefs.author_steps[0],partitioned:partNoRefs,plumb:{kind:'choice',choice:'保持',value:'保持',confidence:0.95,gate:{action:'pass',calibrated:true}},modelVersion:'synthetic'}),/缺确定的计划步骤对应/);
  const exact=structuredClone(briefNoRefs);exact.author_steps[0].adapted_commands=['ip address 192.0.2.10/24'];
  assert.deepEqual(mapStepIndices(exact,exact.author_steps[0],partitionFidelityBlocks(exact)),{indices:[1],tier:'command_or_rebinding'});
  exact.author_steps[0].adapted_commands=['ip address 198.51.100.99/24'];
  assert.deepEqual(mapStepIndices(exact,exact.author_steps[0],partitionFidelityBlocks(exact)),{indices:[],tier:'none'});

  assert.deepEqual(mapStepIndices(briefNoRefs, briefNoRefs.author_steps[0]!, partNoRefs).indices, []);
  assert.deepEqual(mapStepIndices(briefNoRefs, briefNoRefs.author_steps[1]!, partNoRefs).indices, []);
});

test('mapPlumbSequenceToFidelityRow implements Option A1 gate mapping and fail-closed unbound guard', () => {
  const brief = fidelityBrief('doc:1', RECORD, PLAN)!;
  const part = partitionFidelityBlocks(brief);

  const d1 = mapPlumbSequenceToFidelityRow({
    brief,
    authorStep: brief.author_steps[0]!,
    partitioned: part,
    plumb: { kind: 'choice', choice: '保持', value: '保持', confidence: 0.95, gate: { action: 'pass', calibrated: true } },
    modelVersion: 'plumb-27b-0.5.0',
    requestSha256: 'a'.repeat(64),
  });
  assert.equal(d1.row.verdict, 'preserved');
  assert.equal(d1.reviewRequired, false);
  assert.equal(d1.row.model_judgment?.status, '未确认');

  const dReview = mapPlumbSequenceToFidelityRow({
    brief,
    authorStep: brief.author_steps[1]!,
    partitioned: part,
    plumb: { kind: 'choice', choice: '保持', value: '保持', confidence: 0.62, gate: { action: 'review', calibrated: true } },
    modelVersion: 'plumb-27b-0.5.0',
    requestSha256: 'b'.repeat(64),
  });
  assert.equal(dReview.row.verdict, 'preserved');
  assert.equal(dReview.reviewRequired, true);
  assert.match(dReview.row.rationale, /需人工复核/);

  const dStrict = mapPlumbSequenceToFidelityRow({
    brief,
    authorStep: brief.author_steps[1]!,
    partitioned: part,
    plumb: { kind: 'choice', choice: '保持', value: '保持', confidence: 0.62, gate: { action: 'review', calibrated: true } },
    modelVersion: 'plumb-27b-0.5.0',
    strictReview: true,
  });
  assert.equal(dStrict.row.verdict, 'changed');
  assert.equal(dStrict.reviewRequired, true);

  const dReject = mapPlumbSequenceToFidelityRow({
    brief,
    authorStep: brief.author_steps[1]!,
    partitioned: part,
    plumb: { kind: 'choice', choice: '保持', value: '保持', confidence: 0.25, gate: { action: 'reject', calibrated: true } },
    modelVersion: 'plumb-27b-0.5.0',
  });
  assert.equal(dReject.row.verdict, 'changed');

  const doc = buildFidelityVerdictDocument({
    brief,
    decisions: [d1, dReview],
    partitioned: part,
    modelVersion: 'plumb-27b-0.5.0',
    requestSha256: 'c'.repeat(64),
  });
  assert.match(doc.disclosure, /\[需人工复核：Plumb sequence 落入 review 区\]/);
  assert.deepEqual(doc.model_disclosure.review_required_steps, ['2']);
  assert.deepEqual(fidelityJudgmentProblems(brief, doc).problems, []);
  assert.deepEqual(fidelityProblems(brief, embedFidelity(brief, doc)).problems, []);
});
