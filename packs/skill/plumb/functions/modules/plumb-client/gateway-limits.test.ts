// The pinned Plumb gateway limits: how a question is priced and a batch is split, and a cross-check of every pinned number
// and pricing rule against the gateway source (skipped, and reported as skipped, where that source is not on the machine).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  PLUMB_DEFAULT_OPTION_COUNTS,
  PLUMB_GATEWAY_LIMITS,
  PLUMB_TASK_FAMILIES,
  estimateExpandedPairs,
  estimateTokens,
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

  it('splits the round-33 shape, seven steps of 24 and 16 candidates, so that no request exceeds 256 priced pairs', () => {
    const questions = Array.from({ length: 7 }, () => [choice(24), choice(16)]).flat();
    const chunks = planPlumbBatches(entriesOf(questions), { frame });
    assert.deepEqual(sizes(chunks), [12, 2]);
    for (const chunk of chunks) {
      assert.ok(chunk.reduce((n, [, q]) => n + estimateExpandedPairs(q), 0) <= PLUMB_GATEWAY_LIMITS.maxPairs);
    }
    assert.deepEqual(chunks.flat().map(([id]) => id), entriesOf(questions).map(([id]) => id), 'order is kept and nothing is lost');
  });

  it('keeps the old split by question count when the pairs allow it', () => {
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

/* ---- cross-check against the gateway source -------------------------------------------------------------------- */

const SOURCE_DIR = process.env.PLUMB_GATEWAY_SOURCE_DIR ?? join(homedir(), 'Public', 'Colab');
/**
 * The state of the gateway source the pinned numbers were read from (2026-11-16). The folder is not a git checkout, so the record
 * is the SHA-256 of each file; all five also equal the files inside deploy/plumb_api/plumb_api_bundle.tar.gz (SHA-256 f69950a8…348175),
 * the bundle the gateway host installs. A difference here is reported and does not fail: the facts below decide.
 */
const PINNED_SHA256: Readonly<Record<string, string>> = {
  'plumb_api/config.py': '3da20dac75ac2366f3217913079d7d7572c380f7cdaf81c066969c31c2b16cbe',
  'plumb_api/judge_logic.py': '82c2307014c64ae53e6a12fc84fe2e30346d950a57bde2b2d0112ad4d3733d23',
  'plumb_api/gateway.py': 'f4994b9ac97f26180a25ac9059901cfb40d1ab49f5d58dadcb18dea78c6b9348',
  'jev_cli/plumb_tasks.py': 'b0f18b6c364f013b3036ef427a6890873a4e6c562b35bf286632682edc9108dd',
  'deploy/plumb_api/defaults/gateway.json': '61e0381594961880313dc18e0a4b9460e991b839968cafb50858e499135699b9',
};
const source = (relative: string): string => readFileSync(join(SOURCE_DIR, relative), 'utf8');
const number = (text: string, name: string): number => {
  const hit = new RegExp(`^\\s*${name}\\s*(?::\\s*int\\s*)?=\\s*([0-9_]+)\\s*$`, 'm').exec(text);
  assert.ok(hit, `${name} is not defined as a plain integer`);
  return Number(hit[1]!.replaceAll('_', ''));
};
/** The text of the Python literal that starts at `opener` (a line such as `NAME = {`) up to its closing bracket. */
const literal = (text: string, opener: string): string => {
  const start = text.indexOf(opener);
  assert.ok(start >= 0, `${opener} not found`);
  const open = text.indexOf(opener.at(-1)!, start + opener.length - 1);
  const close = { '{': '}', '(': ')', '[': ']' }[opener.at(-1)!]!;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === opener.at(-1)) depth += 1;
    else if (text[i] === close && --depth === 0) return text.slice(open, i + 1);
  }
  throw new assert.AssertionError({ message: `${opener} is not closed` });
};

