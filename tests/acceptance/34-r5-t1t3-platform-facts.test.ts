// Acceptance test 34: T2 Platform Facts (平台事实)
// Covers:
// - T2-1 用例定位 (case-location): 正常定位提取产品、版本线、发布火车、模块、构建候选，反例声明冲突
// - T2-2 按编号读原件 (source-read): 读各类系统路由原件、检验原件引用、反例编号不存在/路由未声明/空输入
// - T2-3 缺陷转用例 (defect-to-case): 启动运行对账缺陷修复与索引
// - T2-4 追溯矩阵 (traceability) & T2-5 需求追溯矩阵 (story-traceability): 缺陷用例对账与需求命中
// - T2-6 质量看板 (quality-board): 指标分组统计与阈值越界提示档
//
// Synthetic fixtures only: product FAMX/FAMY (two-name) and lumen-api (one-name).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { DOCUMENTS } from '../fixtures/agile/index.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: false });
  // Assign workflow packs to reviewer
  for (const pack of ['case-location', 'source-read', 'defect-to-case', 'traceability', 'story-traceability', 'quality-board']) {
    await bed.hub.assignPack(bed.reviewer.principal, pack);
  }
  client = await bed.connect(bed.reviewer, 'session-platform-facts');
});

after(async () => {
  await client?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('T2 平台事实端到端验收', () => {
  describe('T2-1 用例定位 (case-location)', () => {
    it('locates mind map document into product line, version, train, module, and build candidates', async () => {
      const res = await client.call('start_run', {
        pack: 'case-location',
        product: 'FAMX',
        inputs: {
          documents: [{ external: `agile:mindmap:${DOCUMENTS.review}` }],
        },
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.out.call_result, 'ok');
      const run = res.out.run!;
      assert.equal(run.product, 'famx');

      // The production run directly evaluates facts and returns result
      const prodResult = res.out.result;
      assert.ok(prodResult, 'produced validation result at start_run');
      assert.ok(prodResult.counts.delivered > 0);

      // Read the full validation result record via get_nodes
      const nodeRes = await client.call('get_nodes', { reference: prodResult.reference });
      assert.equal(nodeRes.isError, false, nodeRes.text);
      assert.ok(nodeRes.out.content?.text);
      const full = JSON.parse(nodeRes.out.content.text);
      assert.equal(full.acceptance, 'accepted');

      // Verify location claim data
      const item = full.partitions.delivered[0];
      const locReq = item.requirements.find((r: { requirement: string }) => r.requirement === 'location');
      assert.ok(locReq && locReq.claims.length > 0);
      const locData = locReq.claims[0].statement.data as Record<string, unknown>;
      assert.equal(locData.line, '7.1');
      assert.ok(locData.train);
      assert.ok(locData.module);

      // Verify candidates requirement
      const candReq = item.requirements.find((r: { requirement: string }) => r.requirement === 'build_candidates');
      assert.ok(candReq && candReq.claims.length > 0);
      const candData = candReq.claims[0].statement.data as { kind: string; candidates: Array<{ name: string }> };
      assert.equal(candData.kind, 'candidates');
      assert.ok(Array.isArray(candData.candidates), 'lists build candidates array');
    });

    it('counter-example: parameter line conflicting with directory results in advisory violation', async () => {
      const res = await client.call('start_run', {
        pack: 'case-location',
        product: 'FAMX',
        inputs: {
          documents: [{ external: `agile:mindmap:${DOCUMENTS.review}` }],
        },
        parameters: { line: '10.7.3' },
      });
      assert.equal(res.isError, false);
      const prodResult = res.out.result;
      assert.ok(prodResult);
      const nodeRes = await client.call('get_nodes', { reference: prodResult.reference });
      assert.equal(nodeRes.isError, false);
      const full = JSON.parse(nodeRes.out.content!.text!);
      const delivered = full.partitions.delivered;
      const conflictItem = delivered.find((it: { requirements: Array<{ layers: Array<{ code?: string }> }> }) =>
        it.requirements.some((r) => r.layers.some((l) => l.code === 'case-location.declaration_conflict')),
      );
      assert.ok(conflictItem, 'found conflict advisory violation in location claims');
    });
  });

  describe('T2-2 按编号读原件 (source-read)', () => {
    it('reads external objects across systems, returns original references src:<sha256>, and supports get_nodes retrieval', async () => {
      const res = await client.call('start_run', {
        pack: 'source-read',
        inputs: {
          defect: { external: 'plm:bug:31057' },
          story: { external: 'plm:story:31057' },
          manual_file: { external: 'manual:file:spec/TTLOG模式说明.md' },
        },
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.out.call_result, 'ok');
      const run = res.out.run!;
      assert.equal(run.sources.length, 3);

      for (const src of run.sources) {
        assert.ok(src.reference.startsWith('src:'), `reference ${src.reference} starts with src:`);
        assert.equal(src.role, 'subject');
        // Read raw original bytes through get_nodes
        const nodeRes = await client.call('get_nodes', { reference: src.reference });
        assert.equal(nodeRes.isError, false, nodeRes.text);
        assert.ok(nodeRes.out.content?.readable, 'original content is readable');
        assert.ok(nodeRes.out.content?.text !== undefined || nodeRes.out.content?.structure !== undefined, 'original content has text or structure');
      }
    });

    it('counter-example 1: non-existent ID fails start_run with SOURCE_ABSENT / SOURCE_UNAVAILABLE', async () => {
      const res = await client.call('start_run', {
        pack: 'source-read',
        inputs: {
          defect: { external: 'plm:bug:99999999' },
        },
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => e.code === 'SOURCE_ABSENT' || e.code === 'SOURCE_UNAVAILABLE'));
    });

    it('counter-example 2: undeclared route / external type is rejected with SUBMISSION_SCHEMA_VIOLATION', async () => {
      const res = await client.call('start_run', {
        pack: 'source-read',
        inputs: {
          defect: { external: 'unknown:entity:123' },
        },
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION' || e.code === 'OBJECT_TYPE_UNSUPPORTED'));
    });

    it('counter-example 3: empty inputs is rejected with source-read.no_source', async () => {
      const res = await client.call('start_run', {
        pack: 'source-read',
        inputs: {},
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => e.code === 'source-read.no_source'));
    });
  });

  describe('T2-3 缺陷转用例 (defect-to-case)', () => {
    it('counter-example: missing repair notes / fix field exits with named clarification request', async () => {
      // plm:bug:31057 has no configured repair_notes/fix_field, which verifies the missing fix notes exit
      const res = await client.call('start_run', {
        pack: 'defect-to-case',
        product: 'famx',
        build: 'Rel_FAMX_10_6_1_57',
        inputs: {
          defects: [{ external: 'plm:bug:31057' }],
          indexed_cases: {
            external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=commands&fields=commands,document,node,title,negative,case_structure',
          },
        },
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => e.code === 'defect-to-case.missing_fix_field'));
      assert.ok(res.text.includes('缺少') || res.text.includes('未配置') || res.text.includes('修正'));
    });
  });

  describe('T2-4 & T2-5 追溯矩阵 (traceability & story-traceability)', () => {
    it('counter-example T2-4: traceability rejects when build defect index has no fixed defects', async () => {
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
      assert.ok(res.out.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION' && e.message.includes('缺陷索引没有编号')));
    });

    it('counter-example T2-5: story-traceability rejects unindexed story ID with single-item remedy', async () => {
      const res = await client.call('start_run', {
        pack: 'story-traceability',
        inputs: {
          stories: [{ external: 'plm:stories:31057' }],
          cases: {
            external: 'knowledge:index:famx:Rel_FAMX_10_6_1_57?kind=case&key=stories',
          },
        },
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => e.code === 'story-traceability.invalid_input'));
      assert.ok(res.text.includes('去掉无法确定的编号 31057'));
    });
  });

  describe('T2-6 质量看板 (quality-board)', () => {
    it('executes quality-board with facets and placement inputs, reporting remedy when build root has no case entries', async () => {
      const res = await client.call('start_run', {
        pack: 'quality-board',
        inputs: {
          facets: {
            external: 'knowledge:facets:famx:Rel_FAMX_10_6_1_57?kind=case&by=line,module,has_expected,negative,test_type_status',
          },
          placement: {
            external: 'knowledge:facets:famx:Rel_FAMX_10_6_1_57?kind=case&by=commands',
          },
        },
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => e.code === 'quality-board.no_cases'));
      assert.ok(res.text.includes('没有用例条目') || res.text.includes('确认这个构建的用例索引已经同步'));
    });
  });
});
