// Tests for scripts/real/accept/template-gap-metamorphic.ts:
// - cleanNodeId & extractGapResult (JSON and text formats)
// - Replica 1: deletes covering cases, keeps other nodes, node IDs preserved
// - Replica 2: restores one case, preserves ID and subtree, other cases still deleted
// - Replica 3: reverses sibling nodes at each level, preserves all node IDs and data
// - evaluateReplicaChecks: positive cases (all 5 checks pass)
// - evaluateReplicaChecks: negative cases (R1 still present, R1 other changed, R2 missing, R3 summary mismatch, R3 missing mismatch)
// - runMetamorphicCheck: end-to-end flow with mock ToolCaller (upload_file + start_run)
// - CLI main: error handling on missing arguments
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolText } from '../hub-call.ts';
import {
  cleanNodeId,
  createReplicaWithRestoredNode,
  createReplicaWithReversedSiblings,
  createReplicaWithoutCategory,
  evaluateReplicaChecks,
  extractGapResult,
  main,
  parseGapTextResult,
  runMetamorphicCheck,
  type HubGapResult,
  type KityMinderDoc,
  type ToolCaller,
} from './template-gap-metamorphic.ts';

function makeSyntheticMindmap(): KityMinderDoc {
  return {
    root: {
      data: { id: 'root01', text: '小部件探测测试用例' },
      children: [
        {
          data: { id: 'grp_func', text: '基本功能', priority: 1 },
          children: [
            {
              data: { id: 'c_func_1', text: '设置探测间隔', priority: 2, resource: ['Function'] },
              children: [
                { data: { id: 'step_1_1', text: '输入间隔 5 秒' }, children: [] },
                { data: { id: 'exp_1_1', text: '间隔生效' }, children: [] },
              ],
            },
            {
              data: { id: 'c_func_2', text: '设置重试次数', priority: 2, resource: ['Function'] },
              children: [{ data: { id: 'exp_2_1', text: '重试生效' }, children: [] }],
            },
          ],
        },
        {
          data: { id: 'grp_cfg', text: '配置管理', priority: 1 },
          children: [
            {
              data: { id: 'c_cfg_1', text: '修改端口', priority: 2, resource: ['Configuration'] },
              children: [{ data: { id: 'exp_3_1', text: '端口生效' }, children: [] }],
            },
          ],
        },
      ],
    },
    template: 'right',
    theme: 'classic',
    version: '1.4.43',
  };
}

