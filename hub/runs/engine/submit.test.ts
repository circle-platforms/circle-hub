import { assertLayers } from './testing/assertions.ts';
import assert from 'node:assert/strict';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import { after, before, test } from 'node:test';
import type { Claim } from '../../../contracts/src/claim.ts';
import type { RunSummary } from '../../../contracts/src/run.ts';
import { SubmitResultOutput } from '../../../contracts/src/tools.ts';
import { LayerResult, ValidationResult, partitionCountsOf, type ItemResult } from '../../../contracts/src/validation.ts';
import type { ActionBody } from '../../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { INDEX } from './store.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { ROOTS } from './testing/knowledge.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';

let postgres: TemporaryPostgres;
let h: Harness;
let map: string;
const skip = await sandboxSkip();

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  map = await h.upload(h.alice, toyMap(standardDocument()));
});
after(async () => {
  await h?.close();
  await postgres?.stop();
});

function terminalFields(layers: LayerResult[]): Omit<LayerResult, 'missing' | 'exit' | 'gaps'>[] {
  return layers.map(layer => {
    LayerResult.parse(layer);
    if (layer.reason !== undefined) {
      assert.ok(layer.missing);
      assert.equal(layer.exit?.action, 'request');
      assert.equal(layer.exit?.request_kind, 'repair');
      assert.deepEqual(layer.exit?.audience, { user: h.alice.id });
    }
    const { missing, exit, gaps, ...fields } = layer;
    return fields;
  });
}

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const TITLES: Record<string, string> = { [ITEM.c1]: '设置 3 区浇灌 15 分钟', [ITEM.c2]: '查看分区状态', [ITEM.c3]: '设置 9 区应报错', [ITEM.c4]: '没有期望结果的用例' };
const LEVEL = { nature: 'judgment', statement: '功能点覆盖完整，反向用例偏少', grounds: [], code: 'draft_level', rank: 'P4' };

async function draft(session = 'sess-draft'): Promise<RunSummary> {
  const answer = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } } }, h.call(session));
  assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
  return answer.run!;
}

const locationOf = (run: RunSummary, item: string): string => run.items.find((i) => i.id === item)!.location;

function finding(run: RunSummary, item: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const at = locationOf(run, item);
  return { text: '缺少 0 分钟的边界用例', code: 'edge_case_gap', rank: 'major', location: at, quotes: [{ reference: at, text: TITLES[item] }], ...extra };
}

function submission(run: RunSummary, items: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: run.run,
    model: 'model-a temperature=0',
    items: [ITEM.c1, ITEM.c2, ITEM.c3, ITEM.c4].filter((id) => items[id] !== null).map((id) => items[id] ?? { item: id, handling: 'handled', slots: { findings: [] } }),
    cross_item: [LEVEL],
    ...extra,
  };
}

const handled = (item: string, findings: unknown[]): Record<string, unknown> => ({ item, handling: 'handled', slots: { findings } });

function valid(answer: object): void {
  const checked = SubmitResultOutput.safeParse({ ...answer, trace: TRACE });
  assert.ok(checked.success, checked.success ? '' : JSON.stringify(checked.error.issues.slice(0, 3)));
}

function itemOf(result: ValidationResult, id: string): { partition: string; item: ItemResult } {
  for (const [partition, items] of Object.entries(result.partitions)) {
    const found = (items as ItemResult[]).find((i) => i.item === id);
    if (found) return { partition, item: found };
  }
  throw new Error(`item ${id} is in no partition`);
}

const requirementOf = (item: ItemResult, key: string) => item.requirements.find((r) => r.requirement === key)!;

test('an accepted submission: terminals, satisfaction, attribution, partitions, derived counts', { skip }, async () => {
  const run = await draft();
  const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { commands: [{ command: 'zone set', present: true }] })]) }), h.call('sess-draft'));
  valid(answer);
  assert.deepEqual([answer.call_result, answer.acceptance], ['ok', 'accepted']);
  const result = answer.result!;
  assert.ok(ValidationResult.safeParse(result).success);
  assert.deepEqual(answer.counts, partitionCountsOf(result.partitions));
  assert.deepEqual(answer.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
  assert.deepEqual(result.locks, { pack: run.pack, pack_digest: run.pack_digest, root: ROOTS.meadow329 });
  // c1: every fact passes; the independent judgment has no predecessor, so its independence is unknown (A04 R[5])
  const c1 = itemOf(result, ITEM.c1);
  assert.equal(c1.partition, 'delivered');
  assertLayers(requirementOf(c1.item, 'structure').layers, [{ layer: 'static', terminal: 'pass' }]);
  assertLayers(requirementOf(c1.item, 'findings').layers, [{ layer: 'static', terminal: 'judgment' }]);
  assert.deepEqual([requirementOf(c1.item, 'findings').status, requirementOf(c1.item, 'findings').unsatisfied_reason], ['unsatisfied', 'independence_unknown']);
  // c3: a negative case refuted with the expected code is satisfied, advisory, without attribution
  const c3 = requirementOf(itemOf(result, ITEM.c3).item, 'catalog');
  assert.deepEqual(c3.layers, [{ layer: 'static', terminal: 'violation', code: 'core.catalog.param_out_of_range', tier: 'advisory' }]);
  assert.equal(c3.status, 'satisfied');
  // c4: the author's input misses the structure: violation attributed to the author, outcome mismatch; delivered
  const c4 = itemOf(result, ITEM.c4);
  assert.equal(c4.partition, 'delivered');
  assertLayers(requirementOf(c4.item, 'structure').layers, [{ layer: 'static', terminal: 'violation', code: 'core.structure.required_empty', tier: 'blocking', attribution: 'author_input' }]);
  assert.equal(requirementOf(c4.item, 'structure').unsatisfied_reason, 'outcome_mismatch');
  // nothing was routed: no errors; rounds of the run
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rounds, { used: 0, max: 2 });
  assert.deepEqual(result.coverage, { complete: true, examined: 4, total: 4, note: '提交处理了 4 个条目，共 4 个' });
  // the run-level judgment is a cross-item claim, apart from the partitions
  assert.deepEqual(result.cross_item.map((c) => [c.requirement, c.statement.code, c.statement.rank, c.qualifier.nature]), [['level', 'draft_level', 'P4', 'judgment']]);
  // the result and the validate action are stored
  const stored = await h.kit.store.find<ValidationResult>({ key: INDEX.resultRun, value: run.run, kind: 'validation_result' });
  assert.deepEqual(stored.items[0].body, result);
  const actions = await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' });
  const validate = actions.items.find((a) => a.body.action === 'validate')!;
  assert.deepEqual([validate.body.acceptance, validate.body.codes, validate.body.detail.result], ['accepted', [], stored.items[0].digest]);
  assert.equal(validate.body.detail.session, 'sess-draft');
});

