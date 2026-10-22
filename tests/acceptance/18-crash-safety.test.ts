// Scenario 18 (brief section 9 & task acceptance.md):
// Crash safety: kill the sandbox child mid-function and see an incomplete / unchecked terminal with a reason, not a crash.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { writePack } from '../../hub/runs/api.ts';
import { reviewPack } from '../../hub/server/assemble/test-packs.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import { type McpClient } from './support/mcp.ts';
import { itemResult, itemsOf, requirementOf, resultOf } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;
let packDir: string;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });

  // Create a pack derived from reviewPack with a check function that kills itself during run evaluation
  packDir = await mkdtemp(join(tmpdir(), 'circle-hub-crash-pack-'));
  const desc = reviewPack('1.0.0');
  desc.id = 'crash-review';
  desc.title = '崩溃安全检查包';
  desc.description = '测试沙箱子进程异常退出或被 kill 时的容错处理';

  // Ensure projected item IDs are unique
  desc.files['functions/project.ts'] = `
interface Node { id: string | null; text: string; data: Record<string, unknown>; children: number[]; parent: number | null; selector: string }
interface Bound { slot: string; external: string | null; parser: string; model: { nodes?: Node[] } | null }

export default function project(input: unknown): unknown {
  const inputs = ((input as { inputs?: Bound[] }).inputs ?? []) as Bound[];
  const subject = inputs.find((i) => i.slot === 'map');
  if (subject === undefined || subject.parser !== 'kityminder@1' || subject.model === null || !Array.isArray(subject.model.nodes)) {
    return { error: { code: 'crash.invalid_input', message: '被检查的不是脑图', fix: '给一份 KityMinder 脑图' }, warnings: [] };
  }
  const nodes = subject.model.nodes;
  const items: unknown[] = [];
  nodes.forEach((node, index) => {
    const tags = Array.isArray(node.data.resource) ? node.data.resource.filter((t): t is string => typeof t === 'string') : [];
    if (tags.length === 0) return;
    items.push({
      id: 'doc:item_' + index,
      label: node.text || ('用例 ' + index),
      summary: node.children.length + ' 个期望结果',
      location: { parser: 'kityminder@1', selector: node.selector },
      fields: { title: node.text || ('用例 ' + index), tags, expected: node.children.map((c) => nodes[c]?.text ?? '') },
    });
  });
  return { items, warnings: [] };
}
`;

  // Add crash_func check to requirements
  const reqs = desc.files['requirements.json'] as { requirements: unknown[] };
  reqs.requirements.push({
    key: 'crash_req',
    name: '崩溃要求项',
    description: '沙箱子进程在执行中收到 SIGKILL 信号',
    target: 'item',
    required: true,
    done_rule: 'gating',
    layers: ['static'],
    accepted_producer: 'fact',
    checks: ['crash_func'],
    error_handling: [],
  });

  // Add check definition to checks.json
  const checks = desc.files['checks.json'] as { checks: unknown[] };
  checks.checks.push({
    id: 'crash_func',
    function: { module: 'functions/crash.ts' },
    applies: 'run',
    judges: 'subject',
    tier: 'blocking',
    basis: '沙箱崩溃安全测试条款',
  });

  // Provide the function implementation
  // During publish-time sample validation, it handles the samples cleanly.
  // During actual run evaluation, it sends SIGKILL to itself.
  desc.files['functions/crash.ts'] = `
export default function (input: any) {
  const items = input?.subject?.items ?? [];
  if (items.some((it: any) => it.id === 'sample:neg')) {
    return [{ verdict: 'refute', code: 'crash-review.fail', statement: '样例反驳', grounds: [], tier: 'blocking', item: 'sample:neg' }];
  }
  if (items.some((it: any) => it.id === 'sample:pos')) {
    return [{ verdict: 'support', statement: '样例支持', grounds: [], tier: 'blocking', item: 'sample:pos' }];
  }
  // Running on actual run evaluation: kill child process mid-function
  process.kill(process.pid, 'SIGKILL');
}
`;

  // Provide positive and negative samples for publish validation
  desc.files['samples/positive/crash-good.json'] = {
    id: 'crash_good',
    source: 'author',
    check: 'crash_func',
    subject: { items: [{ id: 'sample:pos' }] },
    expect: [{ verdict: 'support', item: 'sample:pos', tier: 'blocking' }],
  };

  desc.files['samples/negative/crash-bad.json'] = {
    id: 'crash_bad',
    source: 'author',
    check: 'crash_func',
    subject: { items: [{ id: 'sample:neg' }] },
    expect: [{ verdict: 'refute', code: 'crash-review.fail', item: 'sample:neg', tier: 'blocking' }],
  };

  await writePack(packDir, desc);
  await bed.hub.publishPack(packDir);
  await bed.hub.assignPack(bed.reviewer.principal, 'crash-review');

  client = await bed.connect(bed.reviewer, 'sess-s18-crash');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});

