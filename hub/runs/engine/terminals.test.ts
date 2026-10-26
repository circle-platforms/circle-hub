import {partitionItems} from './partitions.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REASON, SOURCE_ROLE } from '../../../contracts/generated/vocabulary.ts';
import type { RequirementTemplate } from '../../../contracts/src/pack.ts';
import { LayerResult,partitionCountsOf } from '../../../contracts/src/validation.ts';
import type { CheckOutcome } from '../../rules/api.ts';
import {
  applyRouting,
  bindRecovery,
  attributionByReason,
  attributionByRole,
  dynamicLayer,
  expectationFor,
  isUnsettled,
  itemCell,
  repairRounds,
  requirementStatus,
  staticLayer,
  staticTerminal,
  type Expectation,
  type JudgedOutcome,
} from './terminals.ts';

const support = (extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ verdict: 'support', statement: '一致', grounds: [], tier: 'blocking', ...extra });
const refute = (code: string, extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ verdict: 'refute', code, statement: `反驳 ${code}`, grounds: [], tier: 'blocking', ...extra });
const unknown = (reason: CheckOutcome['reason'], extra: Partial<CheckOutcome> = {}): CheckOutcome => ({ verdict: 'unknown', reason, statement: '未知', grounds: [], tier: 'blocking', ...extra });
const judged = (outcome: CheckOutcome, judges: JudgedOutcome['judges'] = 'subject', check = 'c'): JudgedOutcome => ({ outcome, judges, check });
const SUPPORT: Expectation = { outcome: 'support', codes: [] };

function template(extra: Partial<RequirementTemplate> = {}): RequirementTemplate {
  return {
    key: 'r',
    name: 'r',
    description: 'r',
    target: 'item',
    required: true,
    done_rule: 'bookkeeping',
    layers: ['static'],
    accepted_producer: 'fact',
    checks: ['c'],
    error_handling: [],
    ...extra,
  };
}

const fact = (outcomes: JudgedOutcome[], expectation = SUPPORT, checks = 1) =>
  staticTerminal({ producer: 'fact', hasProducer: true, checks, outcomes, handling: null, expectation });

test('fact terminals: all support pass, any refute violation, unknown by its reason (V01 R[6]), no check no_check', () => {
  assert.equal(fact([judged(support()), judged(support())]).terminal, 'pass');
  const v = fact([judged(support()), judged(refute('core.structure.required_empty'))]);
  assert.equal(v.terminal, 'violation');
  assert.equal(v.code, 'core.structure.required_empty');
  assert.equal(v.tier, 'blocking');
  const u = fact([judged(unknown('missing_input'))]);
  assert.deepEqual([u.terminal, u.reason], ['unchecked', 'missing_input']);
  // support next to an unknown is not a pass: unknown is never hidden (V03 R[3])
  assert.equal(fact([judged(support()), judged(unknown('integrity_unproven'))]).terminal, 'unchecked');
  // a check that errs or times out in the sandbox is unknown, not incomplete (V01 R[2], R[6]; V03 R[4])
  const s = fact([judged(unknown('timeout', { data: { sandbox: 'SANDBOX_TIMEOUT' } }))]);
  assert.deepEqual([s.terminal, s.reason], ['unchecked', 'timeout']);
  const e = fact([judged(unknown('check_error', { data: { sandbox: 'FUNCTION_THREW' } })), judged(support())]);
  assert.deepEqual([e.terminal, e.reason], ['unchecked', 'check_error']);
  // the same reason without the sandbox marker gives the same terminal: a pack function's data cannot steer it
  assert.deepEqual(fact([judged(unknown('check_error'))]), fact([judged(unknown('check_error', { data: { sandbox: 'FUNCTION_THREW' } }))]));
  // a used-up budget is incomplete wherever it was used up (P11 R[3]), and stronger than an unknown of another check
  for (const data of [undefined, { sandbox: 'SANDBOX_UNAVAILABLE', reason: 'queue_full' }]) {
    const b = fact([judged(unknown('missing_input')), judged(unknown('budget_exhausted', data === undefined ? {} : { data }))]);
    assert.deepEqual([b.terminal, b.reason], ['unchecked', 'missing_input']);
  }
  // a refutation wins over an unknown or a used-up budget of another check
  assert.equal(fact([judged(unknown('check_error', { data: { sandbox: 'FUNCTION_THREW' } })), judged(refute('core.catalog.not_member'))]).terminal, 'violation');
  assert.equal(fact([judged(unknown('budget_exhausted')), judged(refute('core.catalog.not_member'))]).terminal, 'violation');
  assert.deepEqual([fact([], SUPPORT, 0).terminal, fact([], SUPPORT, 0).reason], ['unchecked', 'no_check']);
  assert.deepEqual([fact([], SUPPORT, 2).terminal, fact([], SUPPORT, 2).reason], ['unchecked', 'check_error']);
});

