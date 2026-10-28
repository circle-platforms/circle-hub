// Acceptance test 38: R5 T1-T3 Synthetics Acceptance
// Covers:
// - T1-1 知识问答: 只给根的核对 (A6 standalone root mode) 与反例 (改字解析失败、跨版本线根拒绝、参数校验)
// - T1-2 测试脑图评审全链合成版:
//   - 定位 (case-location) -> 初评 (case-review) -> 同族复核 (case-review-verify 独立性未知) -> 终稿不放行 (block_unsettled)
//   - 换家族后独立复核 -> 独立性满足 -> 终稿放行并受理 (case-review-report)
//   - 反例: 命令树内命令说成不存在反驳、PASS 携推翻发现拒绝、终稿多重结论拒绝
// - T2-2 按编号读原件 (source-read) 全部反例: 编号不存在、路由未声明、来源不可达、空输入、格式非法
// - T2-3 / T2-4 / T2-5 / T2-6 平台事实反例与边界
// - T3-1 / T3-2 构建差异: 影响视图残缺目录在启动期被拒 (catalog=commands@1 缺失或不符)
//
// Synthetic fixtures only: product FAMX/FAMY (two-name) and lumen-api (one-name).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { RunSummary } from '../../contracts/src/run.ts';
import type { ValidationResult } from '../../contracts/src/validation.ts';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';
import {
  DRAFTER,
  DRAFTER_IDENTITY,
  VERIFIER,
  VERIFIER_IDENTITY,
  draft,
  finding,
  level,
  startReview,
  type SlotClaim,
} from './support/review.ts';

const REPORTER = 'omega-reporter 1.0 (scripted, temperature 0)';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;
let verifierClient: McpClient;
let adminClient: McpClient;

const receiptOf = async (run: string): Promise<string> => {
  const detail = await bed.hub.deps.runs.getRun(bed.reviewer.principal, run);
  assert.ok(detail?.latest);
  return detail.latest.record;
};

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: true });
  for (const pack of [
    'case-location',
    'case-review',
    'case-review-verify',
    'case-review-report',
    'source-read',
    'defect-to-case',
    'traceability',
    'story-traceability',
    'quality-board',
    'regression-scope',
    'maintenance-sweep',
  ]) {
    await bed.hub.assignPack(bed.reviewer.principal, pack);
  }
  client = await bed.connect(bed.reviewer, 'session-t1t3-client');
  verifierClient = await bed.connect(bed.reviewer, 'session-t1t3-verifier');
  adminClient = await bed.connect(bed.hub.admin, 'session-t1t3-admin');
});