test('claims carry their statements, qualifiers, warrants, resolutions and validity bindings', { skip }, async () => {
  const run = await draft();
  const args = submission(run, {
    [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { grounds: [run.sources[2].reference], commands: [{ command: 'zone set', present: true }, { command: 'zone delete', present: false }], data: { suggestion: '加一条 0 分钟的反向用例' } })]),
  });
  const answer = await h.service.submitResult(h.alice, args, h.call('sess-draft'));
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const c1 = itemOf(answer.result!, ITEM.c1).item;
  const findings = requirementOf(c1, 'findings').claims;
  const judgment = findings.find((c) => c.warrant.producer === 'model')!;
  const sha = map.slice('src:'.length);
  assert.equal(judgment.pointer, '/items/0/slots/findings/0');
  assert.deepEqual(judgment.statement, { text: '缺少 0 分钟的边界用例', code: 'edge_case_gap', rank: 'major', data: { suggestion: '加一条 0 分钟的反向用例' } });
  // the slot record came without a context digest (written in one go): marked no_reuse (W07 F[1], decision row 18 (b))
  assert.deepEqual(judgment.qualifier, { nature: 'judgment', provenance: 'declared', basis_rank: 'judgment', source_role: 'expected', marks: ['semantics_unasserted', 'independence_declared', 'no_reuse'] });
  assert.deepEqual(judgment.warrant, { producer: 'model', id: 'model-a temperature=0', independence: 'unknown' });
  assert.equal(judgment.resolution, 'resolved');
  const pointers = judgment.resolutions!.map((r) => [r.pointer, r.resolution]);
  assert.deepEqual(pointers, [
    ['/items/0/slots/findings/0/location', 'resolved'],
    ['/items/0/slots/findings/0/grounds/0', 'resolved'],
    ['/items/0/slots/findings/0/quotes/0', 'resolved'],
    ['/items/0/slots/findings/0/commands/0', 'resolved'],
  ]);
  // the quotation is pinned to its byte range; the command resolves to the catalog entry of the locked root
  assert.ok(judgment.resolutions![2].references[0].startsWith(`src:${sha}/kityminder@1/n/c1aaaaaaaaaa:0-`));
  assert.ok(judgment.resolutions![3].references.includes(`tree:${ROOTS.meadow329}/zone/set`));
  assert.ok(judgment.grounds.includes(run.sources[2].reference));
  for (const digest of [run.pack_digest, ROOTS.meadow329, sha, run.sources[2].reference.slice(4)]) assert.ok(judgment.validity.bound.includes(digest), digest);
  // every outcome of every check is a Hub fact, support included, with rule@version and the item's bindings
  const facts = findings.filter((c) => c.warrant.producer === 'function');
  assert.deepEqual(facts.map((c) => c.warrant.id).sort(), ['catalog@1', 'catalog@1', 'quote@1', 'toy-review.findings_grounds@1.0.0', 'toy-review.findings_rank@1.0.0']);
  assert.ok(facts.every((c) => c.qualifier.nature === 'fact' && c.qualifier.provenance === 'projected' && c.qualifier.basis_rank === 'rule_over_claims'));
  assert.ok(facts.every((c) => c.qualifier.marks.includes('conditional_on_judgment') && c.warrant.independence === 'judge_not_author'));
  // a fact over the artifact under verification cites the judgments it rests on (V03 R[6], A02 R[3])
  assert.ok(facts.every((c) => c.validity.premises.length > 0 && c.validity.premises.every((p) => p.startsWith('/items/0/slots/findings'))), JSON.stringify(facts.map((c) => c.validity.premises)));
  assert.ok(facts.some((c) => c.validity.premises.includes('/items/0/slots/findings/0')), 'an outcome that points at a statement cites that statement');
  const absent = facts.find((c) => c.statement.data?.command === 'zone delete')!;
  assert.deepEqual([absent.statement.verdict, absent.statement.data?.in_catalog], ['support', false]);
  const structure = requirementOf(c1, 'structure').claims;
  assert.deepEqual(structure.map((c) => [c.statement.verdict, c.warrant.id, c.qualifier.source_role, c.qualifier.basis_rank]), [['support', 'structure@1', 'subject', 'rule_over_observation']]);
  const item = run.items.find((i) => i.id === ITEM.c1)!;
  for (const digest of [run.pack_digest, ROOTS.meadow329, item.digest!, sha]) assert.ok(structure[0].validity.bound.includes(digest), digest);
  // a cross-item claim is bound to the digests of all items (V05 F[4])
  const cross = answer.result!.cross_item[0];
  for (const it of run.items) assert.ok(cross.validity.bound.includes(it.digest!));
});