after(async () => {
  await bed?.close().catch(() => {});
  await postgres?.stop().catch(() => {});
  if (packDir) await rm(packDir, { recursive: true, force: true }).catch(() => {});
});

describe('scenario 18: crash safety when sandbox child process is killed mid-function', () => {
  let run: RunSummary;

  test('start a run with the crash-review workflow pack', async () => {
    const started = await client.call('start_run', {
      pack: 'crash-review',
      inputs: { map: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.equal(started.isError, false, started.text);
    assert.equal(started.out.call_result, 'ok');
    run = started.out.run as RunSummary;
    assert.ok(run.run);
    assert.ok(run.items.length > 0);
  });

  test('kill sandbox child mid-function: Hub does not crash, returns valid response with terminal reason', async () => {
    const submission = {
      run: run.run,
      model: 'scripted-model-crash-test',
      items: run.items.map((it) => ({
        item: it.id,
        handling: 'handled',
        slots: { notes: [] },
      })),
      cross_item: [],
    };

    // The call must not throw, exit, or crash the Hub process
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    assert.ok(result.run === run.run);

    // Each item's requirement layer records an unsettled terminal (unchecked/incomplete) with reason 'check_error'
    const reqResult = requirementOf(result, run.items[0].id, 'crash_req');
    assert.ok(reqResult, 'requirement result must be present');
    const staticLayer = reqResult.layers.find((l) => l.layer === 'static');
    assert.ok(staticLayer, 'static layer must be present');
    assert.ok(
      staticLayer.terminal === 'unchecked' || staticLayer.terminal === 'incomplete',
      `terminal should be unchecked or incomplete, got: ${staticLayer.terminal}`,
    );
    assert.equal(staticLayer.reason, 'check_error');

    // Check item partition
    const itemPart = itemResult(result, run.items[0].id);
    assert.ok(itemPart.partition, 'item must be partitioned');

    // Validation result record is stored in DB
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(stored.items.length, 1);

    // Action record reflects the validate operation
    const actions = await bed.hub.records.store.find({ key: 'runs.action.run', value: run.run });
    assert.ok(actions.items.some((a) => (a.body as { action?: string }).action === 'validate'));

    // Call log line was recorded for this submit_result
    const logPage = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    assert.ok(logPage.items.length >= 1);
    assert.ok(logPage.items.some((l) => l.tool === 'submit_result'));

    // Console page loads cleanly without 500 error
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp(run.run));
  });

  test('Hub remains alive and can process subsequent operations normally', async () => {
    // Normal follow-up call succeeds
    const listed = await client.call('list_task_packs', {});
    assert.equal(listed.isError, false);
    assert.equal(listed.out.call_result, 'ok');

    const runDetail = await bed.hub.hub.runs.getRun(bed.reviewer.principal, run.run);
    assert.ok(runDetail);
    assert.equal(runDetail.run.run, run.run);
  });
});
