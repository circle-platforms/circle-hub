import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgeStep } from './command-tree-verdict.ts';
import { FIDELITY_CHOICES, JEV_COMMAND_PROMPT, JEV_EXACT_VERSION, JEV_FIDELITY_PROMPT, JEV_FIRST_MODEL, JevJudge, JevJudgeFailure, type JevAsker } from './jev-judge.ts';
import { normalizeJudgeAnswer } from './generated/skills/plumb/plumb-client/index.ts';
import { callFailureData, formatCallError } from './text.ts';
import { FakeCallError, JEV_TEST_VERSION as VERSION, jevFake as fake } from '../testing/jev-fake.ts';

const single = (n: number) => ({ task: 'single_cmd_judge', command: 'speed 100 ' + n, definition: 'speed <n:int>\n  sets the speed', state: '[用例]\n合成用例\n\n[当前步骤]\n步骤意图: 设速度' });

test('a command question is one yes/no request: context, the command line and its definition, and the answer is advice that neither passes nor rejects', async () => {
  const { asker, requests } = fake(() => ({ type: 'noul', noul: 0.87 }));
  const judge = new JevJudge(asker);
  const res = await judge.judgeBatched({ task: 'single_cmd_judge', questions: { '0:1': single(1) } });
  assert.equal(requests.length, 1);
  const sent = requests[0]!;
  assert.deepEqual(Object.keys(sent.questions), ['q1'], 'the id sent to Jev is short and safe; the caller\'s id stays with the caller');
  assert.deepEqual(sent.state, { context: single(1).state, command: 'speed 100 1', definition: 'speed <n:int>\n  sets the speed' });
  const question = sent.questions.q1!;
  assert.equal(question.type, 'noul');
  assert.match(question.instructions, /is a command line that the current step calls for, with the right arguments/);
  assert.match(question.instructions, /syntax reference of the command/);
  assert.doesNotMatch(question.instructions, /router|switch|firewall|interface|vlan/i, 'the instructions name no product, product class or command');
  assert.equal(JEV_COMMAND_PROMPT, 'jev-noul@command-v1');
  // The answer is where normalizeJudgeAnswer reads it, and every answer carries the same review gate.
  const raw = res.answers['0:1']!;
  assert.deepEqual([res.status, res.decided_by, res.model_version, raw.status, raw.decided_by, raw.model_version], ['未确认', '模型', VERSION, '未确认', '模型', VERSION]);
  assert.deepEqual(raw.gate, { action: 'review', calibrated: false, calibration_source: 'uncalibrated' });
  const norm = normalizeJudgeAnswer(raw);
  assert.deepEqual([norm.kind, norm.match, norm.probabilities?.yes, norm.gate?.action], ['noul', 0.87, 0.87, 'review']);
  // judgeStep: a review call neither releases nor refuses, even where the tree has no conclusion; only the tree can refuse.
  const accepted = judgeStep({ call: 'review', note: 'n', yes: 0.87 }, { status: 'accepted' }, false);
  assert.deepEqual([accepted.verdict, accepted.blocked, accepted.review_required], ['review', false, true]);
  const refused = judgeStep({ call: 'review', note: 'n', yes: 0.87 }, { status: 'refused', problems: [{ pointer: '/steps/0', message: '合成：命令树不认' }] }, false);
  assert.deepEqual([refused.verdict, refused.blocked], ['reject', true]);
});

test('a list question sends the commands as an array with the list instructions, and a node can stand for the context', async () => {
  const { asker, requests } = fake(() => ({ type: 'noul', noul: 0.1 }));
  const judge = new JevJudge(asker);
  await judge.judgeBatched({ questions: { a: { task: 'steplist_judge', commands: ['one 1', 'two 2'], state: 'ctx' }, b: { task: 'single_cmd_judge', command: 'three', node: { line: 'x', title: 't' } } } });
  const list = requests.find((r) => Array.isArray((r.state as { commands?: unknown }).commands))!;
  assert.deepEqual(list.state, { context: 'ctx', commands: ['one 1', 'two 2'] }, 'no definition field when there is none');
  assert.match(list.questions.q1!.instructions, /is the correct list of command lines for the current step/);
  assert.match(list.questions.q1!.instructions, /nothing missing and nothing extra/);
  const node = requests.find((r) => (r.state as { command?: unknown }).command === 'three')!;
  assert.deepEqual((node.state as { context: unknown }).context, { line: 'x', title: 't' });
});

