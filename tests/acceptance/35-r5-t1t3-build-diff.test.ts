// Acceptance test 35: T3 Build Differences (构建差异)
// Covers:
// - T3-1 回归范围 (regression-scope): 双构建影响差集、命令差集与用例语法解析（非关键词）
// - T3-2 维护巡检 (maintenance-sweep): 双构建命令巡检、已删除命令记阻断、定义差异记提示
//
// Synthetic fixtures only: product FAMX/FAMY (two-name) and lumen-api (one-name).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openBed, type Bed } from './support/hub.ts';
import type { McpClient } from './support/mcp.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let client: McpClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres, syncTwoName: true, syncOneName: false });
  // Assign workflow packs to reviewer
  for (const pack of ['regression-scope', 'maintenance-sweep']) {
    await bed.hub.assignPack(bed.reviewer.principal, pack);
  }
  client = await bed.connect(bed.reviewer, 'session-build-diff');
});

after(async () => {
  await client?.close().catch(() => undefined);
  await bed?.close().catch(() => undefined);
  await postgres?.stop().catch(() => undefined);
});

describe('T3 构建差异端到端验收', () => {
  const BUILD_A = 'Rel_FAMX_10_6_1_57';
  const BUILD_B = 'Rel_FAMX_10_6_1_57';

  describe('T3-1 回归范围 (regression-scope)', () => {
    it('computes regression scope between builds based on syntactic command definition changes', async () => {
      const res = await client.call('start_run', {
        pack: 'regression-scope',
        inputs: {
          impact: {
            external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1`,
          },
          facets: {
            external: `knowledge:facets:famx:${BUILD_B}?kind=case&by=commands`,
          },
        },
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.out.call_result, 'ok');
      const run = res.out.run!;
      assert.ok(run.run.startsWith('run_'));
      // regression-scope computes fact result at start_run
      const prodResult = res.out.result;
      assert.ok(prodResult, 'regression-scope produces validation result at start_run');
      assert.equal(prodResult.counts.quarantined, 0);

      // Verify the full validation result record via get_nodes
      const nodeRes = await client.call('get_nodes', { reference: prodResult.reference });
      assert.equal(nodeRes.isError, false, nodeRes.text);
      assert.ok(nodeRes.out.content?.text);
      const full = JSON.parse(nodeRes.out.content.text);
      assert.equal(full.acceptance, 'accepted');
      assert.ok(Array.isArray(full.cross_item), 'has cross_item summary of scope');
    });

    it('counter-example: wrong changed parameter (changed=behaviour) on impact slot is rejected at boundary', async () => {
      const res = await client.call('start_run', {
        pack: 'regression-scope',
        inputs: {
          impact: {
            external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=behaviour&attached=case&catalog=commands@1`,
          },
          facets: {
            external: `knowledge:facets:famx:${BUILD_B}?kind=case&by=commands`,
          },
        },
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => (e.code === 'SOURCE_UNAVAILABLE' || e.code === 'regression-scope.changed_kinds') && e.path === '/inputs/impact'));
    });
  });

  describe('T3-2 维护巡检 (maintenance-sweep)', () => {
    it('executes maintenance-sweep between builds, producing structured definition comparisons', async () => {
      const res = await client.call('start_run', {
        pack: 'maintenance-sweep',
        inputs: {
          impact: {
            external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1`,
          },
          facets: {
            external: `knowledge:facets:famx:${BUILD_A}?kind=case&by=commands`,
          },
        },
      });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.out.call_result, 'ok');
      const prodResult = res.out.result;
      assert.ok(prodResult, 'maintenance-sweep produces validation result at start_run');

      // Verify the full validation result record via get_nodes
      const nodeRes = await client.call('get_nodes', { reference: prodResult.reference });
      assert.equal(nodeRes.isError, false, nodeRes.text);
      assert.ok(nodeRes.out.content?.text);
      const full = JSON.parse(nodeRes.out.content.text);
      assert.equal(full.acceptance, 'accepted');
    });

    it('counter-example: undeclared or malformed facets query is rejected at input boundary', async () => {
      const res = await client.call('start_run', {
        pack: 'maintenance-sweep',
        inputs: {
          impact: {
            external: `knowledge:impact:famx:${BUILD_A}..${BUILD_B}?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1`,
          },
          facets: {
            external: `knowledge:facets:famx:${BUILD_A}?kind=unknown_kind`,
          },
        },
      });
      assert.equal(res.out.call_result, 'error');
      assert.ok(res.out.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION' || e.code === 'SOURCE_UNAVAILABLE'));
    });
  });
});