test('the violation shows a blocking refutation first, and an unexpected one before an expected one', () => {
  const r = fact([judged(refute('core.catalog.param_out_of_range', { tier: 'advisory' })), judged(refute('core.catalog.not_member'))]);
  assert.equal(r.code, 'core.catalog.not_member');
  assert.equal(r.tier, 'blocking');
  const negative: Expectation = { outcome: 'refute', codes: ['core.catalog.param_out_of_range'] };
  const mixed = fact([judged(refute('core.catalog.param_out_of_range', { tier: 'advisory' })), judged(refute('core.catalog.arity_mismatch', { tier: 'advisory' }))], negative);
  assert.equal(mixed.code, 'core.catalog.arity_mismatch');
  assert.equal(mixed.expectedRefutation, false);
  const expected = fact([judged(refute('core.catalog.param_out_of_range', { tier: 'advisory' }))], negative);
  assert.equal(expected.expectedRefutation, true);
  assert.equal(expected.unexpected.length, 0);
});

test('a skipped fact requirement is incomplete at every declared layer (W07 R[2])', () => {
  const skipped = staticTerminal({ producer: 'fact', hasProducer: true, checks: 1, outcomes: [judged(support())], handling: 'skipped', expectation: SUPPORT });
  assert.deepEqual([skipped.terminal, skipped.reason], ['incomplete', 'declared_skip']);
  const unproduced = staticTerminal({ producer: 'independent_judgment', hasProducer: false, checks: 0, outcomes: [], handling: 'skipped', expectation: SUPPORT });
  assert.deepEqual([unproduced.terminal, unproduced.reason], ['incomplete', 'declared_skip']);
});

test('a missing fact requirement is incomplete because the submission did not cover it (W07 R[3])', () => {
  const missing = staticTerminal({ producer: 'fact', hasProducer: true, checks: 1, outcomes: [judged(support())], handling: 'not_covered', expectation: SUPPORT });
  assert.deepEqual([missing.terminal, missing.reason], ['incomplete', 'not_covered']);
  const unproduced = staticTerminal({ producer: 'independent_judgment', hasProducer: false, checks: 0, outcomes: [], handling: 'not_covered', expectation: SUPPORT });
  assert.deepEqual([unproduced.terminal, unproduced.reason], ['incomplete', 'not_covered']);
});

test('judgment terminals: handled judgment, skipped declared_skip, missing not_covered, no slot no_producer', () => {
  const base = { producer: 'independent_judgment' as const, hasProducer: true, checks: 2, expectation: SUPPORT };
  assert.equal(staticTerminal({ ...base, outcomes: [judged(support(), 'artifact_under_verification')], handling: 'handled' }).terminal, 'judgment');
  assert.equal(staticTerminal({ ...base, outcomes: [], handling: 'handled' }).terminal, 'judgment');
  const violated = staticTerminal({ ...base, outcomes: [judged(refute('core.catalog.membership_contradicted'), 'artifact_under_verification')], handling: 'handled' });
  assert.deepEqual([violated.terminal, violated.code], ['violation', 'core.catalog.membership_contradicted']);
  const skipped = staticTerminal({ ...base, outcomes: [], handling: 'skipped' });
  assert.deepEqual([skipped.terminal, skipped.reason], ['incomplete', 'declared_skip']);
  const missing = staticTerminal({ ...base, outcomes: [], handling: 'not_covered' });
  assert.deepEqual([missing.terminal, missing.reason], ['incomplete', 'not_covered']);
  const orphan = staticTerminal({ ...base, hasProducer: false, outcomes: [], handling: 'handled' });
  assert.deepEqual([orphan.terminal, orphan.reason], ['unchecked', 'no_check']);
});

test('negative-case expectations come from the template overrides on the item fields', () => {
  const t = template({ expected: { overrides: [{ when: { pointer: '/negative', equals: true }, outcome: 'refute', codes: ['core.catalog.param_out_of_range'] }] } });
  assert.deepEqual(expectationFor(t, { negative: true }), { outcome: 'refute', codes: ['core.catalog.param_out_of_range'] });
  assert.deepEqual(expectationFor(t, { negative: false }), SUPPORT);
  assert.deepEqual(expectationFor(t, {}), SUPPORT);
  assert.deepEqual(expectationFor(template(), { negative: true }), SUPPORT);
});

