import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main, type PipelineState, type RunTool, type ToolRun } from '../tools/pipeline.ts';

const SOURCE = readFileSync(new URL('./compile-loop.js', import.meta.url), 'utf8');
const ok = (stdout = '{"ok":true}'): ToolRun => ({ code: 0, stdout, stderr: '' });
const bad = (stderr: string): ToolRun => ({ code: 1, stdout: '', stderr });
const OPEN = { recompose_run: 'run_01recomposerecompose00', plan_run: 'run_01planplanplanplanplan00' };
const PIPELINE = '/synthetic skills/case-compile/tools/pipeline.ts';

async function world(cases: number): Promise<string[]> {
  process.chdir(await mkdtemp(join(tmpdir(), 'compile-loop-')));
  for (const run of ['recompose-run', 'plan-run']) await mkdir(join(run, 'items'), { recursive: true });
  await mkdir(join('plan-run', 'briefs'), { recursive: true }); await mkdir('records', { recursive: true });
  const items: string[] = [];
  for (let n = 0; n < cases; n++) {
    const i = String(n).padStart(2, '0'), autoid = `99000000000000${String(1000 + n)}`;
    items.push(`n/r${i}`);
    await writeFile(join('recompose-run', 'items', `${i}.json`), JSON.stringify({ id: `n/r${i}`, fields: { case_id: autoid, node: `n/${i}` } }));
    await writeFile(join('plan-run', 'items', `${i}.json`), JSON.stringify({ id: `doc:${i}`, fields: { autoid, title: `合成用例 ${i}` }, location: { selector: `n/${i}` } }));
    await writeFile(join('plan-run', 'briefs', `${i}.md`), '合成简报');
  }
  await writeFile('open-compile.json', JSON.stringify(OPEN));
  return items;
}

interface Bench {
  gate?: (tool: string, args: string[]) => ToolRun | undefined;
  writes?: (label: string, start: number) => boolean;
  ends?: (label: string, start: number) => boolean;
}
async function bench(cases: number, { gate = () => undefined, writes = () => true, ends = () => true }: Bench = {}) {
  const items = await world(cases);
  const answer = ok('合成答复\n供模型引用\n' + JSON.stringify({ call_result: 'ok', acceptance: 'accepted', result: { partitions: { delivered: items.map((item) => ({ item, requirements: [{ requirement: 'record', status: 'satisfied', claims: [] }] })) } } }));
  const run: RunTool = async (_skill, tool, args) => {
    if (tool === 'task-brief.ts') return ok(`派发提示 ${args[args.indexOf('--role') + 1]} ${args[args.indexOf('--case') + 1]}`);
    return gate(tool, args) ?? (tool === 'submit-records.ts' ? answer : ok());
  };
  const printed = async (argv: string[], stdin: string[]): Promise<{ code: number; output: string }> => {
    const lines: string[] = []; const write = process.stdout.write;
    process.stdout.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stdout.write;
    try { return { code: await main(argv, async () => stdin, run), output: lines.join('').trimEnd() }; } finally { process.stdout.write = write; }
  };
  assert.equal((await printed(['init', '--recompose-run', 'recompose-run', '--plan-run', 'plan-run', '--open', 'open-compile.json', '--model', 'synthetic-model', '--state', 'pipeline.json'], [])).code, 0);

  const commands: string[] = [], pauses: number[] = [], started: string[] = [];
  let inCommand = false, working = 0, most = 0;
  const execute = async (command: string, options: { timeout?: number; label?: string } = {}) => {
    assert.equal(inCommand, false, 'one pipeline call at a time: its state is one file');
    inCommand = true;
    try {
      commands.push(command);
      const [line, ...rest] = command.split('\n');
      assert.deepEqual(rest, ['%HUB_TOKEN%', '%PLUMB_API_KEY%', 'EOF'], command);
      assert.match(line!, /^node '\/synthetic skills\/case-compile\/tools\/pipeline\.ts' (resume|next) --state 'pipeline\.json' (--finished '(重组|编写|审计) \d\d' |--pause [1-9]\d* )?--hub %HUB_URL% --plumb %PLUMB_URL% <<'EOF'$/);
      assert.ok(options.timeout === 600 && options.label, 'each command names itself and takes the longest time a command may');
      const words = [...line!.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!).slice(2, -1).map((word) => word === '%HUB_URL%' ? 'http://127.0.0.1:9/mcp' : word === '%PLUMB_URL%' ? 'https://127.0.0.1:9' : word);
      const at = words.indexOf('--pause');
      if (at >= 0) {
        const seconds = Number(words[at + 1]); pauses.push(seconds); words.splice(at, 2);
      }
      return await printed(words, ['synthetic-token-1234', 'synthetic-plumb-key']);
    } finally { inCommand = false; }
  };
  const agent = async (description: string, options: { agentType?: string; label?: string; phase?: string }) => {
    const label = options.label!, [kind, k] = label.split(' ') as [string, string];
    assert.equal(options.agentType, kind === '重组' ? 'case-compile:compile-recomposer' : kind === '编写' ? 'case-compile:compile-writer' : 'case-compile:compile-fidelity');
    assert.equal(options.phase, kind);
    assert.match(description, /^派发提示 /);
    started.push(label);
    working++; most = Math.max(most, working);
    await new Promise((done) => setTimeout(done, 2));
    const nth = started.filter((name) => name === label).length;
    if (!ends(label, nth)) { working--; return null; }
    if (writes(label, nth)) {
      if (kind === '重组') await writeFile(join('records', `${k}.json`), '{}');
      else if (kind === '编写') { await mkdir(join('cases', k, 'plan'), { recursive: true }); await writeFile(join('cases', k, 'plan', `${k}.json`), '{}'); }
      else for (const name of readdirSync(join('cases', k, 'audit')).filter((n) => n.endsWith('.brief.json'))) await writeFile(join('cases', k, 'audit', name.replace(/\.brief\.json$/, '.verdict.json')), '{}');
    }
    working--;
    return 'done';
  };
  const logs: string[] = [];
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<unknown>;
  const body = new AsyncFunction('agent', 'execute', 'args', 'log', 'phase', SOURCE.replace(/^export const meta = /, 'const meta = '));
  const given = { pipeline: PIPELINE, state: 'pipeline.json' };
  const result = (await body(agent, execute, given, (line: string) => logs.push(line), () => undefined)) as Record<string, unknown>;
  const state = JSON.parse(await readFile('pipeline.json', 'utf8')) as PipelineState;
  return { result, commands, pauses, started, most, logs, state };
}

