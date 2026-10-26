import {catalogFor} from '../testing/command-catalog.ts';
// W10 step two: an expectation of the compiled case may be taken from a criterion declaration the Hub froze into this run
// after an account other than the author accepted it. Everything here is synthetic: the declaration, its review, the
// account that accepted it, and the typed contract fixtures the pack publishes as examples.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkExpectedSources } from './checks.ts';
import { criteriaOf, quoteSubject } from './subject.ts';
import { MANIFEST_DOC, QUOTE, goodData } from './test-support.ts';
import type { PlanSlots } from './slots.ts';
import type { CommandIdentity } from '../../../../contracts/generated/shared-interfaces.ts';

const DECLARATION = `rec:${'b'.repeat(64)}#/criterion_changes/0`;
const REVIEW = `rec:${'c'.repeat(64)}`;
const TARGET = `src:${'a'.repeat(64)}/kityminder@1/s/c-1-e1`;
const OLD_CRITERION = '健康检查间隔设置成功';
const NEW_CRITERION = '健康检查间隔设置成功后，页面显示 60 秒';
const GROUNDS = [{ reference: `src:${'d'.repeat(64)}/text@1/l/12`, quote: '间隔 60 秒' }];
const ITEM = 'doc-1:c-1';

// runtime-contract@2 examples over the same synthetic runner as the legacy fixture: a typed authority, so the expectation
// rule is reached instead of the typed-prerequisite unknown.
const examples = new URL('../examples/', import.meta.url);
const TYPED_CONTRACT = JSON.parse(readFileSync(new URL('runtime-contract-v2.json', examples), 'utf8')) as unknown;
const TYPED_PROFILE = JSON.parse(readFileSync(new URL('runtime-profile-v2.json', examples), 'utf8')) as unknown;
const TYPED_IDENTITIES = (JSON.parse(readFileSync(new URL('command-identities-v2.json', examples), 'utf8')) as { command_identities: CommandIdentity[] }).command_identities;

/** The plan of the fixture, with the frozen command identities the typed authority asks for. */
function typedData(mutate?: (data: PlanSlots & { command_identities?: CommandIdentity[] }) => void): PlanSlots {
  const data = goodData() as PlanSlots & { command_identities?: CommandIdentity[] };
  data.command_identities = TYPED_IDENTITIES;
  if (mutate !== undefined) mutate(data);
  return data;
}

/** One frozen accepted declaration as the core hands it to the check through the run context. */
const frozen = (over: Record<string, unknown> = {}) => [
  { item: ITEM, criterion: TARGET, assertion: '判据换成写出间隔秒数', old: OLD_CRITERION, new: NEW_CRITERION, grounds: GROUNDS, declaration: DECLARATION, review: REVIEW, reviewer: 'synthetic-reviewer', target: TARGET, ...over },
];

/** A plan whose one expectation cites the frozen declaration and quotes the new criterion. */
const cited = (text: string, quoteText: string = NEW_CRITERION, reference: string = DECLARATION): PlanSlots =>
  typedData((data) => { data.expects[0] = { text, quote: { reference, text: quoteText }, after: 1 }; });

/** The subject of a plan under the typed contract; the declarations go through the same item filter the pack applies. */
const typedSubject = (data: unknown, declarations: unknown[]): { subject: unknown } => ({
  subject: {
    command_catalog:catalogFor(TYPED_IDENTITIES),command_identities: TYPED_IDENTITIES,
    case_texts: ['健康检查间隔配置测试', 'widget health interval 60', QUOTE.text],
    item: ITEM,
    location: QUOTE.reference,
    data,
    contract: TYPED_CONTRACT,
    profile: TYPED_PROFILE,
    manifest: MANIFEST_DOC,
    leases: [],
    now: '2026-10-23T02:00:00.000Z',
    criteria: criteriaOf({ accepted_criteria: declarations }, ITEM),
  },
});

const group = () => ({ kind: 'case-compile', contract: TYPED_CONTRACT, profile: TYPED_PROFILE, manifest: MANIFEST_DOC, leases: { now: '2026-10-23T02:00:00.000Z', entries: [] } });
const context = (criteria: unknown[]) => ({command_policy:catalogFor(TYPED_IDENTITIES).policy,root:'f'.repeat(64), groups: [group()], accepted_criteria: criteria });

test('the typed fixture reaches the expectation rule before any criterion is declared', () => {
  const outcome = checkExpectedSources(typedSubject(typedData(), []))[0];
  assert.equal(outcome.verdict, 'support', JSON.stringify(outcome));
});

test('an expectation taken verbatim from a frozen accepted criterion is grounded and names its review', () => {
  const outcome = checkExpectedSources(typedSubject(cited('页面显示 60 秒'), frozen()))[0];
  assert.equal(outcome.verdict, 'support', JSON.stringify(outcome));
  assert.match(outcome.statement, /冻结的已受理判据声明/);
  for (const named of [DECLARATION, REVIEW, 'synthetic-reviewer']) assert.ok(outcome.statement.includes(named), named);
  assert.deepEqual((outcome.data as { accepted_criteria: unknown }).accepted_criteria, [{ declaration: DECLARATION, review: REVIEW, reviewer: 'synthetic-reviewer', expects: [0] }]);
});