describe('the pinned limits against the gateway source', { skip: existsSync(join(SOURCE_DIR, 'plumb_api', 'judge_logic.py')) ? false : `gateway source not found at ${SOURCE_DIR} (set PLUMB_GATEWAY_SOURCE_DIR); the pin was not cross-checked` }, () => {
  it('reports whether the gateway source is still the one the pin was read from', (t) => {
    const moved = Object.entries(PINNED_SHA256).filter(([file, sha]) => createHash('sha256').update(readFileSync(join(SOURCE_DIR, file))).digest('hex') !== sha).map(([file]) => file);
    t.diagnostic(moved.length === 0 ? 'gateway source is the pinned state' : `gateway source moved since the pin: ${moved.join(', ')}; the facts below decide`);
  });

  it('has the same request limits in the gateway defaults, the deployed default file and the pin', () => {
    const config = source('plumb_api/config.py');
    const deployed = JSON.parse(source('deploy/plumb_api/defaults/gateway.json')) as Record<string, number>;
    for (const [pinned, name] of [
      [PLUMB_GATEWAY_LIMITS.maxQuestions, 'max_questions'],
      [PLUMB_GATEWAY_LIMITS.maxPairs, 'max_score_pairs'],
      [PLUMB_GATEWAY_LIMITS.maxBodyBytes, 'max_body_bytes'],
      [PLUMB_GATEWAY_LIMITS.maxConcurrentPerKey, 'max_concurrent_requests_per_key'],
    ] as const) {
      assert.equal(number(config, name), pinned, `config.py ${name}`);
      if (name in deployed) assert.equal(deployed[name], pinned, `deployed default ${name}`);
    }
    assert.equal(deployed.max_questions, PLUMB_GATEWAY_LIMITS.maxQuestions);
    assert.equal(deployed.max_score_pairs, PLUMB_GATEWAY_LIMITS.maxPairs);
    assert.equal(deployed.max_body_bytes, PLUMB_GATEWAY_LIMITS.maxBodyBytes);
  });

  it('has the same token budgets, and the estimator the client uses', () => {
    const tasks = source('jev_cli/plumb_tasks.py');
    assert.equal(number(tasks, 'DEFAULT_STATE_EST_TOKEN_BUDGET'), PLUMB_GATEWAY_LIMITS.stateEstTokens);
    assert.equal(number(tasks, 'DEFAULT_FIDELITY_STATE_EST_TOKEN_BUDGET'), PLUMB_GATEWAY_LIMITS.fidelityStateEstTokens);
    const cjk = /_CJK_RX\s*=\s*re\.compile\(r"(\[[^"]+\])"\)/u.exec(tasks);
    assert.ok(cjk, 'the gateway estimator no longer counts CJK characters with a class');
    assert.match(tasks, /return int\(math\.ceil\(cjk_count \+ other_count \/ 3\.5\)\)/u);
    const gatewayClass = new RegExp(cjk[1]!, 'gu');
    for (const sample of ['', 'ascii only text 123', '中文ab', '设备 `sdns host name "x"` 查询（域名）', 'x'.repeat(253)]) {
      const hits = sample.match(gatewayClass)?.length ?? 0;
      assert.equal(estimateTokens(sample), Math.ceil(hits + (sample.length - hits) / 3.5), JSON.stringify(sample));
    }
  });

  it('prices a batch the way the gateway does: one budget for the whole request, shared by its questions in order', () => {
    const logic = source('plumb_api/judge_logic.py');
    for (const anchor of [
      'if len(qmap) > max_questions:',
      'remaining_pairs = max_score_pairs',
      'max_score_pairs=remaining_pairs,',
      'remaining_pairs -= pair_cost',
      'pair_count=1,',
      'pair_cost = len(cands)',
      'pair_cost = len(cands_to_score)',
      'if family in ("match", "rerank", "criterion_coverage"):',
    ]) assert.ok(logic.includes(anchor), `judge_logic.py no longer contains: ${anchor}`);
  });

  it('has the task families the pricing uses, and the option sets a sequence and an expectation get without candidates', () => {
    const logic = source('plumb_api/judge_logic.py');
    const gatewayFamilies = Object.fromEntries([...literal(logic, 'CANONICAL_FAMILY_MAP = {').matchAll(/"([a-z_]+)":\s*"([a-z_]+)"/gu)].map((m) => [m[1]!, m[2]!]));
    assert.deepEqual({ ...PLUMB_TASK_FAMILIES }, gatewayFamilies);
    const tasks = source('jev_cli/plumb_tasks.py');
    const fidelityOptions = [...literal(tasks, 'FIDELITY_SHORT_CRITERIA: dict[str, str] = {').matchAll(/^\s+"([^"]+)":/gmu)].length;
    assert.equal(fidelityOptions, PLUMB_DEFAULT_OPTION_COUNTS.sequence);
    const expectationOptions = [...literal(tasks, 'EXPECTATION_FIXED_ORDER: tuple[str, ...] = (').matchAll(/"([^"]+)"/gu)].length;
    assert.equal(expectationOptions, PLUMB_DEFAULT_OPTION_COUNTS.expectation);
  });

  it('is documented to callers with the same three numbers', () => {
    const guide = source('review/PLUMB_API_GUIDE.md');
    assert.ok(guide.includes(`最多传 **${PLUMB_GATEWAY_LIMITS.maxQuestions} 题**`));
    assert.ok(guide.includes(`单批展开 pair 上限 \`${PLUMB_GATEWAY_LIMITS.maxPairs}\``));
    assert.ok(guide.includes(`请求体上限 \`${PLUMB_GATEWAY_LIMITS.maxBodyBytes / 1048576} MiB\``));
  });
});