after(async () => {
  await adminClient?.close().catch(() => undefined);
  await client?.close().catch(() => undefined);
  await verifierClient?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('T1-2 测试脑图评审全链合成版', () => {
  let draftRun: RunSummary;
  let sameFamilyRun: RunSummary;
  let independentRun: RunSummary;

  it('step 1: case-location locates mind map into product line, train, module and build candidates', async () => {
    const locRes = await client.call('start_run', {
      pack: 'case-location',
      product: 'FAMX',
      inputs: {
        documents: [{ external: `agile:mindmap:${DOCUMENTS.review}` }],
      },
    });
    assert.equal(locRes.isError, false, locRes.text);
    assert.equal(locRes.out.call_result, 'ok');
    const prodResult = locRes.out.result!;
    assert.ok(prodResult.counts.delivered > 0);

    const nodeRes = await client.call('get_nodes', { reference: prodResult.reference });
    const full = JSON.parse(nodeRes.out.content!.text!);
    const locItem = full.partitions.delivered[0];
    const locClaim = locItem.requirements.find((r: any) => r.requirement === 'location').claims[0];
    assert.equal(locClaim.statement.data.line, '7.1');
    assert.ok(locClaim.statement.data.train);
    assert.ok(locClaim.statement.data.module);
  });

  it('step 2: case-review drafter starts review, submits draft findings quoting verbatim text', async () => {
    draftRun = await startReview(client, {
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
    });
    assert.ok(draftRun.items.length > 0);

    const item0 = draftRun.items[0];
    const findingsMap = new Map<string, SlotClaim[]>([
      [item0.id, [finding(item0, { text: '字面问题：标题重复', code: 'literal_issue', rank: 'major' })]],
    ]);

    const draftPayload = draft(draftRun, findingsMap, {
      model: DRAFTER,
      model_identity: DRAFTER_IDENTITY,
      cross: [level('P4')],
    });

    const draftRes = await client.call('submit_result', draftPayload);
    assert.equal(draftRes.isError, false, draftRes.text);
    assert.equal(draftRes.out.acceptance, 'accepted');
  });

  it('step 3: same-family verification is recorded but marked independence_unknown and blocks report admission', async () => {
    const draftReceipt = await receiptOf(draftRun.run);
    const startSame = await verifierClient.call('start_run', {
      pack: 'case-review-verify',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: {
        target: { external: `agile:mindmap:${DOCUMENTS.review}` },
        draft: { reference: `rec:${draftReceipt}` },
      },
      predecessor: draftRun.run,
    });
    assert.equal(startSame.isError, false, startSame.text);
    sameFamilyRun = startSame.out.run as RunSummary;

    // Submit with the SAME model family as drafter
    const sameFamilyPayload = {
      run: sameFamilyRun.run,
      model: 'synthetic-checker-same-family',
      model_identity: {
        model_id: 'synthetic-checker-same-family',
        model_family_id: DRAFTER_IDENTITY.model_family_id,
      },
      items: sameFamilyRun.items.map((it) => {
        const draftFindings = (it.fields.draft_findings ?? []) as Array<{ reference: string }>;
        return {
          item: it.id,
          handling: 'handled',
          slots: {
            verification: draftFindings.map((f): SlotClaim => ({
              text: '核实后推翻初评发现',
              code: 'refuted',
              rank: 'minor',
              location: it.location,
              quotes: [{ reference: it.location, text: it.label }],
              data: { finding: f.reference },
            })),
          },
        };
      }),
      cross_item: [
        { nature: 'judgment', statement: '结论 PARTIAL', grounds: [], code: 'PARTIAL', rank: 'P4' },
      ],
    };

    const sameSubmitRes = await verifierClient.call('submit_result', sameFamilyPayload);
    assert.equal(sameSubmitRes.isError, false);
    assert.equal(sameSubmitRes.out.acceptance, 'accepted');

    // Independence requirement is not satisfied (independence_unknown)
    const stored = (await bed.hub.deps.runs.getRun(bed.reviewer.principal, sameFamilyRun.run))!.latest!.result;
    const allItems = Object.values(stored.partitions).flat();
    assert.ok(
      allItems.some((item) => item.requirements.some((r) => r.unsatisfied_reason === 'independence_unknown')),
      'same-family verification marks independence_unknown',
    );

    // Final report run on same-family verification is refused admission
    const sameReceipt = await receiptOf(sameFamilyRun.run);
    const reportRefusal = await client.call('start_run', {
      pack: 'case-review-report',
      inputs: {
        verifications: [{ reference: `rec:${sameReceipt}` }],
        target: { external: `agile:mindmap:${DOCUMENTS.review}` },
      },
    });
    assert.equal(reportRefusal.isError, true);
    assert.ok(
      reportRefusal.out.errors.some((e) => e.code === 'case-review-report.block_unsettled'),
      'report admission refuses unsettled block from non-independent verification',
    );
  });

  it('step 4: independent verification with different family succeeds and allows report admission', async () => {
    const draftReceipt = await receiptOf(draftRun.run);
    const startIndep = await verifierClient.call('start_run', {
      pack: 'case-review-verify',
      product: bed.product.names[0],
      version: bed.site.LINE,
      inputs: {
        target: { external: `agile:mindmap:${DOCUMENTS.review}` },
        draft: { reference: `rec:${draftReceipt}` },
      },
      predecessor: draftRun.run,
    });
    assert.equal(startIndep.isError, false);
    independentRun = startIndep.out.run as RunSummary;

    // Submit with independent model family (VERIFIER_IDENTITY: synthetic-family-omega)
    const indepPayload = {
      run: independentRun.run,
      model: VERIFIER,
      model_identity: VERIFIER_IDENTITY,
      items: independentRun.items.map((it) => {
        const draftFindings = (it.fields.draft_findings ?? []) as Array<{ reference: string }>;
        return {
          item: it.id,
          handling: 'handled',
          slots: {
            verification: draftFindings.map((f): SlotClaim => ({
              text: '核实后推翻初评发现',
              code: 'refuted',
              rank: 'minor',
              location: it.location,
              quotes: [{ reference: it.location, text: it.label }],
              data: { finding: f.reference },
            })),
          },
        };
      }),
      cross_item: [
        { nature: 'judgment', statement: '结论 PARTIAL', grounds: [], code: 'PARTIAL', rank: 'P4' },
      ],
    };

    const indepSubmitRes = await verifierClient.call('submit_result', indepPayload);
    assert.equal(indepSubmitRes.isError, false);
    assert.equal(indepSubmitRes.out.acceptance, 'accepted');

    // Stored verification satisfies independence
    const stored = (await bed.hub.deps.runs.getRun(bed.reviewer.principal, independentRun.run))!.latest!.result;
    const allItems = Object.values(stored.partitions).flat();
    assert.ok(
      !allItems.some((item) => item.requirements.some((r) => r.unsatisfied_reason === 'independence_unknown')),
      'independent verification satisfies independence',
    );

    // Final report run on independent verification receipt is ADMITTED!
    const indepReceipt = await receiptOf(independentRun.run);
    const reportStart = await client.call('start_run', {
      pack: 'case-review-report',
      inputs: {
        verifications: [{ reference: `rec:${indepReceipt}` }],
        target: { external: `agile:mindmap:${DOCUMENTS.review}` },
      },
    });
    assert.equal(reportStart.isError, false, reportStart.text);
    const reportRun = reportStart.out.run as RunSummary;

    // Step 5: Submit report and verify partition counts equal total items
    const reportSubmit = await client.call('submit_result', {
      run: reportRun.run,
      model: REPORTER,
      items: reportRun.items.map((it) => ({ item: it.id, handling: 'handled', slots: {} })),
      cross_item: [
        { nature: 'judgment', statement: '终稿报告结论：部分正确，等级 P4', grounds: [], code: 'PARTIAL', rank: 'P4' },
      ],
    });
    assert.equal(reportSubmit.isError, false, reportSubmit.text);
    assert.equal(reportSubmit.out.acceptance, 'accepted');
    const result = reportSubmit.out.result as ValidationResult;
    const totalPartitionCount = Object.values(result.partitions).reduce((sum, list) => sum + list.length, 0);
    assert.equal(totalPartitionCount, reportRun.items.length);
  });

  describe('T1-2 反例', () => {
    it('counter-example 1: draft claims present command is absent -> core.catalog.membership_contradicted', async () => {
      const run = await startReview(client, {
        product: bed.product.names[0],
        version: bed.site.LINE,
        inputs: { subject: { external: `agile:mindmap:${DOCUMENTS.review}` } },
      });
      const it0 = run.items[0];
      const badFinding = finding(it0, {
        text: '认为命令 show health 不存在',
        code: 'edge_case_gap',
        commands: [{ command: 'show health', present: false }],
      });
      const payload = draft(run, new Map([[it0.id, [badFinding]]]));
      const submitRes = await client.call('submit_result', payload);
      assert.equal(submitRes.isError, false);
      const errors = submitRes.out.errors ?? [];
      assert.ok(
        errors.some((e) => e.code === 'core.catalog.membership_contradicted'),
        `expected core.catalog.membership_contradicted, got: ${JSON.stringify(errors)}`,
      );
    });

    it('counter-example 2: PASS verification carrying refuted finding is rejected with pass_with_refuted', async () => {
      const draftReceipt = await receiptOf(draftRun.run);
      const startRes = await verifierClient.call('start_run', {
        pack: 'case-review-verify',
        product: bed.product.names[0],
        version: bed.site.LINE,
        inputs: {
          target: { external: `agile:mindmap:${DOCUMENTS.review}` },
          draft: { reference: `rec:${draftReceipt}` },
        },
        predecessor: draftRun.run,
      });
      const run = startRes.out.run as RunSummary;
      const it0 = run.items[0];
      const draftFindings = (it0.fields.draft_findings ?? []) as Array<{ reference: string }>;

      // Verdict PASS, but refutes a draft finding!
      const payload = {
        run: run.run,
        model: VERIFIER,
        model_identity: VERIFIER_IDENTITY,
        items: run.items.map((it) => ({
          item: it.id,
          handling: 'handled',
          slots: {
            verification: draftFindings.map((f): SlotClaim => ({
              text: '核实后推翻初评发现',
              code: 'refuted',
              rank: 'minor',
              location: it.location,
              quotes: [{ reference: it.location, text: it.label }],
              data: { finding: f.reference },
            })),
          },
        })),
        cross_item: [
          { nature: 'judgment', statement: '结论 PASS', grounds: [], code: 'PASS', rank: 'P3' },
        ],
      };

      const res = await verifierClient.call('submit_result', payload);
      assert.equal(res.isError, false);
      const refutes = res.out.result?.cross_item.filter((c) => c.statement.verdict === 'refute') ?? [];
      assert.ok(
        refutes.some((c) => c.statement.code === 'case-review-verify.pass_with_refuted'),
        `expected pass_with_refuted claim, got: ${JSON.stringify(refutes)}`,
      );
    });

    it('counter-example 3: report carrying multiple verdicts is refuted with multiple_verdicts', async () => {
      const indepReceipt = await receiptOf(independentRun.run);
      const reportStart = await client.call('start_run', {
        pack: 'case-review-report',
        inputs: {
          verifications: [{ reference: `rec:${indepReceipt}` }],
          target: { external: `agile:mindmap:${DOCUMENTS.review}` },
        },
      });
      const reportRun = reportStart.out.run as RunSummary;

      const submitRes = await client.call('submit_result', {
        run: reportRun.run,
        model: REPORTER,
        items: reportRun.items.map((it) => ({ item: it.id, handling: 'handled', slots: {} })),
        cross_item: [
          { nature: 'judgment', statement: '结论 1', grounds: [], code: 'PARTIAL', rank: 'P4' },
          { nature: 'judgment', statement: '多余的结论 2', grounds: [], code: 'PASS', rank: 'P4' },
        ],
      });
      assert.equal(submitRes.isError, false);
      const refutes = submitRes.out.result?.cross_item.filter((c) => c.statement.verdict === 'refute') ?? [];
      assert.ok(
        refutes.some((c) => c.statement.code === 'case-review-report.multiple_verdicts'),
        `expected multiple_verdicts refutation, got: ${JSON.stringify(refutes)}`,
      );
    });
  });
});

describe('T1-1 知识问答只给根引用核对（A6）', () => {
  it('resolves citations against root alone and refuses tampered and alien root citations', async () => {
    const sync = bed.syncs.two;
    assert.ok(sync && sync.builds.length > 0);
    const rootL = sync.builds.find((b) => b.root !== null)!.root!;

    // 1. Resolve command literal against root
    const resCmd = await client.call('resolve_reference', {
      root: rootL,
      text: 'show health',
      expect: 'command',
    });
    assert.equal(resCmd.isError, false);
    assert.equal(resCmd.out.call_result, 'ok');
    assert.equal(resCmd.out.resolution, 'resolved');
    assert.ok(resCmd.out.references.some((r: any) => r.reference.startsWith(`tree:${rootL}/commands/`)));

    // 2. Tampered / nonexistent command fails resolution
    const resTampered = await client.call('resolve_reference', {
      root: rootL,
      text: 'nonexistent_command_name_xyz',
      expect: 'command',
    });
    assert.equal(resTampered.isError, false);
    assert.equal(resTampered.out.resolution, 'unresolved');

    // 3. Verbatim manual quote resolves, and single character alteration fails
    const secondSync = bed.syncs.one;
    assert.ok(secondSync && secondSync.builds.length > 0);
    const secondRoot = secondSync.builds.find((b) => b.root !== null)?.root;
    assert.ok(secondRoot);

    const manualQuote = '列出池，按名称排序。';
    const resManual = await adminClient.call('resolve_reference', {
      root: secondRoot,
      text: manualQuote,
      expect: 'quotation',
    });
    assert.equal(resManual.isError, false);
    assert.equal(resManual.out.resolution, 'resolved');

    const resTamperedQuote = await adminClient.call('resolve_reference', {
      root: secondRoot,
      text: '列出池，按名称排序！',
      expect: 'quotation',
    });
    assert.equal(resTamperedQuote.isError, false);
    assert.equal(resTamperedQuote.out.resolution, 'unresolved');

    // 4. Alien root fails resolution with SOURCE_UNAVAILABLE
    const alienRoot = '1'.repeat(64);
    const resAlien = await client.call('resolve_reference', {
      root: alienRoot,
      text: 'show health',
      expect: 'command',
    });
    assert.equal(resAlien.isError, true);
    assert.equal(resAlien.out.errors[0].code, 'SOURCE_UNAVAILABLE');

    // 5. Schema error when neither root nor run is provided
    const neither = await client.call('resolve_reference', {
      text: 'show health',
    });
    assert.equal(neither.isError, true);
    assert.equal(neither.out.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');

    // 6. Schema error when both root and run are provided
    const both = await client.call('resolve_reference', {
      root: rootL,
      run: 'run-00000000',
      text: 'show health',
    });
    assert.equal(both.isError, true);
    assert.equal(both.out.errors[0].code, 'SUBMISSION_SCHEMA_VIOLATION');
  });
});

describe('T2-3 / T2-4 / T2-5 / T2-6 平台事实反例与边界', () => {
  it('T2-3 defect-to-case: missing fix statement in defect exits with missing_fix_field request', async () => {
    const res = await client.call('start_run', {
      pack: 'defect-to-case',
      product: 'famx',
      build: 'Rel_FAMX_10_6_1_57',
      inputs: {
        defects: [{ external: 'plm:bug:31057' }],
        indexed_cases: {
          external:
            'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure',
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'defect-to-case.missing_fix_field'),
      JSON.stringify(res.out.errors),
    );
  });

  it('T2-4 traceability: rejects when defect index has no defect IDs with SUBMISSION_SCHEMA_VIOLATION', async () => {
    const res = await client.call('start_run', {
      pack: 'traceability',
      inputs: {
        defects: {
          external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=defect&key=bug',
        },
        cases: {
          external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=defects',
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION' && e.message.includes('缺陷索引没有编号')),
      JSON.stringify(res.out.errors),
    );
  });

  it('T2-5 story-traceability: undetermined story ID is rejected individually with remedy', async () => {
    const res = await client.call('start_run', {
      pack: 'story-traceability',
      inputs: {
        stories: [{ external: 'plm:stories:99999' }],
        cases: {
          external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=stories',
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'story-traceability.invalid_input'),
      JSON.stringify(res.out.errors),
    );
    assert.ok(res.text.includes('去掉无法确定的编号 99999'));
  });

  it('T2-6 quality-board: build root without cases exits with quality-board.no_cases', async () => {
    const res = await client.call('start_run', {
      pack: 'quality-board',
      inputs: {
        facets: {
          external:
            'knowledge:facets:famx:Rel_FAMX_10_6_1_57?kind=case&by=line,module,has_expected,negative,test_type_status',
        },
        placement: {
          external: 'knowledge:facets:famx:Rel_FAMX_10_6_1_57?kind=case&by=commands',
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'quality-board.no_cases'),
      JSON.stringify(res.out.errors),
    );
  });
});

describe('T3-1 / T3-2 影响视图残缺目录启动期被拒', () => {
  const BUILD_A = 'Rel_FAMX_10_6_1_57';
  const BUILD_B = 'Rel_FAMX_10_6_1_57';

  it('T3-1 regression-scope: impact view without catalog=commands@1 is rejected at start_run', async () => {
    const res = await client.call('start_run', {
      pack: 'regression-scope',
      inputs: {
        impact: {
          external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=definition&attached=case&attached_fields=document,node,title,priority,negative`,
        },
        facets: {
          external: `knowledge:facets:famx:${BUILD_B}?kind=case&by=commands`,
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'regression-scope.catalog'),
      `expected regression-scope.catalog, got: ${JSON.stringify(res.out.errors)}`,
    );
  });

  it('T3-1 regression-scope: impact view with foreign catalog (catalog=behaviour@1) is rejected at start_run', async () => {
    const res = await client.call('start_run', {
      pack: 'regression-scope',
      inputs: {
        impact: {
          external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=behaviour@1`,
        },
        facets: {
          external: `knowledge:facets:famx:${BUILD_B}?kind=case&by=commands`,
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'regression-scope.catalog' || e.code === 'SOURCE_UNAVAILABLE'),
      `expected regression-scope.catalog or SOURCE_UNAVAILABLE, got: ${JSON.stringify(res.out.errors)}`,
    );
  });

  it('T3-2 maintenance-sweep: impact view without catalog=commands@1 is rejected at start_run', async () => {
    const res = await client.call('start_run', {
      pack: 'maintenance-sweep',
      inputs: {
        impact: {
          external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=definition&attached=case&attached_fields=document,node,title`,
        },
        facets: {
          external: `knowledge:facets:famx:${BUILD_A}?kind=case&by=commands`,
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'maintenance-sweep.catalog'),
      `expected maintenance-sweep.catalog, got: ${JSON.stringify(res.out.errors)}`,
    );
  });

  it('T3-2 maintenance-sweep: impact view with foreign catalog (catalog=behaviour@1) is rejected at start_run', async () => {
    const res = await client.call('start_run', {
      pack: 'maintenance-sweep',
      inputs: {
        impact: {
          external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=definition&attached=case&attached_fields=document,node,title&catalog=behaviour@1`,
        },
        facets: {
          external: `knowledge:facets:famx:${BUILD_A}?kind=case&by=commands`,
        },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'maintenance-sweep.catalog' || e.code === 'SOURCE_UNAVAILABLE'),
      `expected maintenance-sweep.catalog or SOURCE_UNAVAILABLE, got: ${JSON.stringify(res.out.errors)}`,
    );
  });
});

describe('T2-2 按编号读原件 (source-read) 全部反例', () => {
  it('counter-example 1: non-existent ID fails with SOURCE_ABSENT / SOURCE_UNAVAILABLE', async () => {
    const res = await client.call('start_run', {
      pack: 'source-read',
      inputs: {
        defect: { external: 'plm:bug:99999999' },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'SOURCE_ABSENT' || e.code === 'SOURCE_UNAVAILABLE'),
      JSON.stringify(res.out.errors),
    );
  });

  it('counter-example 2: undeclared route or unsupported object type is rejected with schema error', async () => {
    const res = await client.call('start_run', {
      pack: 'source-read',
      inputs: {
        defect: { external: 'unknown:route:123' },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some(
        (e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION' || e.code === 'OBJECT_TYPE_UNSUPPORTED',
      ),
      JSON.stringify(res.out.errors),
    );
  });

  it('counter-example 3: empty inputs is rejected with source-read.no_source', async () => {
    const res = await client.call('start_run', {
      pack: 'source-read',
      inputs: {},
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'source-read.no_source'),
      JSON.stringify(res.out.errors),
    );
  });

  it('counter-example 4: malformed external ID syntax is rejected with schema error', async () => {
    const res = await client.call('start_run', {
      pack: 'source-read',
      inputs: {
        defect: { external: 'plm:bug' },
      },
    });
    assert.equal(res.out.call_result, 'error');
    assert.ok(
      res.out.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION'),
      JSON.stringify(res.out.errors),
    );
  });

  it('counter-example 5: stopped/unreachable platform gives retryable error with next-step and no host leak', async () => {
    const plm = bed.plmStub;
    assert.ok(plm);
    await plm.close();

    const res = await client.call('start_run', {
      pack: 'source-read',
      inputs: {
        defect: { external: 'plm:bug:31057' },
      },
    });
    assert.equal(res.out.call_result, 'error');
    const err = res.out.errors.find((e) => e.code === 'SOURCE_RETRYABLE' || e.code === 'SOURCE_UNREACHABLE');
    assert.ok(err, JSON.stringify(res.out.errors));
    assert.match(err.message, /连不上来源/);
    assert.ok(err.fix && err.fix.includes('重新开始'), 'error provides corrective next step');
    assert.equal(/192\.0\.2|127\.0\.0\.1/.test(res.text), false, 'no host address leaked in error text');
  });
});
