import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLUMB_DEFAULT_OPTION_COUNTS,
  PLUMB_GATEWAY_LIMITS,
  estimateExpandedPairs,
  planPlumbBatches,
  requestBodyBytes,
  type PlumbBatchQuestion,
} from './index.ts';

const NONE = { name: '都不是', text: '以上候选均不符合' };
const choice = (candidates: number): PlumbBatchQuestion => ({
  task: 'choice',
  node: { line: 'synthetic', title: 'synthetic step' },
  candidates: [...Array.from({ length: candidates }, (_, i) => ({ name: `command ${i}`, text: `syntax ${i}` })), NONE],
});
const entriesOf = (questions: PlumbBatchQuestion[], prefix = 'q'): Array<[string, PlumbBatchQuestion]> => questions.map((q, i) => [`${prefix}${i}`, q]);
const sizes = (chunks: ReadonlyArray<ReadonlyArray<unknown>>): number[] => chunks.map((c) => c.length);

describe('pricing a question in expanded judge pairs', () => {
  it('prices the match, rerank and criterion_coverage families at one pair whatever candidates they carry', () => {
    for (const task of ['match', 'single_cmd_judge', 'steplist_judge', 'rerank', 'criterion_coverage']) {
      assert.equal(estimateExpandedPairs({ task, candidates: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }), 1, task);
    }
  });

  it('prices a choice at its candidates, counting the none option, which can only overstate what the gateway charges', () => {
    assert.equal(estimateExpandedPairs(choice(24)), 25);
    assert.equal(estimateExpandedPairs({ task: 'cmd_select', criteria: { a: 'x', b: 'y', c: 'z' } }), 3);
    assert.equal(estimateExpandedPairs({ task: 'manual_choice', criteria: ['a', 'b'] }), 2);
  });

  it('reads candidates before criteria, as the gateway does, and prices a sequence or expectation without options at its fixed set', () => {
    assert.equal(estimateExpandedPairs({ task: 'choice', candidates: [{ name: 'a' }, { name: 'b' }], criteria: { a: '1', b: '2', c: '3', d: '4' } }), 2);
    assert.equal(estimateExpandedPairs({ task: 'sequence', state: 'x' }), PLUMB_DEFAULT_OPTION_COUNTS.sequence);
    assert.equal(estimateExpandedPairs({ task: 'scenario_fidelity', state: 'x' }), 3);
    assert.equal(estimateExpandedPairs({ task: 'expectation', state: 'x' }), 3);
  });

  it('takes the task of the batch when a question has none, and prices an unknown task at what it lists, never below one', () => {
    assert.equal(estimateExpandedPairs({ state: 'x' }, 'single_cmd_judge'), 1);
    assert.equal(estimateExpandedPairs({ task: 'brand-new-task', candidates: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }), 3);
    assert.equal(estimateExpandedPairs({ task: 'brand-new-task' }), 1);
    assert.equal(estimateExpandedPairs({}), 1);
  });
});

describe('splitting a batch by the three request limits', () => {
  const frame = { model: 'plumb-27b-0.5.0', task: 'choice' };

  it('splits seven steps of 24 and 16 candidates so that no request exceeds 256 priced pairs', () => {
    const questions = Array.from({ length: 7 }, () => [choice(24), choice(16)]).flat();
    const chunks = planPlumbBatches(entriesOf(questions), { frame });
    assert.deepEqual(sizes(chunks), [12, 2]);
    for (const chunk of chunks) {
      assert.ok(chunk.reduce((n, [, q]) => n + estimateExpandedPairs(q), 0) <= PLUMB_GATEWAY_LIMITS.maxPairs);
    }
    assert.deepEqual(chunks.flat().map(([id]) => id), entriesOf(questions).map(([id]) => id), 'order is kept and nothing is lost');
  });

  it('splits by question count alone when the pairs allow it', () => {
    const match = (n: number): Array<[string, PlumbBatchQuestion]> => entriesOf(Array.from({ length: n }, () => ({ task: 'single_cmd_judge', command: 'x', state: 'ctx' })));
    assert.deepEqual(sizes(planPlumbBatches(match(32), { frame })), [32]);
    assert.deepEqual(sizes(planPlumbBatches(match(33), { frame })), [32, 1]);
    assert.deepEqual(sizes(planPlumbBatches(match(70), { frame })), [32, 32, 6]);
    assert.deepEqual(sizes(planPlumbBatches(entriesOf(Array.from({ length: 32 }, () => ({ task: 'sequence', state: 'x' }))), { frame })), [32], 'three pairs each is 96');
  });

  it('honors a smaller batch size', () => {
    const questions = entriesOf(Array.from({ length: 7 }, () => ({ task: 'single_cmd_judge', command: 'x' })));
    assert.deepEqual(sizes(planPlumbBatches(questions, { frame, maxQuestions: 3 })), [3, 3, 1]);
    assert.deepEqual(sizes(planPlumbBatches(questions, { frame, maxQuestions: 500 })), [7]);
  });

  it('splits by the bytes of the request body and measures them exactly, multibyte text included', () => {
    const big = (n: number): PlumbBatchQuestion => ({ task: 'single_cmd_judge', command: 'x', state: '设'.repeat(n) });
    const questions = entriesOf([big(150_000), big(150_000), big(150_000), big(150_000), { task: 'single_cmd_judge', command: 'y' }]);
    const chunks = planPlumbBatches(questions, { frame });
    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      const wire = JSON.stringify({ ...frame, questions: Object.fromEntries(chunk) });
      assert.equal(requestBodyBytes(frame, chunk), Buffer.byteLength(wire, 'utf8'), 'the planner counts the bytes that are sent');
      assert.ok(Buffer.byteLength(wire, 'utf8') <= PLUMB_GATEWAY_LIMITS.maxBodyBytes);
    }
    assert.equal(chunks.flat().length, 5);
  });

  it('refuses before sending a question that no request can carry, and names it', () => {
    const hugeState = entriesOf([{ task: 'single_cmd_judge', command: 'x', state: 'a'.repeat(PLUMB_GATEWAY_LIMITS.maxBodyBytes) }], 'huge');
    assert.throws(() => planPlumbBatches(hugeState, { frame }), /^Error: 参数无效：.*huge0.*请.*。$/u);
    const wide: PlumbBatchQuestion = { task: 'choice', candidates: Array.from({ length: PLUMB_GATEWAY_LIMITS.maxPairs + 1 }, (_, i) => ({ name: `c${i}` })) };
    assert.throws(() => planPlumbBatches(entriesOf([wide], 'wide'), { frame }), /wide0.*257.*256/u);
  });

  it('plans nothing for no questions', () => {
    assert.deepEqual(planPlumbBatches([], { frame }), []);
  });
});