test('a finding grounded only in a hint source is flagged by its role and does not satisfy the requirement', { skip }, async () => {
  const run = await draft();
  const hint = run.sources.find((s) => s.role === 'hint')!.reference;
  const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c2]: handled(ITEM.c2, [{ text: '历史清单里有类似用例', code: 'coverage_gap', rank: 'minor', grounds: [hint] }]) }), h.call());
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const findings = requirementOf(itemOf(answer.result!, ITEM.c2).item, 'findings');
  const judgment = findings.claims.find((c) => c.warrant.producer === 'model')!;
  assert.equal(judgment.qualifier.source_role, 'hint');
  assertLayers(findings.layers, [{ layer: 'static', terminal: 'violation', code: 'toy-review.hint_only', tier: 'blocking', attribution: 'producer_error' }]);
  assert.deepEqual([findings.status, findings.unsatisfied_reason], ['unsatisfied', 'outcome_mismatch']);
});

test('a cross-item fact and a judgment resting on it are listed apart from the partitions', { skip }, async () => {
  const run = await draft();
  const cross = [
    { nature: 'fact', statement: '两个用例都设置 3 区', grounds: [locationOf(run, ITEM.c1)] },
    { nature: 'judgment', statement: '分区覆盖偏窄', grounds: [], premises: ['/cross_item/0'] },
    LEVEL,
  ];
  const answer = await h.service.submitResult(h.alice, submission(run, {}, { cross_item: cross }), h.call());
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const [fact, judgment, level] = answer.result!.cross_item;
  assert.deepEqual([fact.qualifier.nature, fact.qualifier.marks, fact.requirement], ['judgment', ['semantics_unasserted', 'unverified_submission'], undefined]);
  assert.equal(fact.resolutions?.[0].pointer, '/cross_item/0/grounds/0');
  assert.deepEqual(judgment.validity.premises, ['/cross_item/0']);
  assert.equal(level.requirement, 'level');
  assert.deepEqual(answer.counts, { delivered: 4, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
});

test('the submission is stored exactly as received, even when it is not accepted', { skip }, async () => {
  const run = await draft();
  const args = submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { quotes: [{ reference: locationOf(run, ITEM.c1), text: '设置 3 区浇灌 20 分钟' }] })]) });
  await h.service.submitResult(h.alice, args, h.call());
  const unparsed = { run: run.run, model: 'model-a', items: [{ item: ITEM.c1, handling: 'maybe' }], extra: true };
  const refused = await h.service.submitResult(h.alice, unparsed, h.call());
  valid(refused);
  assert.deepEqual(refused.errors.map((e) => [e.code, e.path]), [
    ['SUBMISSION_SCHEMA_VIOLATION', '/items/0/handling'],
    ['SUBMISSION_SCHEMA_VIOLATION', '/extra'],
    // W08 R[1]: the entries that parse are checked as well; the run-level requirement level has no entry
    ['SUBMISSION_SCHEMA_VIOLATION', '/cross_item'],
    ...Array.from({length:4},()=>['not_covered','/items']),
  ]);
  const lone = { run: run.run, model: 'model-a', items: [], notes: 'broken \ud800 text' };
  const loneAnswer = await h.service.submitResult(h.alice, lone, h.call());
  valid(loneAnswer);
  assert.equal(loneAnswer.acceptance, 'not_accepted');
  assert.deepEqual(loneAnswer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', '/notes']]);
  const stored = await h.kit.store.find<Record<string, unknown>>({ key: INDEX.submissionRun, value: run.run, kind: 'submission' });
  const [first, second, third] = stored.items;
  assert.equal(first.schema, 'submission@1');
  assert.deepEqual(first.body, args);
  assert.equal(second.schema, 'submission-received@1');
  assert.deepEqual(second.body, unparsed);
  assert.equal(third.schema, 'submission-received@1');
  const received = third.body.received as { object: string; sha256: string; non_canonical_path: string };
  const bytes = await h.kit.objects.get(received.object);
  assert.equal(new TextDecoder().decode(bytes!), JSON.stringify(lone));
  assert.equal(received.sha256, received.object);
  assert.equal(received.non_canonical_path, '/notes');
});

