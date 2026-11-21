import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRIOR_DEVICE_HISTORY_DISCLAIMER, PRIOR_DEVICE_HISTORY_UNAVAILABLE_REASON, validateCompileBrief, type CompileBriefV1 } from '../functions/authoring-brief.ts';
import { DEVICE_HISTORY_SCHEMA } from '../functions/device-history.ts';
import { knowledgeFiles } from '../functions/knowledge-text.ts';
import { loadPriorDeviceHistory, writeStructuredBriefs } from './authoring-brief.ts';
import { buildTaskBrief } from './task-brief.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', ROOT = 'a'.repeat(64), CASE = '990000000000000301', OTHER = '990000000000000302';
const V1 = `run_01${'b'.repeat(24)}`, V2 = `run_01${'c'.repeat(24)}`, V3 = `run_01${'d'.repeat(24)}`, P1 = `run_01${'e'.repeat(24)}`, P2 = `run_01${'f'.repeat(24)}`;
const digest = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const PACK = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const WORDS = ['必须', '一定', '不要', '不得', '禁止', '严禁', '务必', '应当', '绝不'];
const NAME = `${'n'.repeat(249)}.net`;

function batch(): Buffer {
  const nodes = [
    { path: '/', reference: `tree:${ROOT}/`, name: '', level: 'branch', digest: digest(1), children: [{ name: 'commands', path: '/commands', digest: digest(2) }], entries: [] },
    { path: '/commands', reference: `tree:${ROOT}/commands`, name: 'commands', level: 'branch', digest: digest(2), children: [{ name: 'widget', path: '/commands/widget', digest: digest(3) }], entries: [] },
    { path: '/commands/widget', reference: `tree:${ROOT}/commands/widget`, name: 'widget', level: 'leaf', digest: digest(3), children: [], entries: [{ entry: digest(50), kind: 'definition', statement: 'widget on', reference: `tree:${ROOT}/commands/widget@${digest(50)}`, data: {} }] },
  ];
  return Buffer.from([{ schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: nodes.length, entries: 1 }, ...nodes].map((line) => JSON.stringify(line)).join('\n') + '\n');
}
const item = (autoid: string) => ({
  id: `doc-1:${autoid}`,
  fields: {
    autoid, title: '合成用例开启部件',
    expected_nodes: [{ reference: `src:${digest(8)}/kityminder@1/n/e-1`, text: '部件开启' }],
    recomposition: { receipt: `rec:${digest(7)}`, record: {
      case: { id: 'case-0001', title: '合成用例开启部件' },
      expectation_slots: [{ slot: 'e1', atom: 'a2', reference: `src:${digest(8)}/kityminder@1/n/e-1`, text: '部件开启' }],
      atoms: [{ id: 'a1', kind: 'action', text: 'widget on', reference: `src:${digest(8)}/kityminder@1/n/s-1` }, { id: 'a2', kind: 'expectation', text: '部件开启', reference: `src:${digest(8)}/kityminder@1/n/e-1` }],
      sources: { candidates: [], governing: [], states: [] }, ledgers: { adapted: [] },
    } },
  },
});
async function workdir(): Promise<string> {
  const work = realpathSync(await mkdtemp(join(tmpdir(), 'cc-history-brief-'))), run = join(work, 'plan-run');
  for (const { name, bytes } of knowledgeFiles(batch(), RUN).outputs) { await mkdir(dirname(join(run, name)), { recursive: true }); await writeFile(join(run, name), bytes); }
  await writeFile(join(run, 'run.json'), JSON.stringify({ run: RUN, product: 'synth-widget', version: '1.0.0', build: 'synthetic-build-9', groups: [] }));
  await mkdir(join(run, 'items')); await mkdir(join(run, 'briefs'));
  for (const [index, autoid] of [CASE, OTHER].entries()) { await writeFile(join(run, 'items', `0${index}.json`), JSON.stringify(item(autoid))); await writeFile(join(run, 'briefs', `0${index}.md`), '# 合成编写简报\n'); }
  await writeFile(join(work, 'scope.md'), '只做这一份合成脑图的两条用例。', 'utf8');
  return work;
}
const jobOf = (run: string) => (run === V1 ? digest(0xa1) : run === V2 ? digest(0xa2) : digest(0xa3));
async function returns(work: string, run: string, planRun: string, row: { verdict: string; sessions: Record<string, string>; execution_refused?: unknown[]; syntax_rejected?: unknown[] }): Promise<void> {
  const folder = join(jobOf(run).slice(0, 12), 'cases', CASE), base = join(work, 'history', run);
  await mkdir(join(base, folder), { recursive: true });
  await writeFile(join(base, folder, 'log.txt'), `合成运行日志 ${run}\n`);
  for (const [name, text] of Object.entries(row.sessions)) await writeFile(join(base, folder, name), text);
  await writeFile(join(base, 'index.json'), JSON.stringify({ schema: 'device-returns@1', run, jobs: [{ outcome: 'effective', job: jobOf(run), plan_run: planRun, ended: 'done', rows: [
    { item: CASE, verdict: row.verdict, log: join(folder, 'log.txt'), sessions: Object.fromEntries(Object.keys(row.sessions).map((name) => [name, join(folder, name)])), syntax_rejected: row.syntax_rejected ?? [], execution_refused: row.execution_refused ?? [] },
  ] }] }));
}
const listed = (run: string, planRun: string, day: number, rows: Record<string, string>) => ({ run, started_at: `2026-11-${day}T00:00:00.000Z`, build: 'synthetic-build-7', jobs: [{ job: jobOf(run), plan_run: planRun, ended_at: `2026-11-${day}T01:30:00.000Z`, outcome: 'effective', rows: Object.entries(rows).map(([autoid, dynamic_terminal]) => ({ item: autoid, dynamic_terminal })) }] });
const history = (runs: unknown[], kept: Array<{ run: string; dir: string | null; reason?: string }>) => ({ schema: DEVICE_HISTORY_SCHEMA, run: RUN, fetched_at: '2026-11-20T00:00:00.000Z', status: 'fetched', answer: { schema: 'run-history@1', run: RUN, subjects: ['toy:mindmap:docq7'], limit: 6, complete: true, runs }, returns: kept, elapsed_ms: 1500 });
const historyLines = (text: string): string[] => { const lines = text.split('\n'), at = lines.findIndex((line) => line.startsWith('- 同用例历史上机记录')); const out = [lines[at]!]; for (let k = at + 1; k < lines.length && /^ {2}/.test(lines[k]!); k++) out.push(lines[k]!); return out; };