test('status: pending while unsettled, outcome_mismatch when a settled terminal misses, satisfied otherwise, no_producer', () => {
  const pass: LayerResult = { layer: 'static', terminal: 'pass' };
  const violation: LayerResult = { layer: 'static', terminal: 'violation', code: 'core.catalog.param_out_of_range', tier: 'advisory' };
  const base = { hasProducer: true, expectation: SUPPORT, expectedRefutation: false, independence: null, acceptsDeclared: false };
  assert.deepEqual(requirementStatus({ ...base, layers: [pass] }), { status: 'satisfied' });
  assert.deepEqual(requirementStatus({ ...base, layers: [violation] }), { status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch' });
  assert.deepEqual(requirementStatus({ ...base, layers: [{ layer: 'static', terminal: 'unchecked', reason: 'no_check' }] }), { status: 'pending' });
  assert.deepEqual(requirementStatus({ ...base, layers: [{ layer: 'static', terminal: 'incomplete', reason: 'timeout' }] }), { status: 'pending' });
  // a declared dynamic layer that is not run keeps the requirement pending even when the static layer passes
  assert.deepEqual(requirementStatus({ ...base, layers: [pass, dynamicLayer()] }), { status: 'pending' });
  // a negative case: the expected refutation is satisfied, a pass is not
  const negative: Expectation = { outcome: 'refute', codes: ['core.catalog.param_out_of_range'] };
  assert.deepEqual(requirementStatus({ ...base, expectation: negative, expectedRefutation: true, layers: [violation] }), { status: 'satisfied' });
  assert.deepEqual(requirementStatus({ ...base, expectation: negative, expectedRefutation: false, layers: [violation] }), { status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch' });
  assert.deepEqual(requirementStatus({ ...base, expectation: negative, layers: [pass] }), { status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch' });
  assert.deepEqual(requirementStatus({ ...base, hasProducer: false, layers: [{ layer: 'static', terminal: 'unchecked', reason: 'no_check' }] }), { status: 'unsatisfied', unsatisfied_reason: 'no_producer' });
});

test('status of an independent judgment: satisfied only when independent and declared independence is accepted', () => {
  const judgment: LayerResult = { layer: 'static', terminal: 'judgment' };
  const base = { hasProducer: true, expectation: SUPPORT, expectedRefutation: false, layers: [judgment] };
  assert.deepEqual(requirementStatus({ ...base, independence: 'independent', acceptsDeclared: true }), { status: 'satisfied' });
  assert.deepEqual(requirementStatus({ ...base, independence: 'independent', acceptsDeclared: false }), { status: 'unsatisfied', unsatisfied_reason: 'independence_unknown' });
  assert.deepEqual(requirementStatus({ ...base, independence: 'not_independent', acceptsDeclared: true }), { status: 'unsatisfied', unsatisfied_reason: 'independence_unknown' });
  assert.deepEqual(requirementStatus({ ...base, independence: 'unknown', acceptsDeclared: true }), { status: 'unsatisfied', unsatisfied_reason: 'independence_unknown' });
  // a mismatch is reported before independence
  const violated = { ...base, layers: [{ layer: 'static', terminal: 'violation', code: 'x.y' } as LayerResult] };
  assert.deepEqual(requirementStatus({ ...violated, independence: 'independent', acceptsDeclared: true }), { status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch' });
});

test('attribution only on non-pass terminals that miss the expectation, by rule tables', () => {
  for (const reason of REASON) assert.ok(typeof attributionByReason(reason) === 'string');
  for (const role of SOURCE_ROLE) assert.ok(typeof attributionByRole(role) === 'string');
  const t = template();
  const subjectViolation = applyRouting(fact([judged(refute('core.structure.required_empty'), 'subject')]), t, 0);
  assert.equal(staticLayer(subjectViolation, SUPPORT).attribution, 'author_input');
  const producerViolation = applyRouting(fact([judged(refute('core.catalog.membership_contradicted'), 'artifact_under_verification')]), t, 0);
  assert.equal(staticLayer(producerViolation, SUPPORT).attribution, 'producer_error');
  const negative: Expectation = { outcome: 'refute', codes: ['core.catalog.param_out_of_range'] };
  const expected = applyRouting(fact([judged(refute('core.catalog.param_out_of_range', { tier: 'advisory' }))], negative), t, 0);
  const layer = staticLayer(expected, negative);
  assert.equal(layer.terminal, 'violation');
  assert.equal(layer.attribution, undefined);
  assert.equal(layer.tier, 'advisory');
  assert.equal(staticLayer(applyRouting(fact([judged(support())]), t, 0), SUPPORT).attribution, undefined);
  assert.equal(staticLayer(applyRouting(fact([judged(unknown('timeout', { data: { sandbox: 'SANDBOX_TIMEOUT' } }))]), t, 0), SUPPORT).attribution, 'transient');
  assert.equal(staticLayer(applyRouting(fact([judged(unknown('missing_input'))]), t, 0), SUPPORT).attribution, 'data_gap');
  const judgment = staticLayer(applyRouting(staticTerminal({ producer: 'judgment', hasProducer: true, checks: 0, outcomes: [], handling: 'handled', expectation: SUPPORT }), t, 0), SUPPORT);
  assert.equal(judgment.attribution, undefined);
  // every layer the functions build is a valid layer result of the contract
  for (const l of [layer, judgment, dynamicLayer()]) assert.ok(LayerResult.safeParse(bindRecovery(l,{runner:'usr_00000000000000000000000001',owner:'usr_00000000000000000000000002',administrator:'usr_00000000000000000000000003',due:'2026-10-25T00:00:00.000Z',location:'synthetic'})).success, JSON.stringify(l));
});

test('error routing: repair with rounds left and exhaustion, request waits, unknown records unknown, reject keeps the violation', () => {
  const rows = (action: 'repair' | 'reject' | 'request' | 'unknown') =>
    template({ error_handling: [action === 'repair' ? { code: 'core.catalog.membership_contradicted', action, max_rounds: 2 } : { code: 'core.catalog.membership_contradicted', action }] });
  const raw = fact([judged(refute('core.catalog.membership_contradicted'), 'artifact_under_verification')]);
  const first = applyRouting(raw, rows('repair'), 0);
  assert.deepEqual([first.terminal, first.action, first.routed[0].roundsLeft], ['violation', 'repair', 2]);
  assert.equal(applyRouting(raw, rows('repair'), 1).routed[0].roundsLeft, 1);
  const exhausted = applyRouting(raw, rows('repair'), 2);
  assert.deepEqual([exhausted.terminal, exhausted.reason, exhausted.code, exhausted.routed[0].roundsLeft], ['incomplete', 'repair_exhausted', 'core.catalog.membership_contradicted', 0]);
  const request = applyRouting(raw, rows('request'), 0);
  assert.deepEqual([request.terminal, request.reason], ['incomplete', 'awaiting_step']);
  const unknownRow = applyRouting(raw, rows('unknown'), 0);
  assert.deepEqual([unknownRow.terminal, unknownRow.reason, unknownRow.code, unknownRow.action], ['violation', undefined, 'core.catalog.membership_contradicted', 'unknown']);
  assert.equal(staticLayer(unknownRow, SUPPORT).attribution, 'unattributed');
  const reject = applyRouting(raw, rows('reject'), 0);
  assert.deepEqual([reject.terminal, reject.action], ['violation', 'reject']);
  // '*' matches any other code; no row leaves the violation as it is
  const star = applyRouting(raw, template({ error_handling: [{ code: '*', action: 'request' }] }), 0);
  assert.equal(star.terminal, 'incomplete');
  const none = applyRouting(raw, template(), 0);
  assert.deepEqual([none.terminal, none.action, none.routed.length], ['violation', null, 0]);
  // an expected refutation is never routed
  const negative: Expectation = { outcome: 'refute', codes: ['core.catalog.membership_contradicted'] };
  const quiet = applyRouting(fact([judged(refute('core.catalog.membership_contradicted'))], negative), rows('repair'), 5);
  assert.deepEqual([quiet.terminal, quiet.routed.length], ['violation', 0]);
  assert.equal(repairRounds(rows('repair')), 2);
  assert.equal(repairRounds(rows('reject')), 0);
});

test('a row applies by the role the refuting check judges: repair and reject only to the artifact under verification (T03 R[4], W02 F[7])', () => {
  const star = (action: 'repair' | 'reject' | 'request' | 'unknown') => template({ error_handling: [action === 'repair' ? { code: '*', action, max_rounds: 1 } : { code: '*', action }] });
  const onSubject = fact([judged(refute('core.structure.required_empty'), 'subject')]);
  for (const used of [0, 1, 5]) {
    // a defect of the target is delivered content: nobody can repair the target through a submission, no round is counted
    const repaired = applyRouting(onSubject, star('repair'), used);
    assert.deepEqual([repaired.terminal, repaired.action, repaired.routed.length], ['violation', null, 0], `used ${used}`);
    assert.equal(staticLayer(repaired, SUPPORT).attribution, 'author_input');
  }
  for (const role of ['expected', 'hint', 'reported_actual'] as const) {
    assert.deepEqual(applyRouting(fact([judged(refute('p.code'), role)]), star('repair'), 0).routed, [], role);
  }
  // reject only for a blocking check on the artifact under verification
  assert.equal(applyRouting(onSubject, star('reject'), 0).action, null);
  assert.equal(applyRouting(fact([judged(refute('p.code', { tier: 'advisory' }), 'artifact_under_verification')]), star('reject'), 0).action, null);
  const rejected = applyRouting(fact([judged(refute('p.code'), 'artifact_under_verification')]), star('reject'), 0);
  assert.deepEqual([rejected.action, rejected.lead?.outcome.code], ['reject', 'p.code']);
  // request and unknown apply to any role
  assert.deepEqual([applyRouting(onSubject, star('request'), 0).terminal, applyRouting(onSubject, star('request'), 0).reason], ['incomplete', 'awaiting_step']);
  const unknownOnSubject = applyRouting(onSubject, star('unknown'), 0);
  assert.equal(unknownOnSubject.terminal, 'violation');
  assert.equal(staticLayer(unknownOnSubject, SUPPORT).attribution, 'unattributed');
  // the primary refutation leads when its row applies, else the first routed one decides the terminal and shows its code
  const mixed = fact([judged(refute('core.structure.required_empty'), 'subject', 's'), judged(refute('p.statement'), 'artifact_under_verification', 'a')]);
  const early = applyRouting(mixed, star('repair'), 0);
  assert.deepEqual([early.terminal, early.code, early.lead?.check, early.routed.map((r) => r.outcome.check)], ['violation', 'core.structure.required_empty', 'a', ['a']]);
  const late = applyRouting(mixed, star('repair'), 1);
  assert.deepEqual([late.terminal, late.reason, late.code, late.primary?.check], ['incomplete', 'repair_exhausted', 'p.statement', 'a']);
});

test('a requirement incomplete at every declared layer: skipped, not covered, repair or budget used up; otherwise the dynamic layer is not run', () => {
  const base = { producer: 'independent_judgment' as const, hasProducer: true, checks: 1, expectation: SUPPORT };
  const skipped = applyRouting(staticTerminal({ ...base, outcomes: [], handling: 'skipped' }), template(), 0);
  assert.deepEqual(dynamicLayer(skipped), { layer: 'dynamic', terminal: 'incomplete', reason: 'declared_skip', attribution: 'unattributed' });
  const missing = applyRouting(staticTerminal({ ...base, outcomes: [], handling: 'not_covered' }), template(), 0);
  assert.deepEqual(dynamicLayer(missing), { layer: 'dynamic', terminal: 'incomplete', reason: 'not_covered', attribution: 'producer_error' });
  const repairRow = template({ error_handling: [{ code: 'p.code', action: 'repair', max_rounds: 1 }] });
  const exhausted = applyRouting(staticTerminal({ ...base, outcomes: [judged(refute('p.code'), 'artifact_under_verification')], handling: 'handled' }), repairRow, 1);
  assert.deepEqual(dynamicLayer(exhausted), { layer: 'dynamic', terminal: 'incomplete', reason: 'repair_exhausted', attribution: 'producer_error' });
  assert.equal(dynamicLayer(applyRouting(fact([judged(unknown('budget_exhausted'))]), template(), 0)).terminal, 'not_run');
  // a request waiting, an unknown, a pass: the dynamic layer has no check of its own, not run
  for (const raw of [fact([judged(unknown('timeout'))]), fact([judged(support())]), staticTerminal({ ...base, outcomes: [], handling: 'handled' })]) {
    assert.deepEqual(dynamicLayer(applyRouting(raw, template(), 0)), dynamicLayer());
  }
  assert.equal(dynamicLayer(applyRouting(fact([judged(refute('p.code'), 'subject')]), template({ error_handling: [{ code: '*', action: 'request' }] }), 0)).terminal, 'not_run');
  for (const l of [dynamicLayer(skipped), dynamicLayer(exhausted)]) assert.ok(LayerResult.safeParse(bindRecovery(l,{runner:'usr_00000000000000000000000001',owner:'usr_00000000000000000000000002',administrator:'usr_00000000000000000000000003',due:'2026-10-25T00:00:00.000Z',location:'synthetic'})).success, JSON.stringify(l));
});

test('item cell: strongest terminal per layer with the counts of the other non-pass terminals; undeclared layers have none', () => {
  const r = (requirement: string, layers: LayerResult[]) => ({ requirement, layers, status: 'pending' as const, claims: [] });
  const cell = itemCell([
    r('a', [{ layer: 'static', terminal: 'pass' }]),
    r('b', [{ layer: 'static', terminal: 'unchecked', reason: 'no_check' }]),
    r('c', [{ layer: 'static', terminal: 'judgment' }]),
  ]);
  assert.equal(cell.static?.terminal, 'unchecked');
  assert.deepEqual(cell.static?.counts, { unchecked: 1, judgment: 1 });
  assert.equal(cell.dynamic, undefined);
  const worst = itemCell([
    r('a', [{ layer: 'static', terminal: 'incomplete', reason: 'timeout' }, dynamicLayer()]),
    r('b', [{ layer: 'static', terminal: 'violation', code: 'x.y' }]),
  ]);
  assert.equal(worst.static?.terminal, 'violation');
  assert.deepEqual(worst.static?.counts, { incomplete: 1, violation: 1 });
  assert.equal(worst.dynamic?.terminal, 'not_run');
  assert.equal(itemCell([r('a', [{ layer: 'static', terminal: 'pass' }])]).static?.terminal, 'pass');
  assert.ok(isUnsettled({ layer: 'dynamic', terminal: 'no_verdict', reason: 'integrity_unproven' }));
  assert.ok(!isUnsettled({ layer: 'static', terminal: 'judgment' }));
});

test('a known expectation miss outranks an unsettled layer without changing facts or partition counts',()=>{
  const dynamic=bindRecovery(dynamicLayer(),{runner:'usr_00000000000000000000000001',owner:'usr_00000000000000000000000002',administrator:'usr_00000000000000000000000003',due:'2026-10-25T00:00:00.000Z',location:'synthetic'});
  const layers:LayerResult[]=[{layer:'static',terminal:'violation',code:'synthetic.violation'},dynamic];
  const before=structuredClone(layers);
  const status=requirementStatus({layers,hasProducer:true,expectation:SUPPORT,expectedRefutation:false,independence:null,acceptsDeclared:false});
  assert.deepEqual(status,{status:'unsatisfied',unsatisfied_reason:'outcome_mismatch'});
  assert.deepEqual(layers,before);
  const make=(value:{status:'pending'}|typeof status)=>partitionItems([{item:'synthetic',label:'合成条目',location:'src:'+'a'.repeat(64),requirements:[{requirement:'r',layers,claims:[],...value}],required:new Set(['r']),notCovered:false,rejection:null}],['synthetic']);
  const pending=make({status:'pending'}),unmet=make(status);
  assert.deepEqual(Object.keys(unmet).map(key=>unmet[key as keyof typeof unmet].map(item=>item.item)),Object.keys(pending).map(key=>pending[key as keyof typeof pending].map(item=>item.item)));
  assert.deepEqual(partitionCountsOf(unmet),partitionCountsOf(pending));assert.equal(partitionCountsOf(unmet).unknown,1);
  assert.deepEqual(requirementStatus({layers,hasProducer:true,expectation:{outcome:'refute',codes:['synthetic.violation']},expectedRefutation:true,independence:null,acceptsDeclared:false}),{status:'pending'},'a matching known terminal leaves the other layer pending');
});

test('a judgment cannot satisfy a requirement that accepts facts only',()=>{
  const common={layers:[{layer:'static' as const,terminal:'judgment' as const}],hasProducer:true,expectation:SUPPORT,expectedRefutation:false,independence:null,acceptsDeclared:false};
  assert.deepEqual(requirementStatus({...common,producer:'fact'}),{status:'unsatisfied',unsatisfied_reason:'outcome_mismatch'});
  assert.equal(requirementStatus({...common,producer:'judgment'}).status,'satisfied');
  assert.equal(requirementStatus({...common,producer:'fact',layers:[{layer:'static',terminal:'pass'}]}).status,'satisfied');
});
