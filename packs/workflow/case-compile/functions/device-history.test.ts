// The earlier device verifications of a case as a brief discloses them (functions/device-history.ts). Synthetic runs, commands and replies only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIOR_DEVICE_HISTORY_DISCLAIMER, renderPriorDeviceHistoryLines } from './authoring-brief.ts';
import {
  DEVICE_HISTORY_SCHEMA, HISTORY_COMMAND_CHARS, HISTORY_MAX_ENTRIES, HISTORY_REFUSALS_SHOWN, HISTORY_REPLY_CHARS, HISTORY_TOKEN_CHARS, parseDeviceHistory, parseHubHistory, priorDeviceHistory, sessionCommandCount, unavailableHistory, type DeviceHistoryFile, type HistoryRun, type LocalCaseReturn, stepCommands,
} from './device-history.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', CASE = '990000000000000301', OTHER = '990000000000000302';
const runId = (n: number) => `run_01${String(n).padStart(24, '0')}`;
const job = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
/** A run the Hub lists: one job that ended at hour `n`, with a row for each given case. */
const listed = (n: number, rows: Record<string, string> | null, build: string | null = 'synthetic-build-7'): HistoryRun =>
  ({ run: runId(n), started_at: `2026-11-1${n}T00:00:00.000Z`, build, jobs: [{ job: job(n), plan_run: runId(n + 40), ended_at: `2026-11-1${n}T01:00:00.000Z`, outcome: 'effective', rows: rows === null ? null : Object.entries(rows).map(([item, dynamic_terminal]) => ({ item, dynamic_terminal })) }] });
const fetched = (runs: HistoryRun[], returns: DeviceHistoryFile['returns'] = runs.map((run) => ({ run: run.run, dir: `history/${run.run}` }))): DeviceHistoryFile =>
  ({ schema: DEVICE_HISTORY_SCHEMA, run: RUN, fetched_at: '2026-11-20T00:00:00.000Z', status: 'fetched', answer: { schema: 'run-history@1', run: RUN, subjects: ['toy:mindmap:docq7'], limit: 6, complete: true, runs }, returns, elapsed_ms: 1200 });
/** What the returns on disk hold for the case in the job of run `n`. */
const local = (n: number, verdict: string, extra: Partial<LocalCaseReturn> = {}): LocalCaseReturn => {
  const folder = `history/${runId(n)}/${job(n).slice(0, 12)}/cases/${CASE}`;
  return { job: job(n), plan_run: runId(n + 40), verdict, log: `${folder}/log.txt`, sessions: [`${folder}/dev-a.txt`, `${folder}/dev-b.txt`], device_commands: 17, execution_refused: [], syntax_rejected: [], ...extra };
};
const none = () => ({ rows: [] as LocalCaseReturn[] });
const WORDS = ['必须', '一定', '不要', '不得', '禁止', '严禁', '务必', '应当', '绝不'];

test('the Hub answer is taken only as run-history@1 of the run asked about', () => {
  const answer = { schema: 'run-history@1', run: RUN, subjects: ['toy:mindmap:docq7'], limit: 6, complete: true, runs: [listed(1, { [CASE]: 'pass' })] };
  assert.deepEqual(parseHubHistory(answer, RUN), answer, 'kept as the Hub gave it');
  assert.deepEqual(parseHubHistory({ ...answer, runs: [{ ...listed(1, null), build: null }] }, RUN)!.runs[0], { ...listed(1, null), build: null }, 'rows the reader may not see stay unknown');
  for (const wrong of [null, 'text', { ...answer, schema: 'run-jobs@1' }, { ...answer, run: runId(9) }, { ...answer, runs: 'none' }, { ...answer, runs: [{ run: 'not-a-run', jobs: [] }] },
    { ...answer, runs: [{ ...listed(1, {}), jobs: [{ job: 'short', outcome: 'effective', rows: [] }] }] }, { ...answer, runs: [{ ...listed(1, {}), jobs: [{ job: job(1), outcome: 'effective', rows: [{ item: CASE }] }] }] }]) assert.equal(parseHubHistory(wrong, RUN), null, JSON.stringify(wrong).slice(0, 120));
  assert.deepEqual(parseDeviceHistory(JSON.parse(JSON.stringify(fetched([listed(1, { [CASE]: 'pass' })])))), fetched([listed(1, { [CASE]: 'pass' })]));
  assert.equal(parseDeviceHistory({ ...fetched([]), answer: null }), null, 'a fetched history holds the answer');
  assert.equal(parseDeviceHistory({ ...fetched([]), schema: 'device-returns@1' }), null);
  assert.deepEqual(parseDeviceHistory({ schema: DEVICE_HISTORY_SCHEMA, run: RUN, fetched_at: 't', status: 'unavailable', reason: '合成原因', answer: null, returns: [], elapsed_ms: 3 })!.reason, '合成原因');
});