test('a case verified before gets its entries in the brief and in the writer\'s task: recorded facts, paths from the working directory, the passing run first', async () => {
  const work = await workdir();
  try {
    await returns(work, V1, P1, { verdict: 'fail', sessions: {
      'dev-a.txt': ['seat#configure terminal', `seat(config)#widget record add ${NAME} address 192.0.2.7`, 'The synthetic record cannot coexist with another record type', 'Failed to run the synthetic command', 'seat(config)#exit', 'seat#show widget record', 'name      address', 'seat#'].join('\n'),
      'dev-b.txt': ['peer#widget sync to seat', '', 'widget sync to seat ', '       ^', 'peer#'].join('\n'),
    }, execution_refused: [{ session: 'dev-a.txt', prompt: 'seat(config)#', command: `widget record add ${NAME} address 192.0.2.7`, reply: ['The synthetic record cannot coexist with another record type', 'Failed to run the synthetic command'] }],
      syntax_rejected: [{ session: 'dev-b.txt', command: 'widget sync to seat', token: 'sync', prompt: 'peer#' }] });
    await returns(work, V2, P2, { verdict: 'pass', sessions: { 'dev-a.txt': ['seat#configure terminal', 'seat(config)#widget on', 'seat(config)#exit', 'seat#show widget', 'on', 'seat#'].join('\n') } });
    await writeFile(join(work, 'plan-run', 'history.json'), JSON.stringify(history(
      [listed(V1, P1, 19, { [CASE]: 'fail', [OTHER]: 'pass' }), listed(V2, P2, 18, { [CASE]: 'pass' }), listed(V3, P2, 17, { [CASE]: 'fail' })],
      [{ run: V1, dir: join('history', V1) }, { run: V2, dir: join('history', V2) }, { run: V3, dir: null, reason: '取上机历史的总时限 240 秒已到，这一次的设备输出没有下载' }])));

    const written = await writeStructuredBriefs({ runDir: 'plan-run', cwd: work, round: 1, mode: 'initial', caseFilter: CASE });
    const brief = JSON.parse(await readFile(written.json_files[0]!, 'utf8')) as CompileBriefV1;
    assert.deepEqual(validateCompileBrief(brief, item(CASE)), { ok: true, problems: [] });
    const prior = brief.prior_device_history;
    assert.deepEqual([prior.status, prior.match_key, prior.max_entries, prior.disclaimer, 'unavailable_reason' in prior], ['available', 'autoid', 6, PRIOR_DEVICE_HISTORY_DISCLAIMER, false]);
    assert.deepEqual(prior.entries.map((entry) => [entry.verification_run, entry.verdict]), [[V2, 'pass'], [V1, 'fail'], [V3, 'fail']], 'the newest passing entry first, then newest first');
    const folder1 = join('history', V1, jobOf(V1).slice(0, 12), 'cases', CASE), folder2 = join('history', V2, jobOf(V2).slice(0, 12), 'cases', CASE);
    assert.deepEqual(prior.entries[0], { verification_run: V2, plan_run: P2, build: 'synthetic-build-7', ended_at: '2026-11-18T01:30:00.000Z', verdict: 'pass', log: join(folder2, 'log.txt'), sessions: [join(folder2, 'dev-a.txt')], device_commands: 4, execution_refused: { total: 0, shown: [] }, syntax_rejected: { total: 0, shown: [] } });
    assert.deepEqual([prior.entries[1]!.log, prior.entries[1]!.sessions, prior.entries[1]!.device_commands], [join(folder1, 'log.txt'), [join(folder1, 'dev-a.txt'), join(folder1, 'dev-b.txt')], 5], 'the commands typed at a prompt in both sessions');
    assert.deepEqual(prior.entries[1]!.execution_refused, { total: 1, shown: [{ command: `widget record add ${'n'.repeat(62)}…`, reply: 'The synthetic record cannot coexist with another record type / Failed to run the synthetic command' }] });
    assert.deepEqual(prior.entries[1]!.syntax_rejected, { total: 1, shown: [{ command: 'widget sync to seat', token: 'sync' }] });
    assert.deepEqual([prior.entries[2]!.log, prior.entries[2]!.sessions, prior.entries[2]!.device_commands, prior.entries[2]!.files_missing], [null, [], null, '这次上机的设备输出没有下载到本地：取上机历史的总时限 240 秒已到，这一次的设备输出没有下载']);
    for (const path of [prior.entries[0]!.log!, ...prior.entries[1]!.sessions]) assert.ok((await readFile(join(work, path), 'utf8')).length > 0, `${path} is where the brief says, from the working directory`);

    const markdown = await readFile(written.md_files[0]!, 'utf8');
    const task = await buildTaskBrief({ role: '脚本编写', caseRef: CASE, briefPath: join('plan-run', 'briefs', '00.md'), outPath: join('cases', '00', 'plan', '00.json'), runDir: 'plan-run', cwd: work, packRoot: PACK });
    const lines = historyLines(task);
    assert.deepEqual(historyLines(markdown), lines);
    assert.deepEqual(lines, [
      '- 同用例历史上机记录（available，共 3 条，按 autoid 对）：以下是同一条原始用例此前上机的记录：别的计划在当时的构建上跑出来的设备原话，只说明设备当时怎么回答，不是本次期望值的依据。',
      `  · [上机 ${V2} | 计划 ${P2} | 构建 synthetic-build-7 | 结束 2026-11-18T01:30:00.000Z | 结论 pass（通过）] 运行日志 ${folder2}/log.txt；设备会话 1 份，在 ${folder2}/：dev-a.txt；会话里发给设备的命令 4 条（命令原文在日志和会话里）`,
      `  · [上机 ${V1} | 计划 ${P1} | 构建 synthetic-build-7 | 结束 2026-11-19T01:30:00.000Z | 结论 fail（未通过）] 运行日志 ${folder1}/log.txt；设备会话 2 份，在 ${folder1}/：dev-a.txt、dev-b.txt；会话里发给设备的命令 5 条（命令原文在日志和会话里）；设备拒绝执行 1 条：“widget record add ${'n'.repeat(62)}…” 设备答 “The synthetic record cannot coexist with another record type / Failed to run the synthetic command”；设备没有解析 1 条：“widget sync to seat”（停在 sync）`,
      `  · [上机 ${V3} | 计划 ${P2} | 构建 synthetic-build-7 | 结束 2026-11-17T01:30:00.000Z | 结论 fail（未通过）] 这次上机的设备输出没有下载到本地：取上机历史的总时限 240 秒已到，这一次的设备输出没有下载`,
    ]);
    for (const text of [lines.join('\n'), JSON.stringify(prior)]) { assert.ok(!text.includes(NAME), 'the 253-character name is in the log and the session, not in the brief'); for (const word of WORDS) assert.ok(!text.includes(word), word); }
    assert.ok(Buffer.byteLength(JSON.stringify(prior)) < 4000 && Buffer.byteLength(lines.join('\n')) < 3000, 'three entries stay small');

    const other = await loadPriorDeviceHistory(join(work, 'plan-run'), OTHER, work);
    assert.deepEqual([other.status, other.entries.map((entry) => [entry.verification_run, entry.verdict, entry.log, entry.files_missing])], ['available', [[V1, 'pass', null, '这次上机的设备输出没有下载到本地']]], 'the returns hold no row of this case, so only the Hub\'s facts are stated');
  } finally { await rm(work, { recursive: true, force: true }); }
});
test('a case nothing verified, a Hub that gave no history and a run downloaded without one are said as they are', async () => {
  const work = await workdir();
  try {
    const run = join(work, 'plan-run');
    const briefOf = async (round: number) => {
      const written = await writeStructuredBriefs({ runDir: 'plan-run', cwd: work, round, mode: 'initial', caseFilter: CASE, briefOut: `briefs-${round}` });
      return { brief: JSON.parse(await readFile(written.json_files[0]!, 'utf8')) as CompileBriefV1, lines: historyLines(await readFile(written.md_files[0]!, 'utf8')).join('\n').replace(/\n {2,}/g, '') };
    };
    const absent = await briefOf(1);
    assert.deepEqual([absent.brief.prior_device_history.status, absent.brief.prior_device_history.unavailable_reason, absent.brief.prior_device_history.entries], ['unavailable_from_hub', PRIOR_DEVICE_HISTORY_UNAVAILABLE_REASON, []]);
    assert.equal(absent.lines, `- 同用例历史上机记录（unavailable_from_hub）：没有取到。${PRIOR_DEVICE_HISTORY_UNAVAILABLE_REASON}`);
    await writeFile(join(run, 'history.json'), JSON.stringify({ schema: DEVICE_HISTORY_SCHEMA, run: RUN, fetched_at: '2026-11-20T00:00:00.000Z', status: 'unavailable', reason: 'Hub 没有历次上机验证的查询接口（答复 404）：这台 Hub 的版本早于这个接口', answer: null, returns: [], elapsed_ms: 40 }));
    const old = await briefOf(2);
    assert.deepEqual([old.brief.prior_device_history.status, old.brief.prior_device_history.unavailable_reason], ['unavailable_from_hub', 'Hub 没有历次上机验证的查询接口（答复 404）：这台 Hub 的版本早于这个接口']);
    assert.equal(old.lines, '- 同用例历史上机记录（unavailable_from_hub）：没有取到。Hub 没有历次上机验证的查询接口（答复 404）：这台 Hub 的版本早于这个接口');
    for (const [round, runs] of [[3, []], [4, [listed(V1, P1, 19, { [OTHER]: 'pass' })]]] as const) {
      await writeFile(join(run, 'history.json'), JSON.stringify(history([...runs], runs.map((row) => ({ run: row.run, dir: null, reason: '合成' })))));
      const none = await briefOf(round);
      assert.deepEqual([none.brief.prior_device_history.status, none.brief.prior_device_history.entries, 'unavailable_reason' in none.brief.prior_device_history], ['none_found', [], false]);
      assert.equal(none.lines, '- 同用例历史上机记录（none_found）：Hub 列出的此前上机里，没有哪一次的报告带这一条用例（按 autoid 对，0 条）。');
      assert.deepEqual(validateCompileBrief(none.brief, item(CASE)), { ok: true, problems: [] });
    }
    await writeFile(join(run, 'history.json'), '{"schema":"device-returns@1"}');
    assert.deepEqual([(await briefOf(5)).brief.prior_device_history.status, (await loadPriorDeviceHistory(run, CASE, work)).unavailable_reason], ['unavailable_from_hub', '运行目录里的 history.json 读不出来（不是 device-history@1）。']);
    await writeFile(join(run, 'history.json'), JSON.stringify(history([listed(V1, P1, 19, { [CASE]: 'fail' })], [{ run: V1, dir: join('..', 'elsewhere') }])));
    const outside = await loadPriorDeviceHistory(run, CASE, work);
    assert.deepEqual([outside.status, outside.entries[0]!.log, outside.entries[0]!.files_missing], ['available', null, `设备输出的目录 ${join('..', 'elsewhere')} 不在工作目录里`]);
    for (const text of [absent.lines, old.lines]) for (const word of WORDS) assert.ok(!text.includes(word), word);
  } finally { await rm(work, { recursive: true, force: true }); }
});