test('a scenario question is one choice request with the audit\'s own wording, and its p is the probability of the chosen verdict, not Jev\'s rescaled confidence', async () => {
  const { asker, requests } = fake(() => ({ type: 'choice', choice: 'changed', confidence: 0.99, probabilities: { preserved: 0.2, changed: 0.7, unrealized: 0.1 } }));
  const judge = new JevJudge(asker);
  const state = '[用例意图]\n合成\n\n[当前作者步骤 a2]\n设速度\n\n[候选命令块]\nblock[0]';
  const res = await judge.judgeBatched({ task: 'sequence', questions: { '0:a2': { task: 'sequence', state, step_n: 2, metadata: { author_step: 'a2' } } } });
  const question = requests[0]!.questions.q1!;
  assert.equal(requests[0]!.state, state, 'the state is the very text the tool builds for Plumb');
  assert.deepEqual(question, {
    type: 'choice',
    instructions: "Do the blocks realize author step a2's scenario as the author wrote it? Judge only scenario fidelity of this step; pick exactly one verdict.",
    criteria: {
      preserved: "the bound blocks realize this step's scenario as the author wrote it",
      changed: 'the blocks realize a different scenario or alter a condition the author stated',
      unrealized: 'no block realizes this step',
    },
  });
  assert.deepEqual([...FIDELITY_CHOICES], ['preserved', 'changed', 'unrealized']);
  assert.equal(JEV_FIDELITY_PROMPT, 'jev-choice@fidelity-v1');
  const norm = normalizeJudgeAnswer(res.answers['0:a2']!);
  assert.deepEqual([norm.kind, norm.choice, norm.confidence, norm.gate?.action, norm.gate?.calibrated], ['choice', 'changed', 0.7, 'review', false]);
  assert.deepEqual(norm.probabilities, { preserved: 0.2, changed: 0.7, unrealized: 0.1 });
});

test('the first request asks for jev-latest, later ones for the exact version the first answer named, and the first is alone before the others', async () => {
  const f = fake(() => ({ type: 'noul', noul: 0.5 }));
  const judge = new JevJudge(f.asker);
  const questions = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), single(n)]));
  const res = await judge.judgeBatched({ task: 'single_cmd_judge', questions });
  assert.equal(JEV_FIRST_MODEL, 'jev-latest');
  assert.deepEqual(f.requests.map((r) => r.model), ['jev-latest', VERSION, VERSION, VERSION, VERSION]);
  assert.ok(f.widest() <= 2, 'at most two requests in flight after the first');
  assert.equal(res.model_version, VERSION);
  assert.equal(judge.modelVersion, VERSION);
  assert.equal(judge.requests, 5);
  // A later call of the same invocation keeps the version.
  await judge.judgeBatched({ task: 'single_cmd_judge', questions: { x: single(9) } });
  assert.equal(f.requests.at(-1)!.model, VERSION);
});

test('one invocation has one model_version: an answer from another version fails the call', async () => {
  let n = 0;
  const asker: JevAsker = { async ask(request) { n += 1; return { model: request.model ?? '', model_version: n === 1 ? 'jev-1.13.0' : 'jev-1.14.0', status: '未确认', decided_by: '模型', answers: { q1: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }; } };
  await assert.rejects(new JevJudge(asker).judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1), 2: single(2) } }), (error: unknown) => {
    assert.ok(error instanceof JevJudgeFailure);
    assert.match(formatCallError(error), /^暂时不可用：Jev 在一次核验里换了模型版本（jev-1\.13\.0、jev-1\.14\.0）/);
    return true;
  });
});

