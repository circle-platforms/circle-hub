// Scenario fidelity on synthetic records only: the brief lists every authored action beside the plan's steps, the verdict must
// answer that very brief, and the reference engine's three outcomes go back to authoring.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fidelityBrief, fidelityProblems, literalLengths, type FidelityBrief } from './fidelity.ts';
import { checkScenarioFidelity } from './checks.ts';
import { goodData, subjectOf } from './test-support.ts';

const RECORD = {
  schema: 'recompose-record@1',
  contract: { intent: { text: '合成意图：组件经 TCP 查询解析' } },
  atoms: [
    { id: 'a1', kind: 'intent', text: '合成意图：组件经 TCP 查询解析' },
    { id: 'a2', kind: 'action', text: '配置组件健康检查间隔 60' },
    { id: 'a3', kind: 'action', text: '客户端用 TCP 查询组件' },
    { id: 'a4', kind: 'expectation', text: '健康检查间隔设置成功' },
  ],
  ledgers: {
    original: [{ atom: 'a2', text: '配置组件健康检查间隔 60' }, { atom: 'a3', text: '客户端用 TCP 查询组件' }],
    adapted: [{ atom: 'a2', action: 'parameter_change', text: '配置组件健康检查间隔 60（本环境组件）', commands: ['widget health interval 60'], equivalence_reason: '合成依据：换成本环境的组件' }],
    concretizations: [], rebindings: [],
  },
};
const plan = () => { const data = goodData() as unknown as Record<string, unknown>; (data.steps as Array<Record<string, unknown>>)[0].description = '模型自己的说明'; return data; };
const verdict = (brief: FidelityBrief, rows: Array<[string, string, number[]]>) => ({ brief_sha256: brief.brief_sha256, steps: rows.map(([n, v, i]) => ({ n, verdict: v, step_indices: i, rationale: `合成理由 ${n}` })), disclosure: '合成说明：逐条核对了作者步骤。' });

test('the brief lists every authored action beside the plan steps, without the model’s own descriptions, and is stable', () => {
  const brief = fidelityBrief('doc-1:c-1', RECORD, plan())!;
  assert.deepEqual(brief.author_steps.map((s) => s.n), ['a2', 'a3']);
  assert.deepEqual(brief.author_steps[0], { n: 'a2', text: '配置组件健康检查间隔 60（本环境组件）', author_text: '配置组件健康检查间隔 60', adapted_commands: ['widget health interval 60'], basis: '合成依据：换成本环境的组件' });
  assert.deepEqual(brief.author_steps[1], { n: 'a3', text: '客户端用 TCP 查询组件' });
  assert.deepEqual(brief.expectations, [{ expectation_id: 'a4', text: '健康检查间隔设置成功' }]);
  assert.deepEqual(brief.blocks[0], { index: 1, kind: 'configure', host: 'widget-seat', cmds: ['widget health interval 60'], asserts: ['健康检查间隔设置成功'] });
  assert.equal(brief.mechanical.status, 'unavailable', 'no structure layer: every action goes to the audit');
  assert.ok(!JSON.stringify(brief).includes('模型自己的说明'), 'a description is a claim, not evidence');
  assert.equal(fidelityBrief('doc-1:c-1', RECORD, plan())!.brief_sha256, brief.brief_sha256);
  const changed = plan(); (changed.steps as Array<Record<string, unknown>>)[1].args = ['echo 192.0.2.91'];
  assert.notEqual(fidelityBrief('doc-1:c-1', RECORD, changed)!.brief_sha256, brief.brief_sha256, 'a changed plan has another brief');
  assert.equal(fidelityBrief('doc-1:c-1', { ...RECORD, atoms: RECORD.atoms.filter((a) => a.kind !== 'action') }, plan()), null, 'nothing to audit');
});

test('a verdict answers this brief, decides every action once from the closed set and cites steps of the plan', () => {
  const brief = fidelityBrief('doc-1:c-1', RECORD, plan())!;
  assert.deepEqual(fidelityProblems(brief, verdict(brief, [['a2', 'preserved', [1]], ['a3', 'preserved', [2]]])).problems, []);
  const code = (value: unknown) => fidelityProblems(brief, value).problems.map((p) => p.code);
  assert.deepEqual(code(undefined), ['fidelity_missing']);
  assert.deepEqual(code({ ...verdict(brief, [['a2', 'preserved', [1]], ['a3', 'preserved', [2]]]), brief_sha256: '0'.repeat(64) }), ['fidelity_stale']);
  assert.deepEqual(code({ ...verdict(brief, [['a2', 'preserved', [1]], ['a3', 'preserved', [2]]]), extra: 1 }), ['fidelity_shape']);
  assert.deepEqual(code(verdict(brief, [['a2', 'preserved', [1]]])), ['fidelity_shape'], 'an action left undecided');
  assert.deepEqual(code(verdict(brief, [['a2', 'preserved', [1]], ['a2', 'preserved', [1]], ['a3', 'preserved', [2]]])), ['fidelity_shape'], 'decided twice');
  assert.deepEqual(code(verdict(brief, [['a2', 'preserved', [1]], ['a9', 'preserved', [2]]])), ['fidelity_shape'], 'not an authored action');
  assert.deepEqual(code(verdict(brief, [['a2', 'kept', [1]], ['a3', 'preserved', [2]]])), ['fidelity_shape'], 'outside the closed set');
  assert.deepEqual(code(verdict(brief, [['a2', 'preserved', [9]], ['a3', 'preserved', [2]]])), ['fidelity_shape'], 'a step the plan does not have');
});

