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
      for (const qid of Object.keys(body.questions ?? {})) {
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