test('the same question asked again in one run is answered from the run, not sent again', async () => {
  const f = fake(() => ({ type: 'noul', noul: 0.4 }));
  const judge = new JevJudge(f.asker);
  const one = await judge.judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1), 2: single(2) } });
  const again = await judge.judgeBatched({ task: 'single_cmd_judge', questions: { 2: single(2) } });
  assert.deepEqual(again.answers['2'], one.answers['2']);
  assert.equal(f.requests.length, 2);
  assert.equal(judge.requests, 2);
});

test('what stops a batch keeps its category word; the key refused says what to do and carries no key, and a key that was never sent says so', async () => {
  const secret = 'jev_sk_synthetic_key_123456';
  const run = async (error: Error) => {
    const f = fake(() => error);
    try { await new JevJudge(f.asker, { secret }).judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1) } }); } catch (caught) { return caught; }
    throw new Error('should have refused');
  };
  const denied = await run(new FakeCallError('无权限', 401, 'unauthorized', 'bad key ' + secret));
  assert.ok(denied instanceof JevJudgeFailure);
  const text = formatCallError(denied);
  assert.match(text, /^无权限：Jev 拒绝了密钥（HTTP 401，unauthorized）/);
  assert.match(text, /JEV_API_KEY/);
  assert.ok(!text.includes(secret), 'the key is never printed');
  assert.equal(callFailureData(denied).category, 'permission_denied');
  // The client's message is already in the call-error form: its category word is not said twice.
  const formed = formatCallError(await run(new FakeCallError('无权限', 401, 'unauthorized', '无权限：密钥没有被接受。请换一把密钥。')));
  assert.equal((formed.match(/无权限：/g) ?? []).length, 1, formed);
  assert.match(formed, /（HTTP 401，unauthorized）：密钥没有被接受。请换一把密钥/);
  // A key whose shape the client turns down was never sent: it is not a key that Jev refused.
  const unusableKey = formatCallError(await run(new FakeCallError('无权限', 0, 'invalid_key', 'Jev API 密钥为空或含不允许的字符，没有发出任何请求。请提供有效的 Jev API 密钥。')));
  assert.match(unusableKey, /^无权限：Jev 密钥照现在的写法用不了（密钥为空、太长或含不允许的字符），没有发出任何请求（invalid_key）。请使用者向管理员重新领取 Jev 密钥/);
  assert.doesNotMatch(unusableKey, /拒绝了密钥/);
  const down = await run(new FakeCallError('暂时不可用', 503, 'unavailable'));
  assert.match(formatCallError(down), /^暂时不可用：Jev 暂时不可用（HTTP 503，unavailable）/);
  const other = new TypeError('a bug of the caller');
  assert.equal(await run(other), other, 'what is no call error of the client passes through unchanged');
});