test('each whole-rejection case answers with its code and path; no partitions; the receipt carries rounds left', { skip }, async () => {
  const run = await draft();
  const at = locationOf(run, ITEM.c1);
  const other = await h.upload(h.alice, new TextEncoder().encode('{"elsewhere": true}'));
  const cases: [string, Record<string, unknown>, string, string][] = [
    ['quote not verbatim', finding(run, ITEM.c1, { quotes: [{ reference: at, text: '设置 3 区浇灌 20 分钟' }] }), 'QUOTE_MISMATCH', '/items/0/slots/findings/0/quotes/0/text'],
    ['location that does not exist', finding(run, ITEM.c1, { location: at.replace('c1aaaaaaaaaa', 'nonexistent0') }), 'REFERENCE_UNRESOLVED', '/items/0/slots/findings/0/location'],
    ['source not bound to the run', finding(run, ITEM.c1, { grounds: [other] }), 'REFERENCE_UNRESOLVED', '/items/0/slots/findings/0/grounds/0'],
    ['a knowledge entry cited on its own', finding(run, ITEM.c1, { quotes: [{ reference: `entry:${'e'.repeat(64)}`, text: 'x' }] }), 'REFERENCE_UNRESOLVED', '/items/0/slots/findings/0/quotes/0/reference'],
    ['a tree reference into another root', finding(run, ITEM.c1, { grounds: [`tree:${ROOTS.meadow327}/zone/set`] }), 'REFERENCE_UNRESOLVED', '/items/0/slots/findings/0/grounds/0'],
    ['a command found nowhere', finding(run, ITEM.c1, { commands: [{ command: 'zone delete 3', present: true }] }), 'REFERENCE_UNRESOLVED', '/items/0/slots/findings/0/commands/0/command'],
    ['an ambiguous command', finding(run, ITEM.c1, { commands: [{ command: 'schedule', present: true }] }), 'REFERENCE_AMBIGUOUS', '/items/0/slots/findings/0/commands/0/command'],
    ['a code outside the closed set', finding(run, ITEM.c1, { code: 'made_up' }), 'SUBMISSION_SCHEMA_VIOLATION', '/items/0/slots/findings/0/code'],
    ['a statement that is not a SlotClaim', finding(run, ITEM.c1, { quotes: 'not a list' }), 'SUBMISSION_SCHEMA_VIOLATION', '/items/0/slots/findings/0/quotes'],
  ];
  for (const [name, bad, code, path] of cases) {
    const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c1]: handled(ITEM.c1, [bad]) }), h.call());
    valid(answer);
    assert.deepEqual([answer.call_result, answer.acceptance], ['error', 'not_accepted'], name);
    assert.equal(answer.errors[0].code, code, name);
    assert.equal(answer.errors[0].path, path, name);
    assert.equal(answer.errors[0].requirement, 'findings', name);
    assert.equal(typeof answer.errors[0].rounds_left, 'number', name);
    assert.ok(Object.values(answer.result!.partitions).every((p) => p.length === 0), name);
    assert.deepEqual(answer.result!.cross_item, [], name);
    assert.equal(answer.counts, undefined, name);
    if (code === 'REFERENCE_AMBIGUOUS') assert.deepEqual(answer.errors[0].options, ['schedule add', 'schedule list']);
  }
});

// The acceptance mutation check's M12 and M17 as the engine sees them: the quote@1 check the engine runs must
// refuse a quotation that differs only by case, and a quotation whose text is empty, with QUOTE_MISMATCH.
test('the engine refuses a case-different quote and an empty quote (M12, M17)', { skip }, async () => {
  const run = await draft();
  const at = locationOf(run, ITEM.c1);
  // The case's title is '设置 3 区浇灌 15 分钟'; a quote in different case must not match it (QUOTE_MISMATCH). An
  // empty quote is refused even earlier, by the slots schema (minLength, SUBMISSION_SCHEMA_VIOLATION) — either way
  // the engine never accepts it.
  const cases: [string, Record<string, unknown>, string, string][] = [
    ['a case-different ASCII quote', finding(run, ITEM.c1, { quotes: [{ reference: at, text: 'ZONE SET 3 15' }] }), 'QUOTE_MISMATCH', '/items/0/slots/findings/0/quotes/0/text'],
    ['an empty quote', finding(run, ITEM.c1, { quotes: [{ reference: at, text: '' }] }), 'SUBMISSION_SCHEMA_VIOLATION', '/items/0/slots/findings/0/quotes/0/text'],
    ['a white-space-only quote', finding(run, ITEM.c1, { quotes: [{ reference: at, text: ' \n' }] }), 'QUOTE_MISMATCH', '/items/0/slots/findings/0/quotes/0/text'],
  ];
  for (const [name, bad, code, path] of cases) {
    const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c1]: handled(ITEM.c1, [bad]) }), h.call());
    valid(answer);
    assert.deepEqual([answer.call_result, answer.acceptance], ['error', 'not_accepted'], name);
    assert.equal(answer.errors[0].code, code, name);
    assert.equal(answer.errors[0].path, path, name);
    assert.equal(answer.errors[0].requirement, 'findings', name);
  }
});

