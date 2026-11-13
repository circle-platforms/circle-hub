import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EnvironmentReadiness } from '../../dispatch/api.ts';
import type { Principal } from '../../records/api.ts';
import {
  loadReadinessReports,
  readinessCheckBlock,
  readinessReportCard,
  readinessSatisfiedChip,
  readinessUnknownNotice,
} from './environment-readiness.ts';

const instant = '2026-11-14T00:00:00.000Z';
const caller: Principal = { id: 'usr_' + '0'.repeat(26), role: 'user', name: '合成成员' };

function report(partial: Partial<EnvironmentReadiness> = {}): EnvironmentReadiness {
  return {
    target: '合成测试环境甲',
    observed_at: instant,
    executors: [{
      ordinal: 1,
      checks: [
        { condition: 'manifest', label: '清单原件可读且摘要一致', satisfied: false, observed_at: instant, references: [], missing_fact: '受权读取的原件字节与登记摘要不一致', next_action: '请管理员核对该项声明与可读依据后重读' },
        { condition: 'baseline.0', label: '基线登记（第 1 项）', satisfied: false, observed_at: instant, references: [], missing_fact: '该声明探针没有基线登记', next_action: '请管理员按声明探针登记基线后重读；本报告不进行现场比较' },
        { condition: 'evidence.0.0', label: '认证证据原件（第 1 组，第 1 项）', satisfied: null, observed_at: instant, references: [], missing_fact: '原件未取得；不存在、无权或读取策略未放行均不能当作已核对', next_action: '请管理员核对该项声明与可读依据后重读' },
        { condition: 'enabled', label: '执行器启用', satisfied: true, observed_at: instant, references: [] },
      ],
      occupancy: [],
      baseline_registrations: [],
    }],
    limitations: ['仅本地只读观察，未连接网关或设备，未读取秘密值，不是预订或上机许可'],
    ...partial,
  };
}

test('three-state chips follow satisfied without page-side judgment', () => {
  assert.deepEqual(readinessSatisfiedChip(true), { text: '已确认', tone: 'pass' });
  assert.deepEqual(readinessSatisfiedChip(false), { text: '错误', tone: 'fail' });
  assert.deepEqual(readinessSatisfiedChip(null), { text: '未知', tone: 'unknown' });
});

test('synthetic readiness fixture shows tonight blocked checks with label missing and next', () => {
  const body = readinessReportCard(report()).text;
  assert.match(body, /合成测试环境甲/);
  assert.match(body, /data-condition="manifest"/);
  assert.match(body, /清单原件可读且摘要一致/);
  assert.match(body, /受权读取的原件字节与登记摘要不一致/);
  assert.match(body, /data-condition="baseline\.0"/);
  assert.match(body, /该声明探针没有基线登记/);
  assert.match(body, /data-condition="evidence\.0\.0"/);
  assert.match(body, /原件未取得/);
  assert.match(body, /已确认/);
  assert.match(body, /错误/);
  assert.match(body, /未知/);
  assert.match(body, /缺什么：/);
  assert.match(body, /下一步：/);
  assert.doesNotMatch(body, /href="[^"]*src:/);
  assert.doesNotMatch(body, /secret|password|PRIVATE/i);
});

test('administrator executor identity may appear; member report omits it', () => {
  const admin = readinessReportCard(report({
    executors: [{ ...report().executors[0], executor: 'exe_' + '1'.repeat(26) }],
  })).text;
  assert.match(admin, /exe_1{26}/);
  const member = readinessReportCard(report()).text;
  assert.doesNotMatch(member, /exe_/);
});

test('unwired or failed readiness stays unknown without inventing a verdict', async () => {
  assert.match(readinessUnknownNotice().text, /只读报告未知/);
  assert.match(readinessUnknownNotice().text, /报告尚未接线/);
  const unwired = await loadReadinessReports(undefined, caller, ['合成目标']);
  assert.equal(unwired.length, 1);
  assert.match(unwired[0].body.text, /只读报告未知/);
  assert.match(unwired[0].body.text, /报告尚未接线/);
  const failed = await loadReadinessReports(async () => { throw new Error('private://secret-host/password'); }, caller, ['合成目标']);
  assert.match(failed[0].body.text, /只读报告未知/);
  assert.doesNotMatch(failed[0].body.text, /secret-host|password|private:\/\//);
});

test('unknown check must surface missing_fact and next_action verbatim', () => {
  const block = readinessCheckBlock({
    condition: 'manifest_freshness',
    label: '清单时效',
    satisfied: null,
    observed_at: instant,
    references: ['src:' + 'a'.repeat(64)],
    missing_fact: '没有足以判定过期的版本或期限依据；未连接目标核对当前清单',
    next_action: '请管理员核对该项声明与可读依据后重读',
  }).text;
  assert.match(block, /清单时效/);
  assert.match(block, /没有足以判定过期的版本或期限依据/);
  assert.match(block, /请管理员核对该项声明与可读依据后重读/);
  assert.doesNotMatch(block, /src:|href=/);
});

test('null-target report discloses safe missing without echoing a hidden target', () => {
  const body = readinessReportCard({
    target: null,
    observed_at: instant,
    executors: [],
    missing_fact: '该目标当前没有可查看的执行器配置',
    next_action: '请管理员核对目标配置与账户分配后重读',
    limitations: ['仅本地只读观察'],
  }).text;
  assert.match(body, /只读报告未知/);
  assert.match(body, /该目标当前没有可查看的执行器配置/);
  assert.doesNotMatch(body, /hidden-target|exe_|usr_/);
});