test('a citation of a declaration this run did not freeze grounds nothing', () => {
  // No frozen declaration, another item's declaration, another reference: the cited record is not this run's criterion,
  // so there are no frozen bytes to compare with and the expectation stays ungrounded.
  for (const criteria of [[], frozen({ item: 'doc-1:another-case' }), frozen({ declaration: `rec:${'9'.repeat(64)}` })]) {
    const outcomes = checkExpectedSources(typedSubject(cited('页面显示 60 秒'), criteria));
    assert.ok(outcomes.every((outcome) => outcome.verdict !== 'support'), JSON.stringify(criteria));
    assert.ok(outcomes.some((outcome) => outcome.code === 'case-compile.expect_not_in_criterion'), JSON.stringify(outcomes));
  }
  // An invented expectation that quotes a real source is what it was before: refuted as not in its quote.
  const invented = typedData((data) => { data.expects[0] = { text: '模型补写的结果', quote: { ...QUOTE }, after: 1 }; });
  const outcomes = checkExpectedSources(typedSubject(invented, frozen()));
  assert.ok(outcomes.some((outcome) => outcome.code === 'case-compile.expect_not_in_quote'), JSON.stringify(outcomes));
});

test('the frozen bytes decide, never the plan\'s own copy of the criterion', () => {
  const cases: Array<[string, PlanSlots]> = [
    ['a quoted criterion that is not the frozen one', cited('页面显示 60 秒', `${NEW_CRITERION}（改写）`)],
    ['an expectation that is not a fragment of the frozen criterion', cited('页面显示 61 秒')],
    ['an expectation the plan wrote itself', cited('模型补写的结果')],
  ];
  for (const [name, data] of cases) {
    const outcomes = checkExpectedSources(typedSubject(data, frozen()));
    assert.ok(outcomes.every((outcome) => outcome.verdict !== 'support'), name);
    assert.ok(outcomes.some((outcome) => outcome.code === 'case-compile.expect_not_in_criterion'), `${name}: ${JSON.stringify(outcomes)}`);
    assert.ok(outcomes.every((outcome) => ['/data/expects/0/text', '/data/expects/0/quote/text'].includes(outcome.pointer ?? '')), name);
  }
});

test('an expectation may still quote its own source beside a frozen declaration', () => {
  const data = cited('页面显示 60 秒');
  data.expects.push({ text: QUOTE.text, quote: { ...QUOTE }, after: 1 });
  const outcome = checkExpectedSources(typedSubject(data, frozen()))[0];
  assert.equal(outcome.verdict, 'support', JSON.stringify(outcome));
  assert.match(outcome.statement, /1 条出自替换后引文/);
  assert.match(outcome.statement, /1 条逐字取自冻结的已受理判据声明/);
  assert.deepEqual((outcome.data as { accepted_criteria: Array<{ expects: number[] }> }).accepted_criteria[0].expects, [0]);
});

test('this run re-verifies the declaration\'s grounds, not the declaration reference', () => {
  const quotes = (criteria: unknown[], data: PlanSlots) =>
    (quoteSubject({catalog:catalogFor(TYPED_IDENTITIES).entries,catalog_complete:true, slots: { plan: [{ data }] }, item: { id: ITEM, location: TARGET, fields: { command_identities: TYPED_IDENTITIES } }, context: context(criteria) }) as { quotes: Array<{ reference: string; text: string }> }).quotes;
  assert.deepEqual(quotes(frozen(), cited('页面显示 60 秒')), [{ reference: GROUNDS[0].reference, text: GROUNDS[0].quote }]);
  // Without a frozen declaration the expectation's own quote is what quote@1 reads, exactly as before.
  assert.deepEqual(quotes([], typedData()), [QUOTE]);
  // A declaration of another item changes nothing about this item's quotes.
  assert.deepEqual(quotes(frozen({ item: 'doc-1:another-case' }), cited('页面显示 60 秒')), [{ reference: DECLARATION, text: NEW_CRITERION }]);
});

test('a frozen declaration is read only by its exact declared fields', () => {
  // A declaration frozen without usable grounds or text is not a criterion this pack can ground an expectation in.
  for (const broken of [frozen({ grounds: [] }), frozen({ new: '' }), frozen({ review: '' }), frozen({ reviewer: '' }), frozen({ grounds: [{ reference: '', quote: '' }] })]) {
    const outcomes = checkExpectedSources(typedSubject(cited('页面显示 60 秒'), broken));
    assert.ok(outcomes.every((outcome) => outcome.verdict !== 'support'), JSON.stringify(broken));
    assert.ok(outcomes.some((outcome) => outcome.code === 'case-compile.expect_not_in_criterion'), JSON.stringify(outcomes));
  }
});