test('a statement the catalog contradicts is a violation routed into repair, never a whole rejection; rounds go down and run out', { skip }, async () => {
  const run = await draft();
  const contradicted = (n: number) => submission(run, { [ITEM.c2]: handled(ITEM.c2, [finding(run, ITEM.c2, { text: `说 zone show 不存在（第 ${n} 次）`, code: 'literal_issue', commands: [{ command: 'zone show', present: false }] })]) });
  const left: number[] = [];
  let last;
  for (let n = 1; n <= 3; n++) {
    last = await h.service.submitResult(h.alice, contradicted(n), h.call());
    assert.equal(last.acceptance, 'accepted');
    const error = last.errors.find((e) => e.code === 'core.catalog.membership_contradicted')!;
    assert.deepEqual([error.item, error.requirement, error.path], [ITEM.c2, 'findings', '/items/1/slots/findings/0/commands/0']);
    left.push(error.rounds_left!);
    const findings = requirementOf(itemOf(last.result!, ITEM.c2).item, 'findings');
    if (n < 3) {
      assertLayers(findings.layers, [{ layer: 'static', terminal: 'violation', code: 'core.catalog.membership_contradicted', tier: 'blocking', attribution: 'producer_error' }]);
      assert.equal(itemOf(last.result!, ITEM.c2).partition, 'delivered');
    }
  }
  assert.deepEqual(left, [2, 1, 0]);
  // the rounds are used up: incomplete (repair_exhausted) with the original statement kept; the item is incomplete
  const exhausted = itemOf(last!.result!, ITEM.c2);
  assert.equal(exhausted.partition, 'incomplete');
  assert.equal((exhausted.item as { reason?: string }).reason, 'repair_exhausted');
  const findings = requirementOf(exhausted.item, 'findings');
  assertLayers(findings.layers, [{ layer: 'static', terminal: 'incomplete', code: 'core.catalog.membership_contradicted', tier: 'blocking', reason: 'repair_exhausted', attribution: 'producer_error' }]);
  assert.ok(findings.claims.some((c: Claim) => c.warrant.producer === 'model' && c.statement.text.includes('第 3 次')));
  assert.deepEqual(last!.result!.rounds, { used: 2, max: 2 });
  // a corrected statement is delivered again
  const fixed = await h.service.submitResult(h.alice, submission(run), h.call());
  assert.equal(itemOf(fixed.result!, ITEM.c2).partition, 'delivered');
  assert.deepEqual(fixed.errors, []);
});

test('a not-accepted submission still reports the item-level refutations of its other items with rounds left (W08 R[1])', { skip }, async () => {
  const run = await draft();
  const contradiction = handled(ITEM.c2, [finding(run, ITEM.c2, { code: 'literal_issue', commands: [{ command: 'zone show', present: false }] })]);
  const args = submission(run, {
    [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { quotes: [{ reference: locationOf(run, ITEM.c1), text: '不在原文里' }] })]),
    [ITEM.c2]: contradiction,
  });
  const answer = await h.service.submitResult(h.alice, args, h.call());
  assert.equal(answer.acceptance, 'not_accepted');
  assert.deepEqual(answer.errors.map((e) => [e.code, e.item]), [
    ['QUOTE_MISMATCH', ITEM.c1],
    ['core.catalog.membership_contradicted', ITEM.c2],
  ]);
  assert.equal(answer.errors[1].rounds_left, 2);
  // that submission counted as a round for findings
  const next = await h.service.submitResult(h.alice, submission(run, { [ITEM.c2]: contradiction }), h.call());
  assert.equal(next.errors.find((e) => e.code === 'core.catalog.membership_contradicted')?.rounds_left, 1);
});

test('items not covered and items skipped are incomplete; not covered is named in the errors and counts as a round', { skip }, async () => {
  const run = await draft();
  const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c2]: null, [ITEM.c3]: { item: ITEM.c3, handling: 'skipped', reason: '和 c1 重复' } }), h.call());
  assert.equal(answer.acceptance, 'accepted');
  const missing = itemOf(answer.result!, ITEM.c2);
  assert.deepEqual([missing.partition, (missing.item as { reason?: string }).reason], ['incomplete', 'not_covered']);
  assertLayers(requirementOf(missing.item, 'findings').layers, [{ layer: 'static', terminal: 'incomplete', reason: 'not_covered', attribution: 'producer_error' }]);
  // W07 R[3]: the item the submission does not mention is incomplete at every requirement, facts included.
  assertLayers(requirementOf(missing.item, 'structure').layers, [{ layer: 'static', terminal: 'pass' }]);
  const skipped = itemOf(answer.result!, ITEM.c3);
  assert.deepEqual([skipped.partition, (skipped.item as { reason?: string }).reason], ['incomplete', 'declared_skip']);
  assert.deepEqual(answer.errors.map((e) => [e.code, e.item, e.rounds_left]), [['not_covered',ITEM.c2,2],['core.coverage.shortfall', ITEM.c2, 2],['declared_skip',ITEM.c3,2]]);
  assert.deepEqual(answer.result!.coverage, { complete: false, examined: 2, total: 4, note: '提交处理了 2 个条目，共 4 个' });
  const again = await h.service.submitResult(h.alice, submission(run, { [ITEM.c2]: null }), h.call());
  assert.deepEqual(again.errors.map((e) => [e.code, e.rounds_left]), [['not_covered',1],['core.coverage.shortfall', 1]]);
});