test('a question the service turns down has no Jev opinion and the batch goes on: the others are answered, the reason is returned, nothing throws, and the same question is not sent again', async () => {
  for (const [status, code] of [[413, 'request_too_large'], [422, 'context_too_long'], [400, 'request_rejected'], [0, 'invalid_request']] as const) {
    const f = fake((request) => ((request.state as { command?: string }).command?.endsWith(' 2') ? new FakeCallError('参数无效', status, code, '合成：题面不行') : { type: 'noul', noul: 0.6 }));
    const judge = new JevJudge(f.asker);
    const res = await judge.judgeBatched({ task: 'single_cmd_judge', questions: Object.fromEntries([1, 2, 3].map((n) => [String(n), single(n)])) });
    assert.deepEqual(Object.keys(res.answers).sort(), ['1', '3'], code);
    assert.deepEqual(Object.keys(res.unanswered), ['2'], code);
    assert.deepEqual([res.unanswered['2']!.code, res.unanswered['2']!.status], [code, status]);
    assert.match(res.unanswered['2']!.reason, new RegExp(`（${status > 0 ? `HTTP ${status}，` : ''}${code}）$`), code);
    assert.ok(!res.unanswered['2']!.reason.includes('speed 100'), 'the reason names no text of the question');
    assert.equal(f.requests.length, 3, code);
    const again = await judge.judgeBatched({ task: 'single_cmd_judge', questions: { 2: single(2) } });
    assert.deepEqual([Object.keys(again.answers), Object.keys(again.unanswered), f.requests.length], [[], ['2'], 3], `${code}: not sent again`);
  }
  // Turned down first: no version is known yet, so the next question still goes alone and names it.
  const g = fake((request, n) => (n === 1 ? new FakeCallError('参数无效', 422, 'request_rejected', '合成') : { type: 'noul', noul: 0.5 }));
  const second = await new JevJudge(g.asker).judgeBatched({ task: 'single_cmd_judge', questions: Object.fromEntries([1, 2, 3].map((n) => [String(n), single(n)])) });
  assert.deepEqual([Object.keys(second.unanswered), second.model_version, g.requests.map((r) => r.model)], [['1'], VERSION, ['jev-latest', 'jev-latest', VERSION]]);
  // All turned down: nothing answered, no version, and still no throw.
  const all = await new JevJudge(fake(() => new FakeCallError('参数无效', 422, 'request_rejected', '合成')).asker).judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1), 2: single(2) } });
  assert.deepEqual([Object.keys(all.answers), Object.keys(all.unanswered), all.model_version], [[], ['1', '2'], null]);
  // What stops the batch is not a rejection of a question: the key, an outage, the log.
  for (const error of [new FakeCallError('无权限', 401, 'unauthorized'), new FakeCallError('暂时不可用', 503, 'unavailable'), new FakeCallError('参数无效', 0, 'audit_failed')]) {
    await assert.rejects(new JevJudge(fake(() => error).asker).judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1) } }), (thrown: unknown) => thrown instanceof JevJudgeFailure && thrown.code === (error as FakeCallError).code);
  }
});

test('the model name an answer carries must be an exact version, name-X.Y.Z: a moving alias is no version and nothing of its answer is recorded', async () => {
  for (const name of ['jev-latest', 'jev-1.14', 'jev', 'jev-1.14.0-beta', '1.14.0', 'latest']) {
    const answering = { name };
    const asker: JevAsker = { async ask(request) { return { model: request.model ?? '', model_version: answering.name, status: '未确认', decided_by: '模型', answers: { q1: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }; } };
    const judge = new JevJudge(asker);
    await assert.rejects(judge.judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1) } }), (error: unknown) => {
      assert.ok(error instanceof JevJudgeFailure, name);
      assert.match(formatCallError(error), new RegExp(`^暂时不可用：Jev 答出来的模型名是 ${name.replace(/[.-]/g, '\\$&')}，不是确切版本（要写成 名称-X.Y.Z）；这份答案没有记下`), name);
      return true;
    });
    assert.equal(judge.modelVersion, null, `${name}: no version was recorded`);
    // Nothing of that answer is kept: the same question is asked again, and an exact answer is taken as it comes.
    answering.name = 'jev-1.14.0';
    const res = await judge.judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1) } });
    assert.deepEqual([res.model_version, res.answers['1']!.model_version, judge.requests], ['jev-1.14.0', 'jev-1.14.0', 2], name);
  }
  for (const exact of ['jev-1.14.0', 'plumb-27b-0.5.0', 'Jev_x-10.0.12']) assert.match(exact, JEV_EXACT_VERSION);
});

test('the requests it reports are the ones the client says it sent, when it can say, and its asks when it cannot', async () => {
  const f = fake(() => ({ type: 'noul', noul: 0.5 }));
  const counting: JevAsker = { ask: (request) => f.asker.ask(request), sent: () => 7 };
  const judge = new JevJudge(counting);
  await judge.judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1), 2: single(2) } });
  assert.deepEqual([f.requests.length, judge.requests], [2, 7]);
});

test('a request log that cannot be written is said to be that, not a refusal of the question or an outage of the service', async () => {
  for (const [category, status] of [['参数无效', 0], ['暂时不可用', 200]] as const) {
    const f = fake(() => new FakeCallError(category, status, 'audit_failed', '审计文件打不开或写不进'));
    const failure = await new JevJudge(f.asker).judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1) } }).then(() => { throw new Error('should have refused'); }, (error: unknown) => error as JevJudgeFailure);
    assert.match(formatCallError(failure), new RegExp(`^${category}：Jev 的请求记录没有写成（${status > 0 ? `HTTP ${status}，` : ''}audit_failed）：审计文件打不开或写不进。先修好请求记录的位置和权限`));
    assert.equal(failure.code, 'audit_failed');
  }
});