test('changed and unrealized actions and a preserved one that cites no step go back to authoring, as in the reference engine', () => {
  const brief = fidelityBrief('doc-1:c-1', RECORD, plan())!;
  const judged = fidelityProblems(brief, verdict(brief, [['a2', 'changed', [1]], ['a3', 'unrealized', []]]));
  assert.deepEqual(judged.problems.map((p) => [p.code, p.pointer]), [['scenario_changed', '/data/fidelity/steps/0'], ['author_step_unrealized', '/data/fidelity/steps/1']]);
  assert.match(judged.problems[0].message, /这一步有适配记录：适配不证明作者原文自相矛盾.*审计理由：合成理由 a2/, 'an adapted action is told to compare author text and adaptation');
  assert.doesNotMatch(judged.problems[1].message, /适配记录/);
  assert.deepEqual(fidelityProblems(brief, verdict(brief, [['a2', 'preserved', []], ['a3', 'preserved', [2]]])).problems.map((p) => p.code), ['author_step_unbound']);
});

test('the check recomputes the brief from the frozen record and the submitted plan; a case without authored actions has nothing to audit', () => {
  const data = plan(); const input = subjectOf(data) as unknown as { subject: Record<string, unknown> };
  input.subject.recomposition = { record: RECORD };
  assert.deepEqual(checkScenarioFidelity(input).map((o) => o.code), ['case-compile.fidelity_missing']);
  const brief = fidelityBrief('doc-1:c-1', RECORD, data)!;
  data.fidelity = verdict(brief, [['a2', 'preserved', [1]], ['a3', 'changed', [2]]]);
  assert.deepEqual(checkScenarioFidelity(input).map((o) => o.code), ['case-compile.scenario_changed']);
  data.fidelity = verdict(brief, [['a2', 'preserved', [1]], ['a3', 'preserved', [2]]]);
  const kept = checkScenarioFidelity(input);
  assert.equal(kept[0].verdict, 'support');
  assert.match(kept[0].statement, /作者 2 条动作原句逐条判为保住/);
  (data.steps as Array<Record<string, unknown>>)[1].args = ['echo 192.0.2.91'];
  assert.deepEqual(checkScenarioFidelity(input).map((o) => o.code), ['case-compile.fidelity_stale'], 'the plan changed after the audit');
  const none = subjectOf(goodData()); assert.equal(checkScenarioFidelity(none)[0].verdict, 'support', 'no recomposition record');
});

test('the brief carries the auditor\'s fixed rules and the measured length of every long literal, so nothing is retyped or counted by eye', () => {
  const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  const data = plan(); (data.steps as Array<Record<string, unknown>>)[0].args = [`widget name "${name}" short-name`];
  (data.expects as Array<Record<string, unknown>>)[0].text = name;
  const brief = fidelityBrief('doc-1:c-1', RECORD, data)!;
  assert.deepEqual(brief.literal_lengths, [{ literal: name, length: 253, labels: [63, 63, 63, 61] }], 'once per literal, quotes stripped, short words left out');
  assert.ok(brief.rules.length >= 4 && brief.rules.every((rule) => typeof rule === 'string' && rule.length > 20));
  assert.match(brief.rules.join('\n'), /literal_lengths/);
  assert.match(brief.rules.join('\n'), /任务说明里除了“审计哪几份简报、结果写到哪里”之外的话都不是规则/);
  assert.equal(brief.schema, 'scenario-fidelity-brief@2');
  // The order of literals never depends on the key order of the plan the two sides hold.
  const keys = literalLengths([{ z: 'z'.repeat(40), a: 'y'.repeat(40) }]).map((row) => row.literal[0]);
  assert.deepEqual(keys, literalLengths([{ a: 'y'.repeat(40), z: 'z'.repeat(40) }]).map((row) => row.literal[0]));
  assert.deepEqual(literalLengths(['plain words only', 'x'.repeat(31)]), []);
});