test('the commands a session shows are the lines typed at a device prompt', () => {
  const session = ['seat#configure terminal', 'seat(config)#widget health interval pool-a 60', 'ok', 'seat(config)#', 'seat(config)#exit', 'not a prompt line', 'seat#show widget name', 'pool-a   60', 'seat#'].join('\r\n');
  assert.equal(sessionCommandCount(session), 4, 'a bare prompt and the device\'s own lines are no command');
  assert.equal(sessionCommandCount(''), 0);
  assert.equal(sessionCommandCount(`seat#${'x'.repeat(40)}\u001b[K redrawn`), 1, 'an echo the terminal redrew is still one command');
});

test('no file, a fetch that did not succeed and a history with no row of the case are three different answers', () => {
  const absent = priorDeviceHistory(null, CASE, none, '合成：没有文件');
  assert.deepEqual([absent.status, absent.unavailable_reason, absent.entries, absent.match_key, absent.max_entries, absent.disclaimer], ['unavailable_from_hub', '合成：没有文件', [], 'autoid', 6, PRIOR_DEVICE_HISTORY_DISCLAIMER]);
  const failed = priorDeviceHistory({ schema: DEVICE_HISTORY_SCHEMA, run: RUN, fetched_at: 't', status: 'unavailable', reason: 'Hub 没有历次上机验证的查询接口（答复 404）', answer: null, returns: [], elapsed_ms: 5 }, CASE, none, '合成：没有文件');
  assert.deepEqual([failed.status, failed.unavailable_reason], ['unavailable_from_hub', 'Hub 没有历次上机验证的查询接口（答复 404）']);
  assert.deepEqual(unavailableHistory('合成').status, 'unavailable_from_hub');
  for (const file of [fetched([]), fetched([listed(1, { [OTHER]: 'pass' })]), fetched([listed(1, null)])]) {
    const found = priorDeviceHistory(file, CASE, none, '合成');
    assert.deepEqual([found.status, found.entries.length, 'unavailable_reason' in found], ['none_found', 0, false]);
  }
  assert.match(renderPriorDeviceHistoryLines(absent).join('\n'), /同用例历史上机记录（unavailable_from_hub）：没有取到。合成：没有文件/);
  assert.match(renderPriorDeviceHistoryLines(priorDeviceHistory(fetched([]), CASE, none, '合成')).join('\n'), /同用例历史上机记录（none_found）：Hub 列出的此前上机里，没有哪一次的报告带这一条用例（按 autoid 对，0 条）。/);
});