test('a blocking violation of a check on the artifact under verification routed to reject puts the item in rejected', { skip }, async () => {
  const run = await draft();
  const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { code: 'self_contradiction', rank: 'minor' })]) }), h.call());
  assert.equal(answer.acceptance, 'accepted');
  const rejected = itemOf(answer.result!, ITEM.c1);
  assert.deepEqual([rejected.partition, (rejected.item as { code?: string }).code], ['rejected', 'toy-review.rank_too_low']);
  assert.deepEqual(answer.counts, { delivered: 3, rejected: 1, quarantined: 0, incomplete: 0, unknown: 0 });
  assert.deepEqual(answer.errors.map((e) => [e.code, e.item, e.rounds_left, e.path]), [['toy-review.rank_too_low', ITEM.c1, undefined, '/items/0/slots/findings/0/rank']]);
});

test('repeating a submission returns the stored result without writing or re-running anything', { skip }, async () => {
  const run = await draft();
  const args = submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1)]) });
  const first = await h.service.submitResult(h.alice, args, h.call('sess-retry'));
  const count = async () => (await h.kit.store.find({ key: INDEX.actionRun, value: run.run, kind: 'action' })).items.length + (await h.kit.store.find({ key: INDEX.submissionRun, value: run.run, kind: 'submission' })).items.length;
  const before = await count();
  const second = await h.service.submitResult(h.alice, JSON.parse(JSON.stringify(args)), h.call('sess-retry'));
  assert.deepEqual(second, first);
  assert.equal(second.result!.trace, first.result!.trace);
  assert.equal(await count(), before);
  // a not-accepted submission is idempotent too
  const bad = submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { code: 'made_up' })]) });
  const r1 = await h.service.submitResult(h.alice, bad, h.call());
  const r2 = await h.service.submitResult(h.alice, bad, h.call());
  assert.deepEqual(r2, r1);
});

test('a run superseded by a newer revision answers RUN_SUPERSEDED; the submission is still stored', { skip }, async () => {
  const run = await draft();
  const revision = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } }, predecessor: run.run }, h.call());
  assert.equal(revision.call_result, 'ok');
  const args = submission(run);
  const answer = await h.service.submitResult(h.alice, args, h.call());
  valid(answer);
  assert.deepEqual(answer.errors.map((e) => e.code), ['RUN_SUPERSEDED']);
  assert.equal(answer.result, undefined);
  const stored = await h.kit.store.find({ key: INDEX.submissionRun, value: run.run, kind: 'submission' });
  assert.deepEqual(stored.items[0].body, args);
  // a run of another pack with this predecessor (the independent verification) continues it and does not supersede it
  const other = await draft();
  assert.equal((await h.service.submitResult(h.alice, submission(other), h.call())).acceptance, 'accepted');
  const handover = `rec:${(await h.service.getResult(h.alice, other.run))!.record}`;
  const verify = await h.service.startRun(h.alice, { pack: 'toy-verify', product: 'Meadow', version: '3.2', inputs: { draft: { reference: handover }, map: { reference: map } }, predecessor: other.run }, h.call());
  assert.equal(verify.call_result, 'ok', JSON.stringify(verify.errors));
  const later = await h.service.submitResult(h.alice, submission(other, { [ITEM.c4]: { item: ITEM.c4, handling: 'skipped', reason: '另议' } }), h.call());
  assert.equal(later.acceptance, 'accepted');
});

test('absent and forbidden runs give the same answer', { skip }, async () => {
  const run = await draft();
  const unknown = await h.service.submitResult(h.alice, { ...submission(run), run: 'run_01m5h9zh07x7amhg4bwmye5yhw' }, h.call());
  const forbidden = await h.service.submitResult(h.bob, submission(run), h.call());
  const malformed = await h.service.submitResult(h.alice, { items: [] }, h.call());
  assert.deepEqual(unknown, forbidden);
  assert.deepEqual(malformed, forbidden);
  assert.deepEqual(forbidden, { call_result: 'error', acceptance: 'not_accepted', errors: [{ code: 'SOURCE_UNAVAILABLE', message: '对你不可用', fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix, path: '/run' }] });
  valid(forbidden);
  // nothing of bob's was stored on alice's run
  const stored = await h.kit.store.find({ key: INDEX.submissionRun, value: run.run, kind: 'submission' });
  assert.equal(stored.items.length, 0);
  // an admin may submit to any run
  assert.equal((await h.service.submitResult(h.admin, submission(run), h.call())).acceptance, 'accepted');
});

// ---------------------------------------------------------------- hostile and partial submissions