test('an answer without the disclosure, of another shape or outside 0..1 is a service that cannot be used, and a task Jev does not judge is refused before any request', async () => {
  const bad = async (answer: unknown, task: 'single_cmd_judge' | 'sequence' = 'single_cmd_judge') => {
    const f = fake(() => answer as never);
    const question = task === 'sequence' ? { task, state: 's', step_n: 1 } : single(1);
    try { await new JevJudge(f.asker).judgeBatched({ task, questions: { 1: question } }); } catch (caught) { return formatCallError(caught); }
    throw new Error('should have refused');
  };
  assert.match(await bad({ type: 'noul', noul: 1.5 }), /^暂时不可用：Jev 的回答里没有这道题的答案，或答案的形状不对/);
  assert.match(await bad({ type: 'choice', choice: 'preserved', confidence: 1, probabilities: { preserved: 1 } }), /^暂时不可用：Jev 的回答里没有这道题的答案/);
  assert.match(await bad({ type: 'choice', choice: 'unknown', confidence: 1, probabilities: { unknown: 1 } }, 'sequence'), /^暂时不可用/);
  const noDisclosure: JevAsker = { async ask() { return { model: 'm', model_version: '', status: '未确认', decided_by: '模型', answers: { q1: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 0, output_tokens: 0 } }; } };
  await assert.rejects(new JevJudge(noDisclosure).judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1) } }), /Jev 的回答缺少未确认的模型披露/);
  const never = fake(() => ({ type: 'noul', noul: 0.5 }));
  await assert.rejects(new JevJudge(never.asker).judgeBatched({ task: 'choice', questions: { 1: { task: 'choice', state: 's' } } }), /Jev 判断只做命令核验（single_cmd_judge、steplist_judge）和场景保真（sequence），不做 choice/);
  await assert.rejects(new JevJudge(never.asker).judgeBatched({ questions: {} }), /批量判别题目列表为空/);
  assert.equal(never.requests.length, 0);
});

test('a failure of one request stops the others from starting and is the one thrown', async () => {
  const f = fake((_request, n) => (n === 2 ? new FakeCallError('暂时不可用', 503, 'unavailable') : { type: 'noul', noul: 0.5 }));
  const judge = new JevJudge(f.asker, { concurrency: 1 });
  await assert.rejects(judge.judgeBatched({ task: 'single_cmd_judge', questions: Object.fromEntries([1, 2, 3, 4].map((n) => [String(n), single(n)])) }), /Jev 暂时不可用（HTTP 503，unavailable）/);
  assert.equal(f.requests.length, 2, 'nothing was started after the failure');
});