test('an entry states recorded facts; the newest passing one comes first, then newest first, six at most', () => {
  const file = fetched([listed(5, { [CASE]: 'fail', [OTHER]: 'pass' }), listed(4, { [CASE]: 'pass' }), listed(3, { [CASE]: 'pass' }), listed(2, { [OTHER]: 'pass' }), listed(1, { [CASE]: 'fail' }, null)]);
  const held: Record<string, LocalCaseReturn[]> = {
    [runId(5)]: [local(5, 'fail', { execution_refused: [{ command: 'widget health interval pool-a 600', reply: ['Value out of range', 'Failed to run the synthetic command'] }], syntax_rejected: [{ command: 'widget sync to peer-b', token: 'sync' }] })],
    [runId(4)]: [local(4, 'pass')], [runId(3)]: [local(3, 'pass')], [runId(1)]: [local(1, 'not_run', { log: null, sessions: [], device_commands: null })],
  };
  const history = priorDeviceHistory(file, CASE, (run) => ({ rows: held[run] ?? [] }), '合成');
  assert.equal(history.status, 'available');
  assert.deepEqual(history.entries.map((entry) => [entry.verification_run, entry.verdict]), [[runId(4), 'pass'], [runId(5), 'fail'], [runId(3), 'pass'], [runId(1), 'not_run']], 'the run without a row of the case is no entry');
  assert.deepEqual(history.entries[1], {
    verification_run: runId(5), plan_run: runId(45), build: 'synthetic-build-7', ended_at: '2026-11-15T01:00:00.000Z', verdict: 'fail',
    log: `history/${runId(5)}/${job(5).slice(0, 12)}/cases/${CASE}/log.txt`, sessions: ['dev-a.txt', 'dev-b.txt'].map((name) => `history/${runId(5)}/${job(5).slice(0, 12)}/cases/${CASE}/${name}`), device_commands: 17,
    execution_refused: { total: 1, shown: [{ command: 'widget health interval pool-a 600', reply: 'Value out of range / Failed to run the synthetic command' }] },
    syntax_rejected: { total: 1, shown: [{ command: 'widget sync to peer-b', token: 'sync' }] },
  });
  assert.deepEqual([history.entries[3].build, history.entries[3].verdict, history.entries[3].log, history.entries[3].device_commands], [null, 'not_run', null, null], 'the returns\' own reading of the row: the runner never reached the case');
  const lines = renderPriorDeviceHistoryLines(history), text = lines.join('\n');
  assert.ok(text.includes(`- 同用例历史上机记录（available，共 4 条，按 autoid 对）：${PRIOR_DEVICE_HISTORY_DISCLAIMER.slice(0, 20)}`));
  assert.ok(text.replace(/\n\s*/g, '').includes(PRIOR_DEVICE_HISTORY_DISCLAIMER));
  const joined = text.replace(/\n {2,}/g, '');
  assert.ok(joined.includes(`· [上机 ${runId(5)} | 计划 ${runId(45)} | 构建 synthetic-build-7 | 结束 2026-11-15T01:00:00.000Z | 结论 fail（未通过）] 运行日志 history/${runId(5)}/${job(5).slice(0, 12)}/cases/${CASE}/log.txt；设备会话 2 份，在 history/${runId(5)}/${job(5).slice(0, 12)}/cases/${CASE}/：dev-a.txt、dev-b.txt；会话里发给设备的命令 17 条（命令原文在日志和会话里）；设备拒绝执行 1 条：“widget health interval pool-a 600” 设备答 “Value out of range / Failed to run the synthetic command”；设备没有解析 1 条：“widget sync to peer-b”（停在 sync）`), joined);
  assert.ok(joined.includes(`· [上机 ${runId(1)} | 计划 ${runId(41)} | 构建未记录 | 结束 2026-11-11T01:00:00.000Z | 结论 not_run（未运行）] 这次上机的设备输出没有下载到本地`), joined);
  for (const word of WORDS) assert.ok(!text.includes(word), `the lines disclose and give no instruction: ${word}`);

  // Eight verifications of the case: six entries, the passing one first although it is the oldest.
  const many = fetched(Array.from({ length: 8 }, (_, k) => listed(8 - k, { [CASE]: k === 7 ? 'pass' : 'fail' })));
  const six = priorDeviceHistory(many, CASE, none, '合成');
  assert.equal(six.entries.length, HISTORY_MAX_ENTRIES);
  assert.deepEqual(six.entries.map((entry) => entry.verification_run), [runId(1), runId(8), runId(7), runId(6), runId(5), runId(4)]);
  assert.ok(six.entries.every((entry) => entry.files_missing === '这次上机的设备输出没有下载到本地' && entry.log === null), 'without the returns on disk the entry holds the Hub\'s facts and says the files are not here');
  assert.equal(priorDeviceHistory(fetched([listed(2, { [CASE]: 'fail' })], [{ run: runId(2), dir: null, reason: '合成：超时' }]), CASE, () => ({ rows: [], missing: '这次上机的设备输出没有下载到本地：合成：超时' }), '合成').entries[0].files_missing, '这次上机的设备输出没有下载到本地：合成：超时');
});