test('the script is a workflow a client can run: its meta is a plain literal first, and it reads nothing but its calls', () => {
  assert.ok(SOURCE.startsWith('export const meta = {\n'));
  const literal = SOURCE.slice('export const meta = '.length, SOURCE.indexOf('\n}\n') + 2);
  const meta = new Function(`return ${literal}`)() as { name: string; description: string; phases: Array<{ title: string }> };
  assert.deepEqual([meta.name, meta.phases.map((phase) => phase.title)], ['compile-loop', ['重组', '编写', '审计']]);
  assert.ok(!/\$\{/.test(literal), 'no template in the meta');
  for (const word of [/\bimport\b/, /\brequire\(/, /Date\.now|new Date\(\)/, /Math\.random/, /setTimeout|setInterval/, /process\./]) assert.ok(!word.test(SOURCE.replace(/^\/\/.*$/gm, '')), String(word));
});

test('eight cases go through recomposition and writing six at a time with one pipeline call at a time, and the result is what the lead reads', async () => {
  const { result, commands, started, most, logs } = await bench(8);
  assert.deepEqual([result.all_done, (result.ready as string[]).length, result.stopped, result.queued, result.running], [true, 8, [], 0, []]);
  assert.equal((result as { actions?: unknown }).actions, undefined, 'the tasks are not handed back to the lead');
  assert.match(String(result.message), /^全部 8 条走完流水线：8 条计划就绪。下一步：pipeline\.ts collect 收拢到新目录，再后台跑合并工具 open-merge\.ts（--open 写 open-compile\.json，SKILL\.md 第 3 节）$/);
  assert.deepEqual(logs, [result.message]);
  assert.deepEqual([...started].sort(), [...Array.from({ length: 8 }, (_, n) => `编写 0${n}`), ...Array.from({ length: 8 }, (_, n) => `重组 0${n}`)].sort());
  assert.equal(most, 6);
  assert.match(commands[0]!, / resume --state /);
  assert.equal(commands.length, 17);
  assert.ok(commands.slice(1).every((command) => / next --state 'pipeline\.json' --finished '/.test(command)));
});

test('a subagent that finishes without writing is replaced on the same completion event', async () => {
  const { result, commands, pauses, started } = await bench(2, { writes: (label, start) => !(label === '编写 00' && start === 1) });
  assert.deepEqual([result.all_done, (result.ready as string[]).sort()], [true, ['00', '01']]);
  assert.equal(started.filter((label) => label === '编写 00').length, 2);
  assert.equal(commands.filter((command) => /--finished '编写 00'/.test(command)).length, 2);
  assert.deepEqual(pauses, []);
});

test('a case that uses up its attempts is stopped and the others go on; the result names it for the lead to decide', async () => {
  const { result, started, state } = await bench(3, { gate: (tool, args) => tool === 'check-plan.ts' && args.some((word) => /cases\/01\//.test(word)) ? bad('合成：计划自检没有通过') : undefined });
  assert.deepEqual([result.all_done, (result.ready as string[]).sort()], [true, ['00', '02']]);
  assert.equal(started.filter((label) => label === '编写 01').length, state.max_attempts);
  const stopped = result.stopped as Array<{ label: string; reason: string }>;
  assert.equal(stopped.length, 1);
  assert.match(stopped[0]!.label, /^01 /);
  assert.match(stopped[0]!.reason, new RegExp(`^脚本编写 ${state.max_attempts} 次仍未通过：计划自检没有通过：合成：计划自检没有通过`));
});

test('a subagent whose model failed is started again with the same task after a pause, and its case is charged nothing', async () => {
  const { result, commands, pauses, started, state } = await bench(2, { ends: (label, start) => !(label === '编写 00' && start === 1) });
  assert.deepEqual([result.all_done, (result.ready as string[]).sort(), result.interrupted], [true, ['00', '01'], undefined]);
  assert.equal(started.filter((label) => label === '编写 00').length, 2);
  assert.deepEqual(pauses, [60]);
  assert.equal(commands.filter((command) => /--finished '编写 00'/.test(command)).length, 1);
  assert.deepEqual(state.cases.map((c) => c.attempts.write), [1, 1]);
});

test('when the model service is down the run ends after six subagents in a row did not run, with the state as it was', async () => {
  const { result, commands, pauses, started, state, logs } = await bench(3, { ends: () => false });
  assert.match(String(result.interrupted), /^子代理连续 6 次没有跑成（模型服务出错，或被停下）：流水线状态没有动，没有一条用例为此耗次数；服务恢复后照第 0 节再启动一次循环$/);
  assert.deepEqual(logs, [result.interrupted]);
  assert.equal(result.all_done, false);
  assert.deepEqual(pauses, [60, 120, 180, 240, 300]);
  assert.ok(started.length >= 6 && started.every((label) => label.startsWith('重组 ')));
  assert.ok(commands.every((command) => / resume --state /.test(command)));
  assert.deepEqual(state.cases.map((c) => [c.stage, c.attempts.recompose]), [['recomposing', 1], ['recomposing', 1], ['recomposing', 1]]);
  assert.ok(state.cases.every((c) => c.action?.label === `重组 ${c.k}`));
});

test('when only a gate that waits for a service is left the script looks again after a pause, and ends when the service is back', async () => {
  let refusals = 0;
  const { result, pauses, commands, started } = await bench(1, { gate: (tool) => tool === 'cmd-verify-plumb.ts' && refusals++ < 4 ? bad('暂时不可用：Plumb 网关拒绝（503 backend_down）') : undefined });
  assert.deepEqual([result.all_done, result.ready, result.waiting], [true, ['00'], undefined]);
  assert.deepEqual(pauses, [60, 60]);
  assert.equal(commands.filter((command) => / resume --state 'pipeline\.json' --pause 60 /.test(command)).length, 2);
  assert.deepEqual(started, ['重组 00', '编写 00']);
});

test('a pipeline answer whose last line is not whole JSON ends the script with the tail of the output', async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<unknown>;
  const body = new AsyncFunction('agent', 'execute', 'args', 'log', 'phase', SOURCE.replace(/^export const meta = /, 'const meta = '));
  const never = () => { throw new Error('nothing is to run'); };
  const execute = async () => ({ code: 0, output: '合成输出\n{"actions":[' });
  await assert.rejects(body(never, execute, { pipeline: PIPELINE, state: 'pipeline.json' }, never, never), /pipeline\.ts resume 没有完成（退出码 0）：合成输出\n\{"actions":\[/);
});

test('a path the command line cannot carry is refused before anything runs', async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<unknown>;
  const body = new AsyncFunction('agent', 'execute', 'args', 'log', 'phase', SOURCE.replace(/^export const meta = /, 'const meta = '));
  const never = () => { throw new Error('nothing is to run'); };
  await assert.rejects(body(never, never, { pipeline: "/it's/pipeline.ts" }, never, never), /args\.pipeline 要写成不含单引号、反斜杠和换行的路径/);
  await assert.rejects(body(never, never, undefined, never, never), /args\.pipeline 要写成/);
  await assert.rejects(body(never, never, 'not json at all', never, never), /args\.pipeline 要写成/);
  assert.ok(!existsSync('never-written'));
});