test('answers are kept across passes in a file of digests and validated answers: a pass asks only what has no answer yet, a changed question or state is asked again, and a line that is no answer is no answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-answers-'));
  const file = join(dir, 'audit', 'jev-commands.answers.jsonl');
  const four = Object.fromEntries([1, 2, 3, 4].map((n) => [String(n), single(n)]));
  const commandOf = (request: { state: unknown }) => (request.state as { command: string }).command;
  try {
    // Pass 1: the third request fails, and what arrived before it is kept.
    const first = fake((_request, n) => (n === 3 ? new FakeCallError('暂时不可用', 503, 'unavailable') : { type: 'noul', noul: 0.5 + n / 100 }));
    await assert.rejects(new JevJudge(first.asker, { concurrency: 1, answersFile: file }).judgeBatched({ task: 'single_cmd_judge', questions: four }), /Jev 暂时不可用（HTTP 503/);
    const text = await readFile(file, 'utf8');
    const lines = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => Object.keys(line)), [['key', 'model_version', 'answer'], ['key', 'model_version', 'answer']]);
    assert.deepEqual(lines.map((line) => [line.model_version, line.answer]), [[VERSION, { type: 'noul', noul: 0.51 }], [VERSION, { type: 'noul', noul: 0.52 }]]);
    assert.ok(lines.every((line) => /^[0-9a-f]{64}$/.test(String(line.key))), 'a digest names the question, not its text');
    for (const said of ['speed 100', '合成用例', '设速度', 'sets the speed', 'The request state', 'criteria', 'instructions']) assert.ok(!text.includes(said), `the file holds no text of the state or the question: ${said}`);
    assert.equal((await import('node:fs/promises').then((fs) => fs.stat(file))).mode & 0o777, 0o600);

    // Pass 2, a new run of the tool on the same file: only the two questions without an answer are sent, and they ask for the exact version.
    const second = fake(() => ({ type: 'noul', noul: 0.9 }));
    const judge2 = new JevJudge(second.asker, { answersFile: file });
    const res = await judge2.judgeBatched({ task: 'single_cmd_judge', questions: four });
    assert.deepEqual(second.requests.map(commandOf).sort(), ['speed 100 3', 'speed 100 4']);
    assert.deepEqual(second.requests.map((request) => request.model), [VERSION, VERSION], 'no alias is asked for once the version is known');
    assert.deepEqual(Object.keys(res.answers), ['1', '2', '3', '4']);
    assert.deepEqual([res.answers['1']!.match, res.answers['2']!.match, res.answers['3']!.match, res.model_version, judge2.requests], [0.51, 0.52, 0.9, VERSION, 2]);

    // Pass 3: everything has its answer, so nothing is sent.
    const third = fake(() => new FakeCallError('暂时不可用', 503, 'unavailable'));
    const judge3 = new JevJudge(third.asker, { answersFile: file });
    const done = await judge3.judgeBatched({ task: 'single_cmd_judge', questions: four });
    assert.deepEqual([third.requests.length, judge3.requests, Object.keys(done.answers).length, done.model_version], [0, 0, 4, VERSION]);

    // Another command, another state, another question: each is asked again, the others are not.
    const changed = fake(() => ({ type: 'noul', noul: 0.3 }));
    const asked = await new JevJudge(changed.asker, { answersFile: file }).judgeBatched({ task: 'single_cmd_judge', questions: { 1: { ...single(1), command: 'speed 7' }, 2: { ...single(2), state: '[用例]\n别的用例' }, 3: single(3), 4: { ...single(4), definition: 'speed <n:int>\n  other words' } } });
    assert.deepEqual(changed.requests.map(commandOf).sort(), ['speed 100 2', 'speed 100 4', 'speed 7']);
    assert.equal(asked.answers['3']!.match, 0.9);

    // A damaged line, a line of another shape and an answer that does not validate are no answers; the question is asked again.
    await appendFile(file, '{"key":"broken\n');
    await appendFile(file, `${JSON.stringify({ key: lines[0]!.key, model_version: VERSION, answer: { type: 'noul', noul: 1.5 } })}\n`);
    await appendFile(file, `${JSON.stringify({ key: 'x', model_version: VERSION, answer: { type: 'noul', noul: 0.1 } })}\n`);
    const damaged = fake(() => ({ type: 'noul', noul: 0.4 }));
    const again = await new JevJudge(damaged.asker, { answersFile: file }).judgeBatched({ task: 'single_cmd_judge', questions: { 1: single(1), 4: single(4) } });
    assert.deepEqual([damaged.requests.map(commandOf), again.answers['4']!.match], [[], 0.9], 'the later valid line of question 4 stands; question 1 keeps its first line, which validates');

    // The service now answers another version than the file names: that is no answer of this run.
    const moved = fake(() => ({ type: 'noul', noul: 0.4 }), 'jev-2.0.0');
    await assert.rejects(new JevJudge(moved.asker, { answersFile: file }).judgeBatched({ task: 'single_cmd_judge', questions: { 9: single(9) } }), /Jev 在一次核验里换了模型版本（jev-1\.13\.0、jev-2\.0\.0）/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
