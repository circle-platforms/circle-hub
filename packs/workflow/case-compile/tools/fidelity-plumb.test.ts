import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { localFidelityBlocks } from './submit-plans.ts';
import { main as applyMain } from './fidelity-apply.ts';
import { FakeCallError, JEV_WIRE_KEY, JEV_WIRE_VERSION, filesBelow, jevFake, jevWire, sha256Text, textForms, validAnswer } from '../testing/jev-fake.ts';
import { JEV_ENDPOINT } from '../functions/generated/skills/jev-judge/jev-client/index.ts';
import { FIDELITY_CRITERIA, fidelityInstructions } from '../functions/jev-judge.ts';
import { runFidelityPlumb } from './fidelity-plumb.ts';

let mode: 'pass' | 'review' | 'reject' | 'service_down' = 'pass';
let postCount = 0;
const seenStates: string[] = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/v1/judge') {
      postCount += 1;
      if (mode === 'service_down') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'backend_down', message: '后端尚未就绪' }, retryable: false }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { questions?: Record<string, { state?: string }> };
      const answers: Record<string, unknown> = {};
      for (const [qid, q] of Object.entries(body.questions ?? {})) {
        seenStates.push(q.state ?? '');
        const choice = mode === 'reject' ? '保持' : '保持';
        const action = mode;
        answers[qid] = {
          status: '未确认',
          decided_by: '模型',
          model_version: 'plumb-27b-0.5.0',
          answer: {
            type: 'choice',
            value: choice,
            confidence: action === 'pass' ? 0.94 : action === 'review' ? 0.61 : 0.2,
            probabilities: { 保持: 0.94, 改变: 0.04, 未实现: 0.02 },
          },
          gate: { action, calibrated: true, calibration_source: 'benchmark-synth' },
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: '未确认',
        decided_by: '模型',
        model_version: 'plumb-27b-0.5.0',
        task: 'sequence',
        request_id: `req-${postCount}`,
        answers,
      }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function setupWorkspace(caseCount = 1) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-fidelity-plumb-'));
  const plans = join(dir, 'plans'), briefs = join(dir, 'briefs');
  await mkdir(plans);
  const runItems: unknown[] = [];
  for (let i = 0; i < caseCount; i += 1) {
    const id = `doc:c-${i}`;
    runItems.push({
      id,
      fields: {
        autoid: `C${i}`,
        title: `用例 ${i}`,
        recomposition: {
          record: {
            schema: 'recompose-record@1',
            contract: { intent: { text: `意图 ${i}` } },
            atoms: [
              { id: '1', kind: 'action', text: '配置接口 eth0 地址 192.0.2.10/24' },
              { id: '2', kind: 'action', text: '启用接口 eth0' },
            ],
            ledgers: { original: [], adapted: [], rebindings: [] },
          },
        },
      },
    });
    await writeFile(join(plans, `${String(i).padStart(2, '0')}.json`), JSON.stringify({
      item: id,
      handling: 'handled',
      slots: {
        plan: [{
          text: `plan ${i}`,
          quotes: [],
          data: {
            bucket: 'bed-1',
            blocks: [],
            steps: [
              { object: 'dut1', method: 'cmd_config', args: ['ip address 192.0.2.10/24'], keywords: {}, author_step_refs: ['1'] },
              { object: 'dut1', method: 'cmd_config', args: ['no shutdown'], keywords: {}, author_step_refs: ['2'] },
            ],
            expects: [],
            replacements: [],
          },
        }],
      },
    }));
  }
  await writeFile(join(plans, 'skip.json'), JSON.stringify({ item: 'doc:skip', handling: 'skipped', reason: '暂不适用' }));
  runItems.push({ id: 'doc:skip', fields: { autoid: 'CSKIP', title: '跳过用例' } });
  const runPath = join(dir, 'run.json');
  await writeFile(runPath, JSON.stringify({ run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', items: runItems }));
  return { dir, runPath, plans, briefs };
}

test('fidelity-plumb evaluates batch <=32 chunks, writes .verdict.json, and merges through fidelity-apply & localFidelityBlocks', async () => {
  const w = await setupWorkspace(18);
  try {
    mode = 'pass';
    postCount = 0;
    const summaryPath = join(w.dir, 'summary.json');
    const res = await runFidelityPlumb(
      ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin', '--out', summaryPath],
      { stdinText: 'plumb_sk_test_123456\n' },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(postCount, 2, '36 author steps across 18 cases must split into 2 <=32 batches');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.status, '未确认');
    assert.equal(summary.decided_by, '模型');
    assert.equal(summary.written.length, 18);
    assert.equal(summary.skipped.length, 1);

    postCount = 0;
    const second = await runFidelityPlumb(
      ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'],
      { stdinText: 'plumb_sk_test_123456\n' },
    );
    assert.equal(second.code, 0, second.stderr);
    assert.equal(postCount, 0);
    assert.equal(JSON.parse(second.stdout).reused.length, 18);

    const oldWrite = process.stdout.write.bind(process.stdout);
    const applyChunks: string[] = [];
    process.stdout.write = ((c: string | Uint8Array) => { applyChunks.push(String(c)); return true; }) as typeof process.stdout.write;
    try {
      const code = await applyMain(['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs]);
      assert.equal(code, 0);
    } finally {
      process.stdout.write = oldWrite;
    }
    const applyJson = JSON.parse(applyChunks.join(''));
    assert.equal(applyJson.ready, true);
    assert.equal(applyJson.merged.length, 18);

    const run = JSON.parse(await readFile(w.runPath, 'utf8'));
    const held = new Map<string, { label: string; recomposition: unknown }>(
      run.items.map((it: { id: string; fields: { autoid?: string; title?: string; recomposition?: { record?: unknown } } }) => [
        it.id,
        { label: `${it.fields.autoid ?? ''} ${it.fields.title ?? ''}`.trim(), recomposition: it.fields.recomposition?.record },
      ]),
    );
    const p0 = JSON.parse(await readFile(join(w.plans, '00.json'), 'utf8'));
    assert.deepEqual(localFidelityBlocks([p0], held), []);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('fidelity-plumb takes the run directory as --run like task-brief.ts and refuses its run.json file with the one-line correct form before any call', async () => {
  const w = await setupWorkspace(1);
  try {
    mode = 'pass';
    postCount = 0;
    const refused = await runFidelityPlumb(
      ['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'],
      { stdinText: 'plumb_sk_test_123456\n' },
    );
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.ok(refused.stderr.startsWith(`参数无效：--run ${w.runPath} 不是普通目录。`), refused.stderr);
    assert.ok(refused.stderr.trimEnd().endsWith("合法写法：--run '<运行目录>'（放 run.json 的目录，不是 run.json 文件）。"), refused.stderr);
    assert.equal(refused.stderr.trim().split('\n').length, 1);
    assert.equal(postCount, 0, 'no question was asked of Plumb');
    await assert.rejects(readdir(w.briefs), { code: 'ENOENT' }, 'no brief directory was made');
    const answered = await runFidelityPlumb(
      ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'],
      { stdinText: 'plumb_sk_test_123456\n' },
    );
    assert.equal(answered.code, 0, answered.stderr);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('fidelity-plumb honors Option A1 review/reject/strict-review and fails closed on 503', async () => {
  const w = await setupWorkspace(1);
  try {
    mode = 'service_down';
    const failRes = await runFidelityPlumb(
      ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_env_key' } },
    );
    assert.equal(failRes.code, 1);
    assert.match(failRes.stderr, /^暂时不可用：/);

    mode = 'review';
    const revRes = await runFidelityPlumb(
      ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_env_key' } },
    );
    assert.equal(revRes.code, 0, revRes.stderr);
    const revJson = JSON.parse(revRes.stdout);
    assert.equal(revJson.written[0].preserved, 2);
    assert.deepEqual(revJson.written[0].review_required, ['1', '2']);
    const verdictContent = JSON.parse(await readFile(revJson.written[0].verdict, 'utf8'));
    assert.match(verdictContent.disclosure, /\[需人工复核：Plumb sequence 落入 review 区\]/);

    const strictBriefs = join(w.dir, 'briefs-strict');
    const strictRes = await runFidelityPlumb(
      ['--run', w.dir, '--plans', w.plans, '--briefs', strictBriefs, '--base-url', baseUrl, '--no-cache', '--strict-review'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_env_key' } },
    );
    assert.equal(strictRes.code, 0, strictRes.stderr);
    assert.equal(JSON.parse(strictRes.stdout).written[0].changed, 2);

    mode = 'reject';
    const rejectBriefs = join(w.dir, 'briefs-reject');
    const rejRes = await runFidelityPlumb(
      ['--run', w.dir, '--plans', w.plans, '--briefs', rejectBriefs, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_env_key' } },
    );
    assert.equal(rejRes.code, 0, rejRes.stderr);
    assert.equal(JSON.parse(rejRes.stdout).written[0].changed, 2);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('fidelity-plumb refuses old prompt verdicts before reuse or service calls',async()=>{
 const w=await setupWorkspace(1);try{
  mode='pass';const args=['--run',w.dir,'--plans',w.plans,'--briefs',w.briefs,'--base-url',baseUrl,'--no-cache','--key-stdin'];
  const first=await runFidelityPlumb(args,{stdinText:'plumb_sk_test_123456\n'});assert.equal(first.code,0,first.stderr);
  const summary=JSON.parse(first.stdout),path=summary.written[0].verdict;
  const doc=JSON.parse(await readFile(path,'utf8'));doc.model_disclosure.prompt_version='sequence@product-2400';await writeFile(path,JSON.stringify(doc));
  postCount=0;const second=await runFidelityPlumb(args,{stdinText:'plumb_sk_test_123456\n'});assert.equal(second.code,1);assert.match(second.stderr,/不能复用旧题目/);assert.equal(postCount,0);
 }finally{await rm(w.dir,{recursive:true,force:true});}
});

const LONG_NAME = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');

async function addCase(w: { runPath: string; plans: string }, base: string, commands: string[]): Promise<string> {
  const run = JSON.parse(await readFile(w.runPath, 'utf8'));
  const id = `doc:${base}`;
  run.items.push({
    id,
    fields: {
      autoid: base,
      title: `用例 ${base}`,
      recomposition: {
        record: {
          schema: 'recompose-record@1',
          contract: { intent: { text: '验证超长名字可配置并可查询' } },
          atoms: [
            { id: '1', kind: 'action', text: '配置超长名字' },
            { id: '2', kind: 'action', text: '启用签名功能' },
            { id: '3', kind: 'action', text: '客户端带验证查询' },
          ],
          ledgers: { original: [], adapted: [], rebindings: [] },
          sources: { states: [{ atom: '2', state: 'missing_prerequisite', prerequisites: ['feature on（手册原话：该功能默认是禁用的）', 'widget signing on 启用签名功能'], reason: '功能默认禁用，签名功能须单独开启' }] },
        },
      },
    },
  });
  await writeFile(w.runPath, JSON.stringify(run));
  const steps = commands.map((cmd, i) => ({ object: 'dut1', method: 'cmd_config', args: [cmd], keywords: {}, author_step_refs: [String((i % 3) + 1)] }));
  await writeFile(join(w.plans, `${base}.json`), JSON.stringify({ item: id, handling: 'handled', slots: { plan: [{ text: `plan ${base}`, quotes: [], data: { bucket: 'bed-1', blocks: [], steps, expects: [], replacements: [] } }] } }));
  return id;
}
const BIG_ARGS = ['cmd ' + 'longtoken '.repeat(900)];
const keyed = { stdinText: 'plumb_sk_test_123456\n' };

test('fidelity-plumb judges the cases that fit, names the cases that do not and sends them to blind review', async () => {
  const w = await setupWorkspace(1);
  try {
    await addCase(w, 'big', BIG_ARGS);
    mode = 'pass';
    postCount = 0;
    seenStates.length = 0;
    const args = ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'];
    const res = await runFidelityPlumb(args, keyed);

    assert.equal(res.code, 1);
    assert.equal(postCount, 1, 'the case that fits is judged, in one request');
    const summary = JSON.parse(res.stdout);
    assert.equal(summary.written.length, 1);
    assert.equal(summary.over_budget.length, 1);
    const over = summary.over_budget[0];
    assert.equal(over.file, 'big.json');
    assert.equal(over.verdict_present, false);
    assert.ok(over.steps.every((st: { est_tokens: number }) => st.est_tokens > 2400));
    assert.ok(over.steps.every((st: { command_blocks: number; exemptions: number }) => st.command_blocks > st.exemptions));
    assert.ok(await readFile(over.brief, 'utf8').then(() => true), 'the brief the blind review needs is written');
    await assert.rejects(readFile(over.verdict, 'utf8'), /ENOENT/);

    assert.match(res.stderr, /^参数无效：1 条自动化用例的保真核对题面超过 Plumb 的 2400 token 上限/u);
    assert.ok(res.stderr.includes('big.json'));
    assert.ok(res.stderr.includes(over.brief));
    assert.match(res.stderr, /候选命令块约 \d+、豁免依据约 \d+/u);
    assert.match(res.stderr, /其余 1 条已由 Plumb 核对/u);
    assert.match(res.stderr, /task-brief\.ts.*--role '保真核对'.*--case.*--brief.*--out.*--task-file/u);
    assert.match(res.stderr, /不要对整个核对目录用 --batch/u);
    assert.match(res.stderr, /fidelity-apply\.ts/u);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('fidelity-plumb accepts the blind review verdict that is already there and does not stop again', async () => {
  const w = await setupWorkspace(1);
  try {
    await addCase(w, 'big', BIG_ARGS);
    mode = 'pass';
    const args = ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'];
    const first = await runFidelityPlumb(args, keyed);
    assert.equal(first.code, 1);
    const { verdict } = JSON.parse(first.stdout).over_budget[0] as { verdict: string };
    await writeFile(verdict, JSON.stringify({ steps: [], disclosure: '独立模型盲审的判断' }));

    postCount = 0;
    const second = await runFidelityPlumb(args, keyed);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(postCount, 0, 'the verdict Plumb gave is reused and the blind one is left alone');
    const summary = JSON.parse(second.stdout);
    assert.equal(summary.reused.length, 1);
    assert.equal(summary.over_budget.length, 1);
    assert.equal(summary.over_budget[0].verdict_present, true);
    assert.equal(JSON.parse(await readFile(verdict, 'utf8')).disclosure, '独立模型盲审的判断');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('fidelity-plumb asks Plumb about a case whose long repeated name is the reason it was too big, and discloses the replacement', async () => {
  const w = await setupWorkspace(0);
  try {
    const commands = Array.from({ length: 48 }, (_, i) => (i % 3 === 0 ? `zone host name "${LONG_NAME}" 60` : `zone feature ${i} on`));
    await addCase(w, 'dns', commands);
    mode = 'pass';
    postCount = 0;
    seenStates.length = 0;
    const res = await runFidelityPlumb(['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'], keyed);

    assert.equal(res.code, 0, res.stderr);
    assert.equal(postCount, 1);
    assert.equal(seenStates.length, 3, 'one question for each authored action');
    for (const state of seenStates) {
      assert.equal(state.split(LONG_NAME).length - 1, 1, 'the name is written once, in the table');
      assert.match(state, /\[长字面量对照\]\n[^\n]+\n«L1» = a{63}\.b{63}\.c{63}\.d{61}（共 253 个字符；各段 63、63、63、61）/u);
      assert.ok(state.split('«L1»').length - 1 >= 16);
    }
    const summary = JSON.parse(res.stdout);
    assert.deepEqual(summary.over_budget, []);
    assert.equal(summary.written.length, 1);
    assert.deepEqual(summary.written[0].literal_substitutions.map((s: { step: string; name: string; length: number; occurrences: number }) => [s.step, s.name, s.length, s.occurrences]), [['1', '«L1»', 253, 16], ['2', '«L1»', 253, 16], ['3', '«L1»', 253, 16]]);
    const verdict = JSON.parse(await readFile(summary.written[0].verdict, 'utf8'));
    assert.match(verdict.disclosure, /长字面量换名：步骤 1 的 «L1»（253 个字符，出现 16 次，SHA-256 前 12 位 [0-9a-f]{12}）；步骤 2 的/u);
    assert.match(verdict.disclosure, /自动化用例和简报里的原文没有改/u);
    assert.equal(verdict.model_disclosure.prompt_version, 'sequence@product-2400-exemptions-v2');

    postCount = 0;
    const again = await runFidelityPlumb(['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'], keyed);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(postCount, 0);
    assert.equal(JSON.parse(again.stdout).reused.length, 1);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

// ---- Jev as the judge: pipeline.ts runs the tool with --judge jev when the user chose Jev for this compile ----

const JEV_IN = { stdinText: 'jev_sk_synthetic_1\n' };
const jevArgs = (w: { dir: string; plans: string; briefs: string }, extra: string[] = []) => ['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--judge', 'jev', '--key-stdin', ...extra];
const verdictsIn = async (dir: string) => (await readdir(dir)).filter((name) => name.endsWith('.verdict.json')).sort();

test('--judge jev: one choice request per author step, every verdict held for the blind audit, named as Jev\'s in the file, and not reused by another judge', async () => {
  const w = await setupWorkspace(2);
  try {
    const f = jevFake(() => ({ type: 'choice', choice: 'preserved', confidence: 0.99, probabilities: { preserved: 0.9, changed: 0.07, unrealized: 0.03 } }));
    postCount = 0;
    const res = await runFidelityPlumb(jevArgs(w), { ...JEV_IN, jev: f.factory });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(postCount, 0, 'no question reaches the Plumb gateway');
    assert.equal(f.requests.length, 4, 'one request per author step: 2 cases of 2 steps');
    assert.deepEqual(f.configs, [{ apiKey: 'jev_sk_synthetic_1', auditPath: join(w.briefs, 'jev-audit.jsonl') }], 'the request log lands beside the briefs');
    assert.deepEqual(f.requests.map((r) => r.model), ['jev-latest', 'jev-1.13.0', 'jev-1.13.0', 'jev-1.13.0']);
    assert.match(f.requests[0]!.questions.q1!.instructions, /^Do the blocks realize author step 1's scenario as the author wrote it\?/);
    assert.match(f.requests[1]!.questions.q1!.instructions, /^Do the blocks realize author step 2's scenario/);
    assert.match(String(f.requests[0]!.state), /\[用例意图\]\n意图 0\n\n\[当前作者步骤 1\]/);
    const summary = JSON.parse(res.stdout);
    assert.deepEqual([summary.judge, summary.status, summary.decided_by, summary.model_version, summary.strict_review, summary.jev_requests], ['jev', '未确认', '模型', 'jev-1.13.0', true, 4]);
    assert.equal(summary.written.length, 2);
    const names = await verdictsIn(w.briefs);
    assert.equal(names.length, 2);
    const doc = JSON.parse(await readFile(join(w.briefs, names[0]!), 'utf8'));
    assert.deepEqual(doc.steps.map((s: { n: string; verdict: string }) => [s.n, s.verdict]), [['1', 'changed'], ['2', 'changed']], 'what Jev found preserved is still not released: the review gate holds every step');
    for (const row of doc.steps) {
      assert.deepEqual(row.model_judgment.gate, { action: 'review', reason: 'source=uncalibrated' });
      assert.deepEqual([row.model_judgment.status, row.model_judgment.decided_by, row.model_judgment.model_version, row.model_judgment.choice, row.model_judgment.confidence], ['未确认', '模型', 'jev-1.13.0', '保持', 0.9]);
      assert.match(row.rationale, /^Jev\(jev-1\.13\.0\) sequence=保持（conf=0\.900, gate=review/);
    }
    assert.deepEqual([doc.model_disclosure.prompt_version, doc.model_disclosure.review_required_steps], ['jev-choice@fidelity-v1', ['1', '2']]);
    assert.match(doc.disclosure, /依据 Jev\(jev-1\.13\.0\) 判断（状态未确认，决定者模型）；Jev 的回答一律只作参考，不自动放行，逐条交独立盲审/);
    assert.doesNotMatch(doc.disclosure, /Plumb/);

    // fidelity-apply does not merge them as satisfied: the case waits for the blind audit, as a verdict in Plumb's review zone does.
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
    try { assert.equal(await applyMain(['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs]), 0); } finally { process.stdout.write = write; }
    const applied = JSON.parse(chunks.join(''));
    assert.equal(applied.ready, false);
    assert.equal(applied.attention.length, 4, 'two changed steps in each of the two cases');

    // The same Jev briefs directory is read again without a request; Plumb will not take a verdict Jev wrote.
    const again = await runFidelityPlumb(jevArgs(w), { ...JEV_IN, jev: f.factory });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).reused.length, 2);
    assert.equal(f.requests.length, 4);
    const plumb = await runFidelityPlumb(['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_test_123456\n' });
    assert.equal(plumb.code, 1);
    assert.match(plumb.stderr, /不能复用旧题目/);
    assert.equal(postCount, 0);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: a verdict that Plumb wrote is not reused, and what Jev finds changed or unrealized is kept as the verdict it is', async () => {
  const w = await setupWorkspace(1);
  try {
    mode = 'pass';
    postCount = 0;
    const first = await runFidelityPlumb(['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'], { stdinText: 'plumb_sk_test_123456\n' });
    assert.equal(first.code, 0, first.stderr);
    const idle = jevFake(() => ({ type: 'noul', noul: 0.5 }));
    const refused = await runFidelityPlumb(jevArgs(w), { ...JEV_IN, jev: idle.factory });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^参数无效：已有判断不是 Jev 按本版题目写的（判断方式或题目版本不同）/);
    assert.equal(idle.requests.length, 0);
    const other = await setupWorkspace(1);
    try {
      const f = jevFake((request) => ({ type: 'choice', choice: String(request.state).includes('[当前作者步骤 1]') ? 'unrealized' : 'changed', confidence: 0.5, probabilities: { preserved: 0.1, changed: 0.5, unrealized: 0.4 } }));
      const res = await runFidelityPlumb(jevArgs(other), { ...JEV_IN, jev: f.factory });
      assert.equal(res.code, 0, res.stderr);
      const doc = JSON.parse(await readFile(join(other.briefs, (await verdictsIn(other.briefs))[0]!), 'utf8'));
      assert.deepEqual(doc.steps.map((s: { verdict: string }) => s.verdict), ['unrealized', 'changed']);
      assert.deepEqual(doc.steps.map((s: { model_judgment: { confidence: number } }) => s.model_judgment.confidence), [0.4, 0.5], 'p is the probability of the verdict Jev chose');
    } finally {
      await rm(other.dir, { recursive: true, force: true });
    }
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev: an outage writes no verdict and ends under the word the pipeline waits on, a refused key says what to do, and a placeholder or a missing --key-stdin is refused before any request', async () => {
  const w = await setupWorkspace(1);
  try {
    const down = await runFidelityPlumb(jevArgs(w), { ...JEV_IN, jev: jevFake(() => new FakeCallError('暂时不可用', 503, 'unavailable')).factory });
    assert.equal(down.code, 1);
    assert.match(down.stderr, /^暂时不可用：Jev 暂时不可用（HTTP 503，unavailable）/);
    assert.deepEqual(await verdictsIn(w.briefs), [], 'no verdict is written when the audit is not whole');
    const denied = await runFidelityPlumb(jevArgs(w), { ...JEV_IN, jev: jevFake(() => new FakeCallError('无权限', 403, 'forbidden')).factory });
    assert.match(denied.stderr, /^无权限：Jev 拒绝了密钥（HTTP 403，forbidden）.*JEV_API_KEY/);
    const idle = jevFake(() => ({ type: 'noul', noul: 0.5 }));
    const placeholder = await runFidelityPlumb(jevArgs(w), { stdinText: '%JEV_API_KEY%\n', jev: idle.factory });
    assert.match(placeholder.stderr, /^无权限：Jev 密钥没有展开/);
    const noFlag = await runFidelityPlumb(['--run', w.dir, '--plans', w.plans, '--briefs', w.briefs, '--judge', 'jev'], { ...JEV_IN, jev: idle.factory });
    assert.match(noFlag.stderr, /^无权限：Jev 密钥只从标准输入第一行读入/);
    assert.equal(idle.requests.length, 0);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});


// ---- the real embedded client of the jev-judge skill runs; only the network under it is replaced ----

test('--judge jev with the real embedded client: the requests that leave carry the mapped question and state, the answers come back as unconfirmed review advice held for the blind audit, and neither the key nor the state text is written anywhere', async () => {
  const w = await setupWorkspace(2);
  try {
    const wire = jevWire();
    const summaryPath = join(w.dir, 'fidelity', 'summary.json');
    const before = new Set(await filesBelow(w.dir));
    const res = await runFidelityPlumb([...jevArgs(w), '--out', summaryPath], { stdinText: `${JEV_WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stderr, '');

    // What left: one request per author step (2 cases of 2 steps), to the module's fixed address, the key only in the header.
    assert.equal(wire.calls.length, 4);
    for (const call of wire.calls) {
      assert.equal(call.url, JEV_ENDPOINT);
      assert.equal(call.authorization, `Bearer ${JEV_WIRE_KEY}`);
      assert.equal(call.contentType, 'application/json');
      assert.equal(call.timeoutMs, 60_000, 'a request may take a minute on the pipeline path');
      assert.deepEqual(Object.keys(call.sent), ['state', 'model', 'questions']);
      assert.deepEqual(Object.keys(call.sent.questions), ['q1']);
      const question = call.sent.questions.q1!;
      assert.equal(question.type, 'choice');
      assert.deepEqual(question.criteria, FIDELITY_CRITERIA);
      assert.deepEqual(Object.keys(question.criteria), ['preserved', 'changed', 'unrealized'], 'the options keep the order that is part of the question');
      assert.ok(!call.text.includes(JEV_WIRE_KEY), 'the key is not in the body');
    }
    assert.deepEqual(wire.calls.map((call) => call.sent.model), ['jev-latest', JEV_WIRE_VERSION, JEV_WIRE_VERSION, JEV_WIRE_VERSION], 'the first request is alone and names the exact version the others ask for');
    // The questions and states are those of the two cases and their two author steps each, whatever order the later requests left in.
    const asked = wire.calls.map((call) => {
      const state = String(call.sent.state);
      const step = /^\[用例意图\]\n意图 (\d)\n\n(?:\[前序步骤\]\n1\. 配置接口 eth0 地址 192\.0\.2\.10\/24\n\n)?\[当前作者步骤 (\d)\]\n/.exec(state);
      assert.ok(step, state.slice(0, 80));
      assert.equal(call.sent.questions.q1!.instructions, fidelityInstructions(step![2]!));
      assert.match(state, /\n\n\[候选命令块\]\nblock\[1\] \(cmd_config, host=dut1\)\n  ip address 192\.0\.2\.10\/24\nblock\[2\] \(cmd_config, host=dut1\)\n  no shutdown\n\n\[前置豁免规则\]\n/);
      return `${step![1]}.${step![2]}`;
    }).sort();
    assert.deepEqual(asked, ['0.1', '0.2', '1.1', '1.2']);

    // What came back: advice only, with the disclosure; what Jev found preserved is still held for the blind audit.
    const summary = JSON.parse(res.stdout);
    assert.deepEqual([summary.judge, summary.status, summary.decided_by, summary.model_version, summary.strict_review, summary.jev_requests], ['jev', '未确认', '模型', JEV_WIRE_VERSION, true, 4]);
    assert.equal(await readFile(summaryPath, 'utf8'), res.stdout, 'the summary file is what the tool printed');
    const names = (await readdir(w.briefs)).filter((name) => name.endsWith('.verdict.json')).sort();
    assert.equal(names.length, 2);
    for (const name of names) {
      const doc = JSON.parse(await readFile(join(w.briefs, name), 'utf8'));
      assert.deepEqual(doc.steps.map((s: { n: string; verdict: string }) => [s.n, s.verdict]), [['1', 'changed'], ['2', 'changed']]);
      for (const row of doc.steps) {
        assert.deepEqual(row.model_judgment.gate, { action: 'review', reason: 'source=uncalibrated' });
        assert.deepEqual([row.model_judgment.status, row.model_judgment.decided_by, row.model_judgment.model_version, row.model_judgment.choice, row.model_judgment.confidence], ['未确认', '模型', JEV_WIRE_VERSION, '保持', 0.7]);
      }
      assert.deepEqual([doc.model_disclosure.prompt_version, doc.model_disclosure.review_required_steps], ['jev-choice@fidelity-v1', ['1', '2']]);
    }

    // The request log has one line per request: sizes, digest, status and usage, no content, owner-only.
    const auditFile = join(w.briefs, 'jev-audit.jsonl');
    const lines = (await readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 4);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line), ['ts', 'endpoint_host', 'questions', 'question_types', 'body_bytes', 'body_sha256', 'attempt', 'http_status', 'model', 'usage', 'duration_ms', 'error_code']);
      assert.deepEqual([line.endpoint_host, line.questions, line.question_types, line.attempt, line.http_status, line.model, line.usage, line.error_code], ['api.typesafe.ai', 1, ['choice'], 1, 200, JEV_WIRE_VERSION, { input_tokens: 120, output_tokens: 30 }, null]);
    }
    assert.deepEqual(lines.map((line) => line.body_sha256).sort(), wire.calls.map((call) => sha256Text(call.text)).sort());
    assert.equal((await stat(auditFile)).mode & 0o777, 0o600);

    // Neither the key nor the text of any state is in a file the run wrote, in what it printed, or in the request log.
    const written = (await filesBelow(w.dir)).filter((file) => !before.has(file));
    assert.deepEqual(written.map((file) => relative(w.dir, file).replace(/\.[0-9a-f]{8}\./, '.')), ['briefs/00.brief.json', 'briefs/00.verdict.json', 'briefs/01.brief.json', 'briefs/01.verdict.json', 'briefs/jev-audit.answers.jsonl', 'briefs/jev-audit.jsonl', 'fidelity/summary.json'], 'the answers are kept beside the request log, for the next pass');
    const kept = (await readFile(join(w.briefs, 'jev-audit.answers.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { model_version: string; answer: { type: string; choice: string } });
    assert.equal(kept.length, 4);
    assert.deepEqual([...new Set(kept.map((line) => [line.model_version, line.answer.type, line.answer.choice].join()))], [`${JEV_WIRE_VERSION},choice,preserved`]);
    const seen = [...(await Promise.all(written.map((file) => readFile(file, 'utf8')))), res.stdout, res.stderr];
    for (const text of seen) {
      assert.ok(!text.includes(JEV_WIRE_KEY));
      for (const call of wire.calls) for (const form of [...textForms(String(call.sent.state)), call.text]) assert.ok(!text.includes(form), 'the state text stays out of what the run leaves behind');
    }
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev with the real embedded client: a step the service rejects has no Jev opinion: its case gets no verdict from the tool and goes to the blind audit, the summary says which step and why, and the other case is judged as always', async () => {
  const w = await setupWorkspace(2);
  try {
    // The service rejects the question of author step 2 of the first case; its answer echoes the request body, which the client never shows.
    const wire = jevWire((question, call) => (String(call.sent.state).includes('[用例意图]\n意图 0\n') && String(call.sent.state).includes('[当前作者步骤 2]') ? { status: 422, body: JSON.stringify({ detail: call.text }) } : validAnswer(question)));
    const res = await runFidelityPlumb(jevArgs(w), { stdinText: `${JEV_WIRE_KEY}\n`, jevTransport: wire.transport });
    assert.equal(res.code, 0, res.stderr);
    const summary = JSON.parse(res.stdout);
    assert.deepEqual(summary.jev_no_opinion.map((row: { item: string; steps: unknown }) => [row.item, row.steps]), [['doc:c-0', [{ n: '2', code: 'request_rejected', reason: 'Jev 服务拒绝了这个请求（HTTP 422，request_rejected）' }]]]);
    assert.equal(summary.written.length, 1, 'the other case was judged');
    const names = await readdir(w.briefs);
    const verdicts = names.filter((name) => name.endsWith('.verdict.json')), briefs = names.filter((name) => name.endsWith('.brief.json'));
    assert.deepEqual([verdicts.length, briefs.length], [1, 2], 'the case with a step that has no Jev opinion keeps its brief and has no verdict: the blind audit writes it');
    assert.ok(verdicts[0]!.startsWith('01.'), 'the verdict is the answered case\'s');
    // The rejected request is shown nowhere, and what Jev did answer is kept for the next pass.
    const state = String(wire.calls.find((call) => String(call.sent.state).includes('意图 0') && String(call.sent.state).includes('[当前作者步骤 2]'))!.sent.state);
    for (const file of await filesBelow(w.dir)) { const text = await readFile(file, 'utf8'); assert.ok(!text.includes(JEV_WIRE_KEY), file); if (file.includes('jev-audit')) assert.ok(!textForms(state).some((form) => text.includes(form)), file); }
    assert.equal((await readFile(join(w.briefs, 'jev-audit.answers.jsonl'), 'utf8')).trim().split('\n').length, 3, 'three of the four questions were answered');
    // The next pass asks the question that has no answer, and no other.
    const next = jevWire((question) => validAnswer(question));
    const again = await runFidelityPlumb(jevArgs(w), { stdinText: `${JEV_WIRE_KEY}\n`, jevTransport: next.transport });
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual([next.calls.length, JSON.parse(again.stdout).jev_requests, JSON.parse(again.stdout).written.length], [1, 1, 1]);
    assert.equal((await readdir(w.briefs)).filter((name) => name.endsWith('.verdict.json')).length, 2, 'now the case is complete and its verdict is written');
    assert.equal(JSON.parse(await readFile(join(w.briefs, (await readdir(w.briefs)).filter((name) => name.endsWith('.verdict.json')).sort()[0]!), 'utf8')).model_disclosure.model_version, JEV_WIRE_VERSION, 'the version of the first pass is the one asked for again');
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});

test('--judge jev with the real embedded client: what the service refuses, echoes or drops ends the tool under the right word with no verdict written, and no error text carries the key or the state', async () => {
  const w = await setupWorkspace(1);
  try {
    const cases: Array<{ name: string; script: Parameters<typeof jevWire>[0]; head: RegExp; code: string }> = [
      { name: 'key refused', script: () => ({ status: 403, body: JSON.stringify({ detail: 'Forbidden' }) }), head: /^无权限：Jev 拒绝了密钥（HTTP 403，forbidden）.*JEV_API_KEY/s, code: 'forbidden' },
      { name: 'service error echoing the key', script: () => ({ status: 502, body: `upstream said Bearer ${JEV_WIRE_KEY}` }), head: /^暂时不可用：Jev 暂时不可用（HTTP 502，invalid_response）：Jev 的应答里出现了 API 密钥/, code: 'invalid_response' },
      { name: 'connection lost with the key in its message', script: () => Object.assign(new Error(`socket hang up ${JEV_WIRE_KEY}`), { code: 'ECONNRESET' }), head: /^暂时不可用：Jev 暂时不可用（connection_lost）/, code: 'connection_lost' },
      { name: 'answer of another shape', script: () => ({ type: 'noul', noul: 0.5 }), head: /^暂时不可用：Jev 暂时不可用（HTTP 200，invalid_response）：题目 q1 的回答类型不是 choice/, code: 'invalid_response' },
    ];
    for (const [index, failing] of cases.entries()) {
      const wire = jevWire(failing.script);
      const audit = join(w.dir, `audit-${index}.jsonl`);
      const res = await runFidelityPlumb(jevArgs(w, ['--audit-out', audit]), { stdinText: `${JEV_WIRE_KEY}\n`, jevTransport: wire.transport });
      assert.equal(res.code, 1, failing.name);
      assert.equal(res.stdout, '', `${failing.name}: no summary is written when Jev did not answer`);
      assert.match(res.stderr, failing.head, failing.name);
      assert.equal(wire.calls.length, 1, `${failing.name}: the first failure stops the others and nothing is sent again`);
      assert.deepEqual(await verdictsIn(w.briefs), [], `${failing.name}: no verdict is written when the audit is not whole`);
      const logged = (await readFile(audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { error_code: string | null; question_types: string[] });
      assert.deepEqual(logged.map((line) => [line.error_code, line.question_types]), [[failing.code, ['choice']]], failing.name);
      const state = String(wire.calls[0]!.sent.state);
      for (const text of [res.stderr, await readFile(audit, 'utf8')]) {
        assert.ok(!text.includes(JEV_WIRE_KEY), `${failing.name}: the key is not shown`);
        for (const form of [...textForms(state), wire.calls[0]!.text]) assert.ok(!text.includes(form), `${failing.name}: the state text is not shown`);
      }
    }
    for (const file of await filesBelow(w.dir)) assert.ok(!(await readFile(file, 'utf8')).includes(JEV_WIRE_KEY), `the key is in no file: ${relative(w.dir, file)}`);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});