test('arguments canonical JSON cannot carry are kept verbatim and answered not accepted at their path, every time', { skip }, async () => {
  const run = await draft();
  const cases: [string, Record<string, unknown>, string][] = [
    ['a finding text', submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { text: 'bad \ud800 text' })]) }), '/items/0/slots/findings/0/text'],
    ['the declared model', submission(run, {}, { model: 'model-\ud800' }), '/model'],
    ['an unknown item id', { ...submission(run), items: [{ item: 'x\ud800', handling: 'handled', slots: { findings: [] } }] }, '/items/0/item'],
  ];
  for (const [name, args, path] of cases) {
    const answer = await h.service.submitResult(h.alice, args, h.call());
    valid(answer);
    assert.deepEqual(answer.errors.map((e) => [e.code, e.path]), [['SUBMISSION_SCHEMA_VIOLATION', path]], name);
    assert.ok(!JSON.stringify(answer).includes('\\ud800'), `${name}: the bad text is not copied into the answer`);
    // a repeat returns the stored receipt instead of throwing
    assert.deepEqual(await h.service.submitResult(h.alice, args, h.call()), answer, name);
  }
  const detail = (await h.service.getRun(h.alice, run.run))!;
  assert.deepEqual(detail.submissions.map((s) => [s.acceptance, s.errors.map((e) => e.path)]), cases.map(([, , path]) => ['not_accepted', [path]]));
  const actions = await h.kit.store.find<ActionBody>({ key: INDEX.actionRun, value: run.run, kind: 'action' });
  const models = actions.items.filter((a) => a.body.action === 'validate').map((a) => a.body.detail.model);
  assert.ok(models.includes('model-�'), 'the declared model is recorded as well-formed text');
});

test('a submission nested deeper than the bound is answered not accepted at the path before anything reads it', { skip }, async () => {
  const run = await draft();
  const nest = (levels: number): Record<string, unknown> => {
    let value: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < levels; i++) value = { d: value };
    return value;
  };
  // 993 levels: canonical JSON still holds the submission, which is stored as received, but a result could not hold it
  const deep = submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { data: nest(993) })]) });
  const answer = await h.service.submitResult(h.alice, deep, h.call());
  valid(answer);
  assert.equal(answer.errors.length, 1);
  assert.equal(answer.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');
  assert.ok(answer.errors[0].path!.startsWith('/items/0/slots/findings/0/data/d/d'), answer.errors[0].path);
  assert.equal(answer.errors[0].path!.split('/').length - 1, 64, 'the first value nested 64 levels deep');
  const stored = await h.kit.store.find<Record<string, unknown>>({ key: INDEX.submissionRun, value: run.run, kind: 'submission' });
  assert.deepEqual([stored.items[0].schema, stored.items[0].body], ['submission@1', deep]);
  // 1,100 levels: canonical JSON refuses them; they are kept as an object and refused at the refused path, cut short
  const deeper = submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { data: nest(1100) })]) });
  const refused = await h.service.submitResult(h.alice, deeper, h.call());
  valid(refused);
  assert.deepEqual(refused.errors.map((e) => e.code), ['SUBMISSION_SCHEMA_VIOLATION']);
  assert.ok(refused.errors[0].path!.startsWith('/items/0/slots/findings/0/data/d') && refused.errors[0].path!.length <= 1024);
});

test('a submission that does not parse still has its parseable entries checked: every cause comes back at once (W08 R[1])', { skip }, async () => {
  const run = await draft();
  const args = submission(run, {
    [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { quotes: [{ reference: locationOf(run, ITEM.c1), text: '不在原文里' }] })]),
    [ITEM.c2]: handled(ITEM.c2, [finding(run, ITEM.c2, { code: 'literal_issue', commands: [{ command: 'zone show', present: false }] })]),
    [ITEM.c4]: { item: ITEM.c4, handling: 'maybe' },
  });
  const answer = await h.service.submitResult(h.alice, args, h.call());
  valid(answer);
  assert.deepEqual(answer.errors.map((e) => [e.code, e.path, e.item]), [
    ['SUBMISSION_SCHEMA_VIOLATION', '/items/3/handling', undefined],
    ['QUOTE_MISMATCH', '/items/0/slots/findings/0/quotes/0/text', ITEM.c1],
    ['core.catalog.membership_contradicted', '/items/1/slots/findings/0/commands/0', ITEM.c2],
    ['not_covered','/items',ITEM.c4],
  ]);
  assert.equal(answer.errors[2].rounds_left, 2);
  // cross-item entries keep their own positions: the one that does not parse, and an unbound ground of a valid one
  const crossed = submission(run, {}, { cross_item: [{ nature: 'judgment', statement: '', grounds: [] }, { nature: 'fact', statement: '有根据', grounds: [`src:${'0'.repeat(64)}`] }, LEVEL] });
  const second = await h.service.submitResult(h.alice, crossed, h.call());
  assert.deepEqual(second.errors.map((e) => [e.code, e.path]), [
    ['SUBMISSION_SCHEMA_VIOLATION', '/cross_item/0/statement'],
    ['REFERENCE_UNRESOLVED', '/cross_item/1/grounds/0'],
  ]);
  // a repeated item is checked once, at its first position
  const twice = { ...submission(run), items: [handled(ITEM.c1, [finding(run, ITEM.c1, { quotes: [{ reference: locationOf(run, ITEM.c1), text: '也不在原文里' }] })]), handled(ITEM.c1, [])] };
  const third = await h.service.submitResult(h.alice, twice, h.call());
  assert.deepEqual(third.errors.map((e) => [e.code, e.path]), [
    ['SUBMISSION_SCHEMA_VIOLATION', '/items/1/item'],
    ['QUOTE_MISMATCH', '/items/0/slots/findings/0/quotes/0/text'],
    ...Array.from({length:3},()=>['not_covered','/items']),
  ]);
});