describe('template-gap-metamorphic', () => {
  describe('cleanNodeId & extractGapResult', () => {
    it('cleanNodeId extracts bare node ID from various formats', () => {
      assert.equal(cleanNodeId('upload-81aa5650aa4a:0j9mbggwjytw'), '0j9mbggwjytw');
      assert.equal(cleanNodeId('900001:k7kd4d8qddqg'), 'k7kd4d8qddqg');
      assert.equal(cleanNodeId('k7kd4d8qddqg#1'), 'k7kd4d8qddqg');
      assert.equal(cleanNodeId('upload-123:c_func_1#2'), 'c_func_1');
      assert.equal(cleanNodeId('bare_node_id'), 'bare_node_id');
    });

    it('extractGapResult parses JSON result with item.fields.categories', () => {
      const json = {
        item: {
          id: 'upload-81aa5650aa4a',
          summary: '用例 66 个；缺 1 个模板类别：压力测试（stress）；模板类别出现 23/24 个',
          fields: {
            categories: [
              {
                id: 'functional',
                label: '功能测试',
                present: true,
                count: 2,
                evidence: ['upload-81aa5650aa4a:c_func_1', 'upload-81aa5650aa4a:c_func_2'],
              },
              {
                id: 'stress',
                label: '压力测试',
                present: false,
                count: 0,
                evidence: [],
              },
            ],
            missing: ['stress'],
          },
        },
      };

      const res = extractGapResult(json);
      assert.equal(res.documentId, 'upload-81aa5650aa4a');
      assert.equal(res.categories.length, 2);
      assert.equal(res.categories[0].id, 'functional');
      assert.equal(res.categories[0].present, true);
      assert.equal(res.categories[0].count, 2);
      assert.deepEqual(res.categories[0].evidence, [
        'upload-81aa5650aa4a:c_func_1',
        'upload-81aa5650aa4a:c_func_2',
      ]);
      assert.deepEqual(res.missing, ['stress']);
      assert.match(res.summary ?? '', /缺 1 个模板类别：压力测试（stress）/);
    });

    it('parseGapTextResult parses plain text start_run output', () => {
      const text = [
        '运行 run_0123456789abcdef0123456789：任务包 template-gap',
        '条目（1 个）：',
        '- upload-81aa5650aa4a | 小部件探测 | 用例 66 个；缺 1 个模板类别：压力测试（stress）；模板类别出现 23/24 个',
        '问题与未知：没有',
      ].join('\n');

      const res = parseGapTextResult(text);
      assert.deepEqual(res.missing, ['stress']);
      assert.match(res.summary ?? '', /用例 66 个/);
    });
  });

  describe('replica generation', () => {
    it('Replica 1 deletes covering case nodes and their subtrees while preserving other node IDs and properties', () => {
      const doc = makeSyntheticMindmap();
      const nodeIdsToRemove = new Set(['c_func_1', 'c_func_2']);

      const { replica, removedNodes } = createReplicaWithoutCategory(doc, nodeIdsToRemove);

      // 1. Two case nodes were removed
      assert.equal(removedNodes.length, 2);
      assert.equal(removedNodes[0].node.data.id, 'c_func_1');
      assert.equal(removedNodes[0].parentId, 'grp_func');
      assert.equal(removedNodes[1].node.data.id, 'c_func_2');
      assert.equal(removedNodes[1].parentId, 'grp_func');

      // 2. In replica, grp_func.children is empty, c_cfg_1 is untouched
      const grpFunc = replica.root.children.find((c) => c.data.id === 'grp_func')!;
      assert.equal(grpFunc.children.length, 0);

      const grpCfg = replica.root.children.find((c) => c.data.id === 'grp_cfg')!;
      assert.equal(grpCfg.children.length, 1);
      assert.equal(grpCfg.children[0].data.id, 'c_cfg_1');
      assert.equal(grpCfg.children[0].data.text, '修改端口');
      assert.equal(grpCfg.children[0].children[0].data.id, 'exp_3_1');

      // 3. Root and group IDs are completely unchanged
      assert.equal(replica.root.data.id, 'root01');
      assert.equal(replica.root.children[0].data.id, 'grp_func');
      assert.equal(replica.root.children[1].data.id, 'grp_cfg');

      // 4. Original doc is not mutated
      assert.equal(doc.root.children[0].children.length, 2);
    });

    it('Replica 2 restores one case node with exact ID and subtree structure, keeping other cases deleted', () => {
      const doc = makeSyntheticMindmap();
      const nodeIdsToRemove = new Set(['c_func_1', 'c_func_2']);
      const { replica: replica1, removedNodes } = createReplicaWithoutCategory(doc, nodeIdsToRemove);

      // Restore first case node (c_func_1)
      const replica2 = createReplicaWithRestoredNode(replica1, removedNodes[0]);

      const grpFunc = replica2.root.children.find((c) => c.data.id === 'grp_func')!;
      assert.equal(grpFunc.children.length, 1);

      // c_func_1 is restored with its subchildren
      const restoredCase = grpFunc.children[0];
      assert.equal(restoredCase.data.id, 'c_func_1');
      assert.equal(restoredCase.data.text, '设置探测间隔');
      assert.deepEqual(restoredCase.data.resource, ['Function']);
      assert.equal(restoredCase.children.length, 2);
      assert.equal(restoredCase.children[0].data.id, 'step_1_1');
      assert.equal(restoredCase.children[1].data.id, 'exp_1_1');

      // c_func_2 is STILL deleted
      assert.ok(!grpFunc.children.some((c) => c.data.id === 'c_func_2'));

      // Other groups untouched
      const grpCfg = replica2.root.children.find((c) => c.data.id === 'grp_cfg')!;
      assert.equal(grpCfg.children.length, 1);
      assert.equal(grpCfg.children[0].data.id, 'c_cfg_1');

      // Replica 1 was not mutated
      assert.equal(replica1.root.children[0].children.length, 0);
    });

    it('Replica 3 reverses sibling nodes at every level while leaving all IDs and contents unchanged', () => {
      const doc = makeSyntheticMindmap();
      const replica3 = createReplicaWithReversedSiblings(doc);

      // 1. Root level: grp_func, grp_cfg -> reversed to grp_cfg, grp_func
      assert.equal(replica3.root.children.length, 2);
      assert.equal(replica3.root.children[0].data.id, 'grp_cfg');
      assert.equal(replica3.root.children[1].data.id, 'grp_func');

      // 2. Group level inside grp_func: c_func_1, c_func_2 -> reversed to c_func_2, c_func_1
      const reversedGrpFunc = replica3.root.children[1];
      assert.equal(reversedGrpFunc.children[0].data.id, 'c_func_2');
      assert.equal(reversedGrpFunc.children[1].data.id, 'c_func_1');

      // 3. Subchild level inside c_func_1: step_1_1, exp_1_1 -> reversed to exp_1_1, step_1_1
      const reversedCase1 = reversedGrpFunc.children[1];
      assert.equal(reversedCase1.children[0].data.id, 'exp_1_1');
      assert.equal(reversedCase1.children[1].data.id, 'step_1_1');

      // 4. All node texts and properties are untouched
      assert.equal(reversedCase1.data.text, '设置探测间隔');
      assert.deepEqual(reversedCase1.data.resource, ['Function']);

      // 5. Original doc is not mutated
      assert.equal(doc.root.children[0].data.id, 'grp_func');
    });
  });

  describe('evaluateReplicaChecks (positive and negative)', () => {
    const origResult: HubGapResult = {
      summary: '用例 3 个；缺 1 个模板类别：压力测试（stress）；模板类别出现 2/3 个',
      missing: ['stress'],
      categories: [
        { id: 'functional', label: '功能测试', present: true, count: 2, evidence: ['c_func_1', 'c_func_2'] },
        { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
        { id: 'stress', label: '压力测试', present: false, count: 0, evidence: [] },
      ],
    };

    it('positive case: passes all 5 checks when metamorphic relations hold', () => {
      // R1: functional is missing (缺), configuration still present, stress still missing
      const r1Result: HubGapResult = {
        summary: '用例 1 个；缺 2 个模板类别：功能测试（functional）、压力测试（stress）',
        missing: ['functional', 'stress'],
        categories: [
          { id: 'functional', label: '功能测试', present: false, count: 0, evidence: [] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
          { id: 'stress', label: '压力测试', present: false, count: 0, evidence: [] },
        ],
      };

      // R2: functional restored to present (有)
      const r2Result: HubGapResult = {
        summary: '用例 2 个；缺 1 个模板类别：压力测试（stress）',
        missing: ['stress'],
        categories: [
          { id: 'functional', label: '功能测试', present: true, count: 1, evidence: ['c_func_1'] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
          { id: 'stress', label: '压力测试', present: false, count: 0, evidence: [] },
        ],
      };

      // R3: reversed order produces identical summary and identical missing list
      const r3Result: HubGapResult = {
        summary: '用例 3 个；缺 1 个模板类别：压力测试（stress）；模板类别出现 2/3 个',
        missing: ['stress'],
        categories: origResult.categories,
      };

      const checks = evaluateReplicaChecks({
        categoryId: 'functional',
        categoryLabel: '功能测试',
        origResult,
        r1Result,
        r2Result,
        r3Result,
        removedCount: 2,
        restoredNodeId: 'c_func_1',
      });

      assert.equal(checks.length, 5);
      for (const c of checks) {
        assert.equal(c.ok, true, `Check should pass: ${c.name} - ${c.actual}`);
      }
    });

    it('negative case: fails check 1a if category is still present in Replica 1', () => {
      const r1Result: HubGapResult = {
        missing: ['stress'],
        categories: [
          { id: 'functional', label: '功能测试', present: true, count: 1, evidence: ['c_func_1'] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
        ],
      };
      const r2Result = origResult;
      const r3Result = origResult;

      const checks = evaluateReplicaChecks({
        categoryId: 'functional',
        categoryLabel: '功能测试',
        origResult,
        r1Result,
        r2Result,
        r3Result,
        removedCount: 2,
        restoredNodeId: 'c_func_1',
      });

      const check1a = checks.find((c) => c.name.includes('副本 1 类别缺失'))!;
      assert.equal(check1a.ok, false);
      assert.match(check1a.actual, /仍为存在/);
    });

    it('negative case: fails check 1b if another category changes presence in Replica 1', () => {
      const r1Result: HubGapResult = {
        missing: ['functional', 'configuration', 'stress'],
        categories: [
          { id: 'functional', label: '功能测试', present: false, count: 0, evidence: [] },
          // configuration unexpectedly became false!
          { id: 'configuration', label: '配置测试', present: false, count: 0, evidence: [] },
        ],
      };
      const r2Result = origResult;
      const r3Result = origResult;

      const checks = evaluateReplicaChecks({
        categoryId: 'functional',
        categoryLabel: '功能测试',
        origResult,
        r1Result,
        r2Result,
        r3Result,
        removedCount: 2,
        restoredNodeId: 'c_func_1',
      });

      const check1b = checks.find((c) => c.name.includes('副本 1 其余类别保持不变'))!;
      assert.equal(check1b.ok, false);
      assert.match(check1b.actual, /其余类别存在变化/);
    });

    it('negative case: fails check 2 if category is still missing in Replica 2', () => {
      const r1Result: HubGapResult = {
        missing: ['functional'],
        categories: [
          { id: 'functional', label: '功能测试', present: false, count: 0, evidence: [] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
        ],
      };
      // Replica 2 failed to restore functional
      const r2Result: HubGapResult = {
        missing: ['functional'],
        categories: [
          { id: 'functional', label: '功能测试', present: false, count: 0, evidence: [] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
        ],
      };
      const r3Result = origResult;

      const checks = evaluateReplicaChecks({
        categoryId: 'functional',
        categoryLabel: '功能测试',
        origResult,
        r1Result,
        r2Result,
        r3Result,
        removedCount: 2,
        restoredNodeId: 'c_func_1',
      });

      const check2 = checks.find((c) => c.name.includes('副本 2 恢复存在'))!;
      assert.equal(check2.ok, false);
      assert.match(check2.actual, /仍为缺失/);
    });

    it('negative case: fails check 3a if Replica 3 summary differs from original', () => {
      const r1Result: HubGapResult = {
        missing: ['functional'],
        categories: [
          { id: 'functional', label: '功能测试', present: false, count: 0, evidence: [] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
        ],
      };
      const r2Result = origResult;
      // Replica 3 has a different summary
      const r3Result: HubGapResult = {
        summary: '用例 2 个；缺 2 个模板类别：异常用例（negative）',
        missing: ['stress'],
        categories: origResult.categories,
      };

      const checks = evaluateReplicaChecks({
        categoryId: 'functional',
        categoryLabel: '功能测试',
        origResult,
        r1Result,
        r2Result,
        r3Result,
        removedCount: 2,
        restoredNodeId: 'c_func_1',
      });

      const check3a = checks.find((c) => c.name.includes('副本 3 条目摘要相同'))!;
      assert.equal(check3a.ok, false);
      assert.match(check3a.actual, /摘要不一致/);
    });

    it('negative case: fails check 3b if Replica 3 report/missing categories differ', () => {
      const r1Result: HubGapResult = {
        missing: ['functional'],
        categories: [
          { id: 'functional', label: '功能测试', present: false, count: 0, evidence: [] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
        ],
      };
      const r2Result = origResult;
      // Replica 3 has extra missing categories
      const r3Result: HubGapResult = {
        summary: origResult.summary,
        missing: ['stress', 'database'],
        categories: origResult.categories,
      };

      const checks = evaluateReplicaChecks({
        categoryId: 'functional',
        categoryLabel: '功能测试',
        origResult,
        r1Result,
        r2Result,
        r3Result,
        removedCount: 2,
        restoredNodeId: 'c_func_1',
      });

      const check3b = checks.find((c) => c.name.includes('副本 3 查缺报告相同'))!;
      assert.equal(check3b.ok, false);
      assert.match(check3b.actual, /查缺报告判定不一致/);
    });
  });

  describe('runMetamorphicCheck with mock Hub caller', () => {
    it('executes upload_file and start_run for 3 replicas and compiles a passing report', async () => {
      const doc = makeSyntheticMindmap();
      const origResult: HubGapResult = {
        documentId: 'upload-900001',
        summary: '用例 3 个；缺 1 个模板类别：压力测试（stress）；模板类别出现 2/3 个',
        missing: ['stress'],
        categories: [
          { id: 'functional', label: '功能测试', present: true, count: 2, evidence: ['c_func_1', 'c_func_2'] },
          { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
          { id: 'stress', label: '压力测试', present: false, count: 0, evidence: [] },
        ],
      };

      const uploadedFiles: Array<{ base64: string; mediaType: string }> = [];
      const runCalls: Array<{ pack: string; reference: string }> = [];
      let uploadCount = 0;

      const mockCaller: ToolCaller = async (calls) => {
        const out: ToolText[] = [];
        for (const call of calls) {
          if (call.tool === 'upload_file') {
            uploadCount++;
            const args = call.args as { file_path: string; media_type: string };
            uploadedFiles.push({ base64: args.file_path, mediaType: args.media_type });
            const ref = `src:${String(uploadCount).padStart(64, 'a')}`;
            out.push({
              isError: false,
              text: `受理：已受理，引用 ${ref}，大小 1024 字节`,
              structured: { reference: ref },
            });
          } else if (call.tool === 'start_run') {
            const args = call.args as { pack: string; inputs: { documents: { reference: string } } };
            runCalls.push({ pack: args.pack, reference: args.inputs.documents.reference });

            // Simulate responses based on upload order:
            // Upload 1: Replica 3 (reversed siblings)
            // Upload 2: Replica 1 for functional (functional missing)
            // Upload 3: Replica 2 for functional (functional restored)
            // Upload 4: Replica 1 for configuration
            // Upload 5: Replica 2 for configuration
            let simulatedResult: HubGapResult;
            if (uploadCount === 1) {
              // Replica 3: identical to original
              simulatedResult = origResult;
            } else if (uploadCount === 2) {
              // Replica 1 for functional
              simulatedResult = {
                summary: '用例 1 个；缺 2 个模板类别：功能测试（functional）、压力测试（stress）',
                missing: ['functional', 'stress'],
                categories: [
                  { id: 'functional', label: '功能测试', present: false, count: 0, evidence: [] },
                  { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
                  { id: 'stress', label: '压力测试', present: false, count: 0, evidence: [] },
                ],
              };
            } else if (uploadCount === 3) {
              // Replica 2 for functional
              simulatedResult = {
                summary: '用例 2 个；缺 1 个模板类别：压力测试（stress）',
                missing: ['stress'],
                categories: [
                  { id: 'functional', label: '功能测试', present: true, count: 1, evidence: ['c_func_1'] },
                  { id: 'configuration', label: '配置测试', present: true, count: 1, evidence: ['c_cfg_1'] },
                  { id: 'stress', label: '压力测试', present: false, count: 0, evidence: [] },
                ],
              };
            } else if (uploadCount === 4) {
              // Replica 1 for configuration
              simulatedResult = {
                summary: '用例 2 个；缺 2 个模板类别：配置测试（configuration）、压力测试（stress）',
                missing: ['configuration', 'stress'],
                categories: [
                  { id: 'functional', label: '功能测试', present: true, count: 2, evidence: ['c_func_1', 'c_func_2'] },
                  { id: 'configuration', label: '配置测试', present: false, count: 0, evidence: [] },
                  { id: 'stress', label: '压力测试', present: false, count: 0, evidence: [] },
                ],
              };
            } else {
              // Replica 2 for configuration
              simulatedResult = origResult;
            }

            out.push({
              isError: false,
              text: `运行 run_${uploadCount} 完成：${simulatedResult.summary}`,
              structured: {
                item: {
                  summary: simulatedResult.summary,
                  fields: {
                    categories: simulatedResult.categories,
                    missing: simulatedResult.missing,
                  },
                },
              },
            });
          }
        }
        return out;
      };

      const report = await runMetamorphicCheck(doc, origResult, mockCaller, { maxCategories: 2 });

      // Verifications:
      // 1. Two categories tested: functional, configuration
      assert.deepEqual(report.categoriesTested, ['functional', 'configuration']);

      // 2. 5 checks per category = 10 checks total
      assert.equal(report.checks.length, 10);
      assert.equal(report.summary.total, 10);
      assert.equal(report.summary.passed, 10);
      assert.equal(report.summary.failed, 0);

      // 3. Uploaded files used application/json
      assert.equal(uploadedFiles.length, 5);
      for (const up of uploadedFiles) {
        assert.equal(up.mediaType, 'application/json');
        const parsed = JSON.parse(Buffer.from(up.base64, 'base64').toString('utf8')) as KityMinderDoc;
        assert.ok(parsed.root);
      }

      // 4. Start run calls were for template-gap
      assert.equal(runCalls.length, 5);
      for (const rc of runCalls) {
        assert.equal(rc.pack, 'template-gap');
        assert.match(rc.reference, /^src:[0-9a-f]{64}$/);
      }

      // 5. Rendered markdown report
      assert.match(report.markdown, /# 模板查缺真实文档蜕变核对报告/);
      assert.match(report.markdown, /共 10 项核对，10 项相符，0 项不符/);
      assert.match(report.markdown, /\| 核对 \| 预期（独立依据） \| 实际 \| 结果 \| 依据 \|/);
      assert.match(report.markdown, /类别 functional（功能测试）：副本 1 类别缺失/);
      assert.match(report.markdown, /类别 functional（功能测试）：副本 2 恢复存在/);
      assert.match(report.markdown, /类别 functional（功能测试）：副本 3 条目摘要相同/);
      assert.match(report.markdown, /类别 configuration（配置测试）：副本 1 类别缺失/);
    });

    it('returns clear report when no categories are present to test', async () => {
      const doc = makeSyntheticMindmap();
      const emptyResult: HubGapResult = {
        summary: '用例 0 个',
        categories: [],
        missing: ['functional', 'configuration', 'stress'],
      };

      const mockCaller: ToolCaller = async () => [];
      const report = await runMetamorphicCheck(doc, emptyResult, mockCaller);

      assert.equal(report.categoriesTested.length, 0);
      assert.equal(report.summary.failed, 1);
      assert.match(report.markdown, /没有标为“有”的类别/);
    });
  });

  describe('CLI main', () => {
    it('returns code 2 on missing required arguments', async () => {
      const code = await main([]);
      assert.equal(code, 2);
    });

    it('returns code 2 when token argument is missing', async () => {
      const code = await main(['--mindmap', 'test.json', '--result', 'res.json']);
      assert.equal(code, 2);
    });
  });
});
