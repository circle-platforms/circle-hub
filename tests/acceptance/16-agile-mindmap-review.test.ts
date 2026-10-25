// Scenario 16 (brief section 9 & task acceptance.md):
// The whole review of a ~150-node mind-map fixture fetched through the stubbed agile system pack
// by external id agile:mindmap:<id> with linked story and bug text bound as expected sources.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { fixtureText } from '../fixtures/mindmaps/index.ts';
import { openConsole, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import { draft, oracleCases, resultOf, startReview } from './support/review.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  client = await bed.connect(bed.reviewer, 'sess-s16-whole');
  consoleClient = await openConsole(bed.hub, bed.reviewer.token);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

const document = JSON.parse(fixtureText('review-150.km.json'));

describe('scenario 16: whole review of ~150-node agile mind map with linked expected sources', () => {
  let run: RunSummary;

  test('start_run fetches mindmap by agile:mindmap:<id> and binds linked story and bug sources', async () => {
    run = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      // R6: sources are author declarations, never inferred from numbered prose titles.
      parameters: { stories: ['31057'], bugs: ['31057'] },
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });

    // 1. The ~150-node mindmap yields the cases of the default (marked) rule, computed by the independent oracle:
    // tagged cases plus the team template's marked cases (3 of them in this fixture have no tags).
    assert.equal(run.items.length, oracleCases(document).length, 'the ~150-node mind map yields the oracle\'s case count under the marked rule');
    assert.equal(oracleCases(document).length - oracleCases(document, { rule: 'tagged' }).length, 3, '3 cases are recognized by the marker only');

    // 2. Bound sources: subject plus explicitly declared story and bug from PLM
    const subject = run.sources.find((s) => s.role === 'subject');
    assert.ok(subject && subject.external?.startsWith(`agile:mindmap:${DOCUMENTS.review}`));

    const expectedSources = run.sources.filter((s) => s.role === 'expected');
    assert.ok(expectedSources.length >= 2, 'has linked expected sources');

    const storySource = expectedSources.find((s) => s.external?.startsWith('plm:story:'));
    const bugSource = expectedSources.find((s) => s.external?.startsWith('plm:bug:'));
    assert.ok(storySource, 'linked story from PLM bound as expected source');
    assert.ok(bugSource, 'linked bug from PLM bound as expected source');

    // 3. Stored artifacts: verify the fetched sources are stored in records
    for (const source of [subject, storySource, bugSource]) {
      const sha256 = source.reference.replace(/^src:/, '').split('/')[0];
      const obj = await bed.hub.records.objects.get(sha256);
      assert.ok(obj !== null, `source artifact ${source.reference} exists in object store`);
    }
  });

  test('submit_result delivers all ~150 items and stores complete validation result', async () => {
    const submission = draft(run);
    const answer = await client.call('submit_result', submission);
    assert.equal(answer.isError, false, answer.text);
    assert.equal(answer.out.call_result, 'ok');
    assert.equal(answer.out.acceptance, 'accepted');

    const result = resultOf(answer);
    assert.equal(result.partitions.delivered.length, run.items.length);
    assert.equal(answer.out.counts?.delivered, run.items.length);

    // Stored records: validation_result
    const stored = await bed.hub.records.store.find({ key: 'runs.result.run', value: run.run });
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0].schema, 'validation@1');

    // Call log reflects completion
    const logs = await bed.hub.records.callLog.query(bed.hub.admin.principal, { runId: run.run });
    const submitCall = logs.items.find((l) => l.tool === 'submit_result');
    assert.ok(submitCall);
    assert.equal(submitCall.acceptance, 'accepted');

    // Console HTML displays the ~150 items and delivered count
    const page = await consoleClient.get(`/console/runs/${run.run}`);
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(String(run.items.length)));
    assert.ok(page.body.includes(run.run));
  });

  test('answer exceeding budget is soft-capped and truncated with explanation note', async () => {
    // Construct a synthetic mindmap with 95 case nodes (under the 100-case single-run limit)
    // but generating > 10,000 chars of problem lines, exceeding SOFT_CAP (9,000) and budget (30,000)
    const bigMindmap = {
      root: {
        data: { id: 'root_big', text: '合成超大测试脑图' },
        children: Array.from({ length: 95 }, (_, i) => ({
          data: {
            id: `case_node_${i}`,
            text: `用例 ${i} - 验证超长列表在预算截断路径下的展示与分页能力测试说明文字内容详情`,
            resource: ['Functional'],
            priority: 2,
          },
          children: [
            { data: { id: `step_${i}`, text: `步骤 ${i}：执行基本操作与校验输出` } },
          ],
        })),
      },
    };

    const uploadRef = await client.upload(Buffer.from(JSON.stringify(bigMindmap)), 'big-review.km.json');
    assert.match(uploadRef, /^src:[0-9a-f]{64}$/);

    const startAnswer = await client.call('start_run', {
      pack: 'case-review',
      product: bed.product.names[0],
      version: bed.site.LINE,
      // R6: sources are author declarations, never inferred from numbered prose titles.
      parameters: { stories: ['31057'], bugs: ['31057'] },
      inputs: { subject: { reference: uploadRef } },
    });
    assert.equal(startAnswer.isError, false, startAnswer.text);
    const bigRun = startAnswer.out.run as RunSummary;
    assert.equal(bigRun.items.length, 95, 'mindmap yields 95 items');

    // Submit a result that skips items, generating > 9000 chars of problems to exercise softCap break and budget truncation
    const skipSubmission = {
      run: bigRun.run,
      model: 'test-model',
      items: bigRun.items.map((it) => ({
        item: it.id,
        handling: 'skipped' as const,
        reason: '跳过以验证超长问题列表软上限截断路径与预算说明详情文字内容',
      })),
      cross_item: [{ nature: 'judgment' as const, statement: '结论等级 P3', grounds: [], code: 'level', rank: 'P3' }],
    };

    const submitAnswer = await client.call('submit_result', skipSubmission);
    assert.equal(submitAnswer.isError, false);
    // Answer text must be within TEXT_BUDGET (30000 characters)
    assert.ok(submitAnswer.text.length <= 30000, `answer text length ${submitAnswer.text.length} must be <= 30000`);
    // Note of truncation must be present
    assert.ok(submitAnswer.text.includes('部分：这段回答以 30000 个字符为限，略去了'));
    assert.ok(submitAnswer.text.includes('读其余部分：'));
    // Soft-cap splits the problem list at ~9000 chars so that later items and problems are partially omitted
    assert.ok(
      submitAnswer.text.includes('略去了条目明细') || submitAnswer.text.includes('略去了问题与未知') || submitAnswer.text.includes('略去了错误'),
      'softCap and fit must name omitted errors, problems or item detail: '+submitAnswer.text.split('部分：').at(-1),
    );
    const counts=submitAnswer.out.counts!;
    assert.equal(counts.delivered+counts.rejected+counts.quarantined+counts.incomplete,95,'counts survive truncation');
    const saved=(await bed.hub.records.store.find({key:'runs.result.run',value:bigRun.run})).items[0];assert.ok(saved);
    const full=await client.call('get_nodes',{reference:'rec:'+saved.digest});assert.equal(full.isError,false,'the saved result remains readable');
  });
});