test('a brief whose history has another shape is refused by its check, in words that state what is wrong', async () => {
  const work = await workdir();
  try {
    const written = await writeStructuredBriefs({ runDir: 'plan-run', cwd: work, round: 1, mode: 'initial', caseFilter: CASE });
    const brief = JSON.parse(await readFile(written.json_files[0]!, 'utf8')) as CompileBriefV1;
    const problemsOf = (history: unknown) => { const checked = validateCompileBrief({ ...brief, prior_device_history: history }, item(CASE)); return checked.ok ? [] : checked.problems.filter((problem) => problem.includes('prior_device_history')); };
    const base = brief.prior_device_history;
    assert.deepEqual(problemsOf({ ...base, status: 'available' }), ['prior_device_history.status 为 available 时 entries 至少一条，其余状态 entries 为空']);
    assert.deepEqual(problemsOf({ ...base, status: 'none_found', entries: [{ verification_run: V1, verdict: 'pass', device_cmds: ['widget on'] }] }), ['prior_device_history.status 为 available 时 entries 至少一条，其余状态 entries 为空', 'prior_device_history.entries[0] 的形状不对：要有 verification_run、verdict、log、sessions、device_commands、execution_refused 和 syntax_rejected']);
    assert.deepEqual(problemsOf({ ...base, disclaimer: '合成：照旧记录写' }), ['prior_device_history.disclaimer 不是这个版本的说明句']);
    assert.deepEqual(problemsOf({ ...base, match_key: 'title' }), ['prior_device_history.match_key 只能是 autoid']);
    assert.deepEqual(problemsOf({ ...base, status: 'guessed' }), ['prior_device_history.status 只能是 unavailable_from_hub、none_found 或 available']);
    for (const word of WORDS) assert.ok(!problemsOf({ ...base, status: 'available', match_key: 'title', disclaimer: '' }).join('').includes(word), word);
  } finally { await rm(work, { recursive: true, force: true }); }
});