test('a generated name of 253 characters, long replies and many refusals do not grow an entry', () => {
  const name = `${'n'.repeat(249)}.net`;
  assert.equal(name.length, 253);
  const refused = Array.from({ length: 40 }, (_, k) => ({ command: `widget record add ${name} address 192.0.2.${k + 1}`, reply: Array.from({ length: 6 }, () => `The synthetic record ${name} cannot coexist with another record type`) }));
  const rejected = Array.from({ length: 40 }, (_, k) => ({ command: `widget record remove ${name} ${k}`, token: name }));
  const history = priorDeviceHistory(fetched(Array.from({ length: 6 }, (_, k) => listed(k + 1, { [CASE]: 'fail' }))), CASE, (run) => ({ rows: [local(Number(run.slice(-1)), 'fail', { execution_refused: refused, syntax_rejected: rejected })] }), '合成');
  assert.equal(history.entries.length, 6);
  for (const entry of history.entries) {
    assert.deepEqual([entry.execution_refused.total, entry.execution_refused.shown.length, entry.syntax_rejected.total, entry.syntax_rejected.shown.length], [40, HISTORY_REFUSALS_SHOWN, 40, HISTORY_REFUSALS_SHOWN]);
    for (const row of entry.execution_refused.shown) { assert.ok([...row.command].length <= HISTORY_COMMAND_CHARS + 1 && [...row.reply].length <= HISTORY_REPLY_CHARS + 1); assert.ok(row.command.startsWith('widget record add nnnn') && row.command.endsWith('…')); }
    for (const row of entry.syntax_rejected.shown) assert.ok([...row.command].length <= HISTORY_COMMAND_CHARS + 1 && [...row.token!].length <= HISTORY_TOKEN_CHARS + 1);
  }
  const serialized = JSON.stringify(history), rendered = renderPriorDeviceHistoryLines(history).join('\n');
  assert.ok(!serialized.includes(name) && !rendered.includes(name), 'the whole name is in the log, not in the brief');
  assert.ok(Buffer.byteLength(serialized) < 12_000, `${Buffer.byteLength(serialized)} bytes for six entries`);
  assert.ok(Buffer.byteLength(rendered) < 12_000, `${Buffer.byteLength(rendered)} bytes rendered`);
  assert.ok(rendered.includes('设备拒绝执行 40 条（列前 3 条）') && rendered.includes('设备没有解析 40 条（列前 3 条）'), 'how many there were is said; the rest is in the files');
  for (const word of WORDS) assert.ok(!rendered.includes(word), word);
});

test('the commands a run log shows are taken one per step, and what the runner sends by itself is left out', () => {
  const log = [
    '2026-11-20 20:39:58 192.0.2.70 - sends command in config: clock set 20 39 58',
    '2026-11-20 20:40:00 #######   step2: 合成用例标题',
    '2026-11-20 20:40:00 192.0.2.70 - sends command in config: widget on',
    '2026-11-20 20:40:03 #######   step3: 取数观察',
    '2026-11-20 20:40:03 192.0.2.70 - sends command in enable: show widget name "' + 'n'.repeat(120) + '"',
    '2026-11-20 20:40:04 #######   step4: 从上一步的输出取一格，不发命令',
    '2026-11-20 20:40:05 #######   step5: 主机查询',
    '2026-11-20 20:40:05 hostb executes command: probe @192.0.2.70 name',
    '2026-11-20 20:40:05 #### Success Num 1: successed to find x in : ',
    '2026-11-20 20:40:06 #######   step6: 配对逆清理',
    '2026-11-20 20:40:06 192.0.2.70 - sends command in config: widget off',
    '2026-11-20 20:40:07 192.0.2.70 - sends command in config: clear widget all',
    '2026-11-20 20:40:08 #######   end case: 990000000000000301',
    '2026-11-20 20:40:09 192.0.2.70 - sends command in config: clock set 20 40 09',
  ].join('\n');
  assert.deepEqual(stepCommands(log).map((row) => [row.step, row.by, row.mode, row.command.slice(0, 24)]), [
    [2, '192.0.2.70', 'config', 'widget on'],
    [3, '192.0.2.70', 'enable', 'show widget name "nnnnnn'],
    [5, 'hostb', null, 'probe @192.0.2.70 name'],
    [6, '192.0.2.70', 'config', 'widget off'],
  ], 'the clock before the case, the clearing after its last step and the next case are the runner\'s own');
  assert.deepEqual(stepCommands('no step marks at all\n192.0.2.70 - sends command in config: widget on'), []);
});

