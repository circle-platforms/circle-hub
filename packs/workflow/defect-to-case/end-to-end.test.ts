import {makeGoodDraft,makeDuplicateDraft,expectedFor,FIX_REF,BUG_RAW} from './testing/fixtures.ts';
// End to end test of defect-to-case pack through the real engine.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Submission } from '../../../contracts/src/submission.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { SYNTHETIC_INDEX_VIEW } from './testing/fixtures.ts';
import { PACK_DIR } from './pack-files.ts';
import { call, openHub, type Hub } from './testing/hub.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';
let postgres: TemporaryPostgres;
let hub: Hub;

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  hub = await openHub(postgres);
});

after(async () => {
  await hub?.close();
  await postgres?.stop();
});

describe('defect-to-case end to end run', { skip }, () => {
  it('reads the draft head at the bound revision during checking and cites its read manifest', async () => {
    const index=structuredClone(SYNTHETIC_INDEX_VIEW);
    Object.values(index.entries)[0].data.case_structure={schema:'case-structure@2',commands:makeDuplicateDraft().steps.map(step=>step.identity),expected:[{after:1,quote:expectedFor('健康检查间隔设置成功',FIX_REF).identity}]};
    hub.external.put('knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure',{bytes:Buffer.from(JSON.stringify(index)),mediaType:'application/json'});
    for(const key of hub.external.objects.keys())if(key.startsWith('knowledge:index:'))hub.external.put(key,{bytes:Buffer.from(JSON.stringify(index)),mediaType:'application/json'});
    const started = await hub.service.startRun(hub.alice, {
      pack: 'defect-to-case', product: 'famx', build: 'Rel_FAMX_10_6_1_57',
      inputs: { defects: [{ external: 'plm:bug:74001' }], indexed_cases: { external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure' } },
    }, call());
    assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
    const run = started.run!;
    const bug = run.sources.find(source => source.slot === 'defects')!;
    const quote = { reference: `${bug.reference}/json@1/p/fields/fix`, text: '健康检查间隔设置成功' };
    const draft=makeDuplicateDraft();
    // The expected identity is an author declaration, while quote text is checked separately against the bound fix.
    draft.expected=[expectedFor(quote.text,FIX_REF)];
    const title=draft.title;
    const answer = await hub.service.submitResult(hub.alice, { run: run.run, model: 'synthetic-model', items: [{ item: '74001', handling: 'handled', slots: { cases: [{ text: title, quotes: [quote], data: draft }] } }] }, call());
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
    const result = answer.result as ValidationResult;
    const claims = Object.values(result.partitions).flat().flatMap(item => item.requirements).filter(requirement => requirement.requirement === 'not_duplicate').flatMap(requirement => requirement.claims);
    const claim = claims.find(claim => claim.statement.code === 'defect-to-case.duplicate_case');
    assert.ok(claim, JSON.stringify(claims)); assert.match(claim.statement.data?.read_manifest as string, /^rec:[a-f0-9]{64}$/);
    const bound = run.sources.find(source => source.slot === 'indexed_cases')!;
    assert.ok(bound.external?.endsWith(`@${SYNTHETIC_INDEX_VIEW.build.root}`));
    assert.ok(hub.external.reads.includes(`knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure&only=%2Fcommands%2Fshow%2Fhealth%2Fdetail@${SYNTHETIC_INDEX_VIEW.build.root}`));
  });

  it('runs full repair round: first rejected with fixes, second accepted, skipped defect honest', async () => {
    // 1. start_run
    const started = await hub.service.startRun(
      hub.alice,
      {
        pack: 'defect-to-case',
        product: 'famx',
        build: 'Rel_FAMX_10_6_1_57',
        inputs: {
          manual: { external: 'manual:cli:10.6.1' },
          defects: [
            { external: 'plm:bug:74001' },
            { external: 'plm:bug:71010' },
          ],
          indexed_cases: {
            external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&only=show%20health%20detail&fields=commands,document,node,title,negative,case_structure',
          },
        },
      },
      call('sess-e2e-start'),
    );

    assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
    assert.ok(started.run);
    const runId = started.run.run;
    assert.equal(started.run.items.length, 2);

    // Locate the fix reference for 74001 from the bound defect source
    const defectSource = started.run.sources.find((s) => (s.external ?? '').includes('74001'));
    assert.ok(defectSource, 'defect source should be bound');
    const fixRef = `${defectSource.reference}/json@1/p/fields/fix`;

    // 2. Round 1 submission: with a quotation mismatch error for 74001
    const sub1 = await hub.service.submitResult(
      hub.alice,
      {
        run: runId,
        model: 'synthetic-model',
        items: [
          {
            item: '74001',
            handling: 'handled',
            slots: {
              cases: [
                {
                  text: 'SLB健康检查间隔配置测试',
                  quotes: [{ reference: fixRef, text: '故意写错的引文内容，不在原文里' }],
                  data: {
                    title: 'SLB健康检查间隔配置测试',
                    priority: 2,
                    negative: false,
                    expects_refutation: false,
                    preconditions: ['SLB正常运行'],
                    steps: [{ command: 'widget health interval 60' }],
                    expected: [
                      {
                        text: '健康检查间隔设置成功',
                        quote: { reference: fixRef, text: '故意写错的引文内容，不在原文里' },
                      },
                    ],
                    tags: ['Functional'],
                  },
                },
              ],
            },
          },
          {
            item: '71010',
            handling: 'skipped',
            reason: '底层组件内存碎片整理优化，无外部可测命令行或行为变化',
          },
        ],
      },
      call('sess-e2e-sub1'),
    );

    // First submission is not accepted due to QUOTE_MISMATCH at boundary
    assert.equal(sub1.call_result, 'error', JSON.stringify(sub1.errors));
    assert.equal(sub1.acceptance, 'not_accepted');
    assert.ok(sub1.errors.some((e) => e.code === 'QUOTE_MISMATCH'));

    // 3. Round 2 submission: repair with verbatim quote from fix description
    const sub2 = await hub.service.submitResult(
      hub.alice,
      {
        run: runId,
        model: 'synthetic-model',
        items: [
          {
            item: '74001',
            handling: 'handled',
            slots: {
              cases: [
                {
                  text: 'SLB健康检查间隔配置测试',
                  quotes: [{ reference: fixRef, text: '健康检查间隔设置成功' }],
                  data: {
                    title: 'SLB健康检查间隔配置测试',
                    priority: 2,
                    negative: false,
                    expects_refutation: false,
                    preconditions: ['SLB正常运行'],
                    steps: [{ command: 'widget health interval 60' }],
                    expected: [
                      {
                        text: '健康检查间隔设置成功',
                        quote: { reference: fixRef, text: '健康检查间隔设置成功' },
                      },
                    ],
                    tags: ['Functional'],
                  },
                },
              ],
            },
          },
          {
            item: '71010',
            handling: 'skipped',
            reason: '底层组件内存碎片整理优化，无外部可测命令行或行为变化',
          },
        ],
      },
      call('sess-e2e-sub2'),
    );

    // Second submission is accepted
    assert.equal(sub2.call_result, 'ok', JSON.stringify(sub2.errors));
    assert.ok(sub2.result);
    const result = sub2.result as ValidationResult;

    // Check partitions
    // 74001 was handled and delivered
    assert.ok(
      result.partitions.delivered.some((p) => p.item === '74001'),
      '74001 should be in delivered partition',
    );
    // At zero remaining rounds the skipped work is repair exhausted; its submitted reason remains visible.
    const skippedItem = result.partitions.incomplete.find((p) => p.item === '71010');
    assert.ok(skippedItem, '71010 should be in incomplete partition');
    assert.equal(skippedItem.reason,'repair_exhausted');
    assert.ok(skippedItem.skip_reason);
    assert.ok(result.errors.some(error=>error.item==='71010'&&error.code==='repair_exhausted'&&error.rounds_left===0&&error.fix?.includes('请求 rec:')));
  });

  it('blocks a paraphrased expectation and consumes a repair round when it is resubmitted', async () => {
    const started = await hub.service.startRun(hub.alice, {
      pack: 'defect-to-case', product: 'famx', build: 'Rel_FAMX_10_6_1_57',
      inputs: { manual: { external: 'manual:cli:10.6.1' }, defects: [{ external: 'plm:bug:74001' }], indexed_cases: { external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&only=show%20health%20detail&fields=commands,document,node,title,negative,case_structure' } },
    }, call());
    assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
    const run = started.run!;
    const source = run.sources.find((s) => s.slot === 'defects')!;
    const quote = { reference: `${source.reference}/json@1/p/fields/fix`, text: '健康检查间隔设置成功' };
    const submit = (text: string) => hub.service.submitResult(hub.alice, { run: run.run, model: 'synthetic-model', items: [{ item: '74001', handling: 'handled', slots: { cases: [{ text: '合成回归', quotes: [quote], data: { ...makeGoodDraft({ref:FIX_REF}), title:'合成回归',expected:[{...expectedFor(quote.text,FIX_REF),text}] } }] } }] }, call());
    const first = await submit('健康检查间隔保存成功');
    assert.equal(first.call_result, 'ok', JSON.stringify(first.errors));
    const result = first.result as ValidationResult;
    const error = result.errors.find((e) => e.code === 'defect-to-case.expect_not_in_quote');
    assert.ok(error, JSON.stringify(result.errors));
    assert.equal(error.rounds_left, 2);
    assert.equal(error.path, '/items/0/slots/cases/0/data/expected/0/text');
    assert.match(error.message, /修正/);
    const item = Object.values(result.partitions).flat().find((i) => i.item === '74001')!;
    assert.equal(item.requirements.find((r) => r.requirement === 'grounded')?.status, 'unsatisfied');
    const repeated = await submit('健康检查间隔保存完毕');
    assert.equal((repeated.result as ValidationResult).rounds.used, 1);
    const repaired = await submit(quote.text);
    assert.equal(repaired.acceptance, 'accepted', JSON.stringify(repaired.errors));
    const healed = Object.values((repaired.result as ValidationResult).partitions).flat().find((i) => i.item === '74001')!;
    assert.equal(healed.requirements.find((r) => r.requirement === 'grounded')?.status, 'satisfied');
  });

  it('rejects a valid quote from the wrong defect field and accepts the explicitly bound manual', async () => {
    const started = await hub.service.startRun(hub.alice, {
      pack: 'defect-to-case', product: 'famx', build: 'Rel_FAMX_10_6_1_57',
      inputs: { manual: { external: 'manual:cli:10.6.1' }, defects: [{ external: 'plm:bug:74001' }], indexed_cases: { external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&only=show%20health%20detail&fields=commands,document,node,title,negative,case_structure' } },
    }, call());
    assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
    const run = started.run!;
    const bug = run.sources.find((s) => s.slot === 'defects')!;
    const manual = run.sources.find((s) => s.slot === 'manual')!;
    const submit = (reference: string, text: string) => hub.service.submitResult(hub.alice, { run: run.run, model: 'synthetic-model', items: [{ item: '74001', handling: 'handled', slots: { cases: [{ text: '合成来源核对', quotes: [{ reference, text }], data: { title: '合成来源核对', priority: 2, negative: false, expects_refutation: false, steps: [{ command: 'widget health interval 60' }], expected: [{ text, quote: { reference, text } }], tags: ['Functional'] } }] } }] }, call());
    const wrong = await submit(`${bug.reference}/json@1/p/fields/steps`, '进入合成页面');
    assert.equal(wrong.call_result, 'ok', JSON.stringify(wrong.errors));
    assert.ok((wrong.result as ValidationResult).errors.some((e) => e.code === 'defect-to-case.quote_source_forbidden'));
    const good = await submit(`${manual.reference}/markdown@1/b/0`, '服务端口修改成功');
    assert.equal(good.acceptance, 'accepted', JSON.stringify(good.errors));
  });

  it('defect-to-case examples/submit-result.json is accepted by submitResult', async () => {
    const started = await hub.service.startRun(
      hub.alice,
      {
        pack: 'defect-to-case',
        product: 'famx',
        build: 'Rel_FAMX_10_6_1_57',
        inputs: {
          manual: { external: 'manual:cli:10.6.1' },
          defects: [{ external: 'plm:bug:74001' }],
          indexed_cases: {
            external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&only=show%20health%20detail&fields=commands,document,node,title,negative,case_structure',
          },
        },
      },
      call('sess-example-start'),
    );
    assert.equal(started.call_result, 'ok', JSON.stringify(started.errors));
    assert.ok(started.run);

    const raw = JSON.parse(await readFile(join(PACK_DIR, 'examples', 'submit-result.json'), 'utf8')) as Record<string, unknown>;
    const body = { ...raw, run: started.run.run };
    const answer = await hub.service.submitResult(hub.alice, body as Submission, call('sess-example-sub'));
    assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  });
});