test('a statement location lies in the judged source: an expected source or the knowledge tree is not accepted (scenario 16)', { skip }, async () => {
  const run = await draft();
  const preview = await h.service.resolveReference(h.alice, { run: run.run, text: 'zone 取 1 到 8', expect: 'quotation' }, h.call());
  const manual = preview.references[0].reference;
  assert.equal(preview.references[0].role, 'expected', 'the manual fragment exists and resolves');
  for (const location of [manual, `tree:${ROOTS.meadow329}/zone/set`]) {
    const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { location })]) }), h.call());
    valid(answer);
    assert.equal(answer.acceptance, 'not_accepted', location);
    assert.deepEqual(answer.errors.map((e) => [e.code, e.path, e.requirement]), [['REFERENCE_UNRESOLVED', '/items/0/slots/findings/0/location', 'findings']], location);
    assert.match(answer.errors[0].fix ?? '', /被判对象/);
  }
  // the same manual fragment as a ground or a quotation is fine
  const grounded = await h.service.submitResult(h.alice, submission(run, { [ITEM.c1]: handled(ITEM.c1, [finding(run, ITEM.c1, { grounds: [manual] })]) }), h.call());
  assert.equal(grounded.acceptance, 'accepted', JSON.stringify(grounded.errors));
});

test('checks see canonical references whatever alias the model wrote: a hint-only finding cannot hide behind an alias', { skip }, async () => {
  const notes = await h.upload(h.alice, new TextEncoder().encode('# 历史清单一\n\n设置 2 区浇灌。\n'), 'text/markdown');
  const started = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map }, notes: [{ reference: notes }] } }, h.call());
  assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
  const run = started.run!;
  const canonical = `${notes}/markdown@1/h/历史清单一`;
  for (const ground of [canonical, `${canonical}[1]`]) {
    const answer = await h.service.submitResult(h.alice, submission(run, { [ITEM.c2]: handled(ITEM.c2, [{ text: '历史清单里有类似用例', code: 'coverage_gap', rank: 'minor', grounds: [ground] }]) }), h.call());
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const findings = requirementOf(itemOf(answer.result!, ITEM.c2).item, 'findings');
    assertLayers(findings.layers, [{ layer: 'static', terminal: 'violation', code: 'toy-review.hint_only', tier: 'blocking', attribution: 'producer_error' }], ground);
    const judgment = findings.claims.find((c) => c.warrant.producer === 'model')!;
    assert.deepEqual(judgment.grounds, [canonical], 'the claim rests on the canonical reference');
    assert.deepEqual(judgment.resolutions!.map((r) => [r.text, r.references]), [[ground, [canonical]]], 'the model text and its referent side by side (T04 R[1])');
  }
});

test('only the runner own revisions supersede a run; a revision by another runner is a branch of theirs (W06 R[1])', { skip }, async () => {
  const run = await draft();
  const adminMap = await h.upload(h.admin, toyMap(standardDocument()));
  const theirs = await h.service.startRun(h.admin, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: adminMap } }, predecessor: run.run }, h.call());
  assert.equal(theirs.call_result, 'ok', JSON.stringify(theirs.errors));
  assert.equal((await h.service.submitResult(h.alice, submission(run), h.call())).acceptance, 'accepted');
  // the runner's own revision does supersede it
  const mine = await h.service.startRun(h.alice, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: map } }, predecessor: run.run }, h.call());
  assert.equal(mine.call_result, 'ok');
  const late = await h.service.submitResult(h.alice, submission(run, {}, { notes: '迟到' }), h.call());
  assert.deepEqual(late.errors.map((e) => [e.code, e.message.includes(mine.run!.run)]), [['RUN_SUPERSEDED', true]]);
});

test('a stored submission belongs to the run it was stored for, whatever keys its arguments hold (R02)', { skip }, async () => {
  h.workflows.assign(h.bob.id, 'toy-review');
  h.workflows.assign(h.bob.id, 'toy-verify');
  try {
    const run = await draft();
    const bobMap = await h.upload(h.bob, toyMap(standardDocument()));
    const bobs = await h.service.startRun(h.bob, { pack: 'toy-review', product: 'Meadow', version: '3.2', inputs: { map: { reference: bobMap } } }, h.call());
    await h.service.submitResult(h.alice, { run: run.run, model: 'model-a', items: [], received: { run: bobs.run!.run } }, h.call());
    const record = (await h.kit.store.find({ key: INDEX.submissionRun, value: run.run, kind: 'submission' })).items[0];
    assert.equal(record.schema, 'submission-received@1');
    const bind = (user: Harness['alice'], mapRef: string) =>
      h.service.startRun(user, { pack: 'toy-verify', product: 'Meadow', version: '3.2', inputs: { draft: { reference: `rec:${record.digest}` }, map: { reference: mapRef } } }, h.call());
    // alice reads her own record (and her projection refuses it: no draft items); bob cannot read it
    assert.deepEqual((await bind(h.alice, map)).errors.map((e) => e.code), ['toy-verify.empty_draft']);
    assert.deepEqual((await bind(h.bob, bobMap)).errors.map((e) => [e.code, e.path]), [['SOURCE_UNAVAILABLE', '/inputs/draft']]);
  } finally {
    h.workflows.unassign(h.bob.id, 'toy-review');
    h.workflows.unassign(h.bob.id, 'toy-verify');
  }
});