test('the newest run that passed shows what each of its steps sent, in the brief itself; later entries do not repeat it', () => {
  const run = (n: string) => 'run_01' + n.repeat(24), job = (n: string) => n.repeat(64), CASE7 = '990000000000000777';
  const file = parseDeviceHistory({ schema: DEVICE_HISTORY_SCHEMA, run: run('z'), fetched_at: '2026-11-20T00:00:00.000Z', status: 'fetched', elapsed_ms: 1,
    answer: { schema: 'run-history@1', run: run('z'), subjects: ['toy:mindmap:docq7'], limit: 6, complete: true, runs: [
      { run: run('a'), started_at: null, build: 'synthetic-build-7', jobs: [{ job: job('a'), plan_run: null, ended_at: '2026-11-19T03:00:00.000Z', outcome: 'effective', rows: [{ item: CASE7, dynamic_terminal: 'fail' }] }] },
      { run: run('b'), started_at: null, build: 'synthetic-build-7', jobs: [{ job: job('b'), plan_run: null, ended_at: '2026-11-19T02:00:00.000Z', outcome: 'effective', rows: [{ item: CASE7, dynamic_terminal: 'pass' }] }] },
      { run: run('c'), started_at: null, build: 'synthetic-build-7', jobs: [{ job: job('c'), plan_run: null, ended_at: '2026-11-19T01:00:00.000Z', outcome: 'effective', rows: [{ item: CASE7, dynamic_terminal: 'pass' }] }] },
    ] },
    returns: [{ run: run('a'), dir: 'history/a' }, { run: run('b'), dir: 'history/b' }, { run: run('c'), dir: 'history/c' }] })!;
  const sent = (first: string) => [{ step: 2, by: '192.0.2.70', mode: 'config', command: first }, { step: 3, by: '192.0.2.70', mode: 'enable', command: 'show widget name "' + 'n'.repeat(120) + '"' }, { step: 5, by: 'hostb', mode: null, command: 'probe @192.0.2.70 name' }];
  const local = (name: string) => ({ rows: [{ job: job(name.slice(-1)), plan_run: null, verdict: name.endsWith('a') ? 'fail' : 'pass', log: `history/${name.slice(-1)}/log.txt`, sessions: [], device_commands: null, execution_refused: [], syntax_rejected: [], ...(name.endsWith('a') ? {} : { step_commands: sent(name.endsWith('b') ? 'widget on' : 'widget legacy on') }) }] });
  const prior = priorDeviceHistory(file, CASE7, (name) => local(name), '合成');
  assert.deepEqual(prior.entries.map((entry) => [entry.verdict, entry.passed_commands?.total ?? null]), [['pass', 3], ['fail', null], ['pass', null]], 'the newest run that passed comes first and is the only one whose commands are listed');
  assert.deepEqual(prior.entries[0]!.passed_commands!.shown, ['192.0.2.70（config）：widget on', `192.0.2.70（enable）：show widget name "${'n'.repeat(HISTORY_COMMAND_CHARS - 18)}…`, 'hostb：probe @192.0.2.70 name'], 'who sent it and in which mode, each command by its beginning');
  const lines = renderPriorDeviceHistoryLines(prior);
  const at = lines.findIndex((line) => line.includes('这一次通过的计划按步骤发出的命令'));
  assert.deepEqual(lines.slice(at, at + 4), ['    这一次通过的计划按步骤发出的命令（日志里共 3 条；每条只取开头，全文在上面的运行日志）：', '      1. 192.0.2.70（config）：widget on', `      2. 192.0.2.70（enable）：show widget name "${'n'.repeat(HISTORY_COMMAND_CHARS - 18)}…`, '      3. hostb：probe @192.0.2.70 name']);
  assert.equal(lines.filter((line) => line.includes('这一次通过的计划按步骤发出的命令')).length, 1);
  for (const line of lines) assert.doesNotMatch(line, /必须|一定|不要|不得|禁止|严禁|务必|应当|绝不|照抄|照着/);
});
