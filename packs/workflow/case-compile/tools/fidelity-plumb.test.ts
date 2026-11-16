import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { localFidelityBlocks } from './submit-plans.ts';
import { main as applyMain } from './fidelity-apply.ts';
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
  const w = await setupWorkspace(18); // 18 * 2 = 36 steps -> 2 HTTP POST chunks (32 + 4)
  try {
    mode = 'pass';
    postCount = 0;
    const summaryPath = join(w.dir, 'summary.json');
    const res = await runFidelityPlumb(
      ['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin', '--out', summaryPath],
      { stdinText: 'plumb_sk_test_123456\n' },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(postCount, 2, '36 author steps across 18 cases must split into 2 <=32 batches');
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.status, '未确认');
    assert.equal(summary.decided_by, '模型');
    assert.equal(summary.written.length, 18);
    assert.equal(summary.skipped.length, 1);

    // Re-running reuses all existing .verdict.json files with 0 POST calls.
    postCount = 0;
    const second = await runFidelityPlumb(
      ['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'],
      { stdinText: 'plumb_sk_test_123456\n' },
    );
    assert.equal(second.code, 0, second.stderr);
    assert.equal(postCount, 0);
    assert.equal(JSON.parse(second.stdout).reused.length, 18);

    // Merge into plans with fidelity-apply and confirm localFidelityBlocks returns [].
    const oldWrite = process.stdout.write.bind(process.stdout);
    const applyChunks: string[] = [];
    process.stdout.write = ((c: string | Uint8Array) => { applyChunks.push(String(c)); return true; }) as typeof process.stdout.write;
    try {
      const code = await applyMain(['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs]);
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

test('fidelity-plumb honors Option A1 review/reject/strict-review and fails closed on 503', async () => {
  const w = await setupWorkspace(1);
  try {
    // 503 service down NEVER writes a .verdict.json
    mode = 'service_down';
    const failRes = await runFidelityPlumb(
      ['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_env_key' } },
    );
    assert.equal(failRes.code, 1);
    assert.match(failRes.stderr, /^暂时不可用：/);

    // Option A1 review + 保持 -> provisional preserved with explicit review disclosure
    mode = 'review';
    const revRes = await runFidelityPlumb(
      ['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_env_key' } },
    );
    assert.equal(revRes.code, 0, revRes.stderr);
    const revJson = JSON.parse(revRes.stdout);
    assert.equal(revJson.written[0].preserved, 2);
    assert.deepEqual(revJson.written[0].review_required, ['1', '2']);
    const verdictContent = JSON.parse(await readFile(revJson.written[0].verdict, 'utf8'));
    assert.match(verdictContent.disclosure, /\[需人工复核：Plumb sequence 落入 review 区\]/);

    // Fresh briefs dir with --strict-review -> changed instead of provisional preserved
    const strictBriefs = join(w.dir, 'briefs-strict');
    const strictRes = await runFidelityPlumb(
      ['--run', w.runPath, '--plans', w.plans, '--briefs', strictBriefs, '--base-url', baseUrl, '--no-cache', '--strict-review'],
      { env: { ...process.env, PLUMB_API_KEY: 'plumb_sk_env_key' } },
    );
    assert.equal(strictRes.code, 0, strictRes.stderr);
    assert.equal(JSON.parse(strictRes.stdout).written[0].changed, 2);

    // Reject gate -> hard changed
    mode = 'reject';
    const rejectBriefs = join(w.dir, 'briefs-reject');
    const rejRes = await runFidelityPlumb(
      ['--run', w.runPath, '--plans', w.plans, '--briefs', rejectBriefs, '--base-url', baseUrl, '--no-cache'],
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
  mode='pass';const args=['--run',w.runPath,'--plans',w.plans,'--briefs',w.briefs,'--base-url',baseUrl,'--no-cache','--key-stdin'];
  const first=await runFidelityPlumb(args,{stdinText:'plumb_sk_test_123456\n'});assert.equal(first.code,0,first.stderr);
  const summary=JSON.parse(first.stdout),path=summary.written[0].verdict;
  const doc=JSON.parse(await readFile(path,'utf8'));doc.model_disclosure.prompt_version='sequence@product-2400';await writeFile(path,JSON.stringify(doc));
  postCount=0;const second=await runFidelityPlumb(args,{stdinText:'plumb_sk_test_123456\n'});assert.equal(second.code,1);assert.match(second.stderr,/不能复用旧题目/);assert.equal(postCount,0);
 }finally{await rm(w.dir,{recursive:true,force:true});}
});

/* ---- states over the Plumb limit: the cases that fit are judged, the others are named and sent to blind review ---- */

const LONG_NAME = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');

/** Adds a case of three authored actions whose plan has one block per entry of `commands`. */
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
          sources: { states: [{ atom: '2', state: 'missing_prerequisite', prerequisites: ['feature on（手册原话：该功能默认是禁用的）', 'zone dnssec on 启用签名功能'], reason: '功能默认禁用，签名功能须单独开启' }] },
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
    const args = ['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'];
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
    const args = ['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'];
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
    const res = await runFidelityPlumb(['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'], keyed);

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

    // The rewritten state is a function of the plan alone, so the verdict binds to it and a second run reuses it.
    postCount = 0;
    const again = await runFidelityPlumb(['--run', w.runPath, '--plans', w.plans, '--briefs', w.briefs, '--base-url', baseUrl, '--no-cache', '--key-stdin'], keyed);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(postCount, 0);
    assert.equal(JSON.parse(again.stdout).reused.length, 1);
  } finally {
    await rm(w.dir, { recursive: true, force: true });
  }
});
