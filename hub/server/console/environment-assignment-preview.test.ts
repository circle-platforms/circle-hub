import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemberCapabilities } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import type { PageContext } from './context.ts';
import { renderMemberCapabilities } from './member-capabilities.ts';
import { readinessCheckBlock } from './environment-readiness.ts';
import { connectionsPage } from './connections.ts';

const notice = '新测试环境分配尚未启用，当前仍按原工作流和预订规则';
function capabilities(enforced: boolean): MemberCapabilities {
  return {
    member: { name: '合成成员', enabled: true }, teams: [], workflows: [], unassigned_workflows_count: 0, skills: [], connections: [],
    environments: [{ name: '合成环境', enabled: true, assigned: false, can_use: false, occupancy: [{ name: '合成成员', since: '2026-11-14T00:00:00.000Z', until: null, mine: true }], missing: ['已无分配'] }],
    unattributed_holdings: null,
    environmentAccess: { ready: true, enforced, missing: null, nextAction: null }, denials: [],
  };
}

test('member allocation preview does not turn assigned false into a current use refusal', () => {
  const body = renderMemberCapabilities(capabilities(false)).text;
  assert.ok(body.includes(notice)); assert.match(body, /本人占用/);
  assert.doesNotMatch(body, /已无分配|当前不能做的事/);
  const active = renderMemberCapabilities(capabilities(true)).text;
  assert.match(active, /已无分配/); assert.match(active, /当前不能做的事/);
});

test('readonly assignment check is a preview while real evidence failures remain errors', () => {
  const check = { condition: 'assignment', label: '当前账户使用分配', satisfied: false, observed_at: '2026-11-14T00:00:00.000Z', references: [], missing_fact: '当前账户没有该执行器的使用分配', next_action: '请管理员分配' };
  const preview = readinessCheckBlock(check, false).text;
  assert.ok(preview.includes(notice)); assert.match(preview, /配置预览/);
  assert.doesNotMatch(preview, /错误|当前账户没有该执行器/);
  assert.match(readinessCheckBlock({ ...check, condition: 'manifest', label: '清单摘要核对' }).text, /错误/);
});

test('connections page labels the staged policy without querying grants to infer activation', async () => {
  const principal = { id: 'usr_' + '0'.repeat(26), name: '合成成员', role: 'user' as const };
  const context: PageContext = {
    principal, admin: false, url: new URL('http://127.0.0.1/console/connections?tab=environments'), userName: async () => '合成成员',
    deps: { records: { principals: { tokens: async () => [] }, callLog: {} }, memberCapabilities: async () => capabilities(false) } as unknown as ServerDeps,
    chrome: (title, extra = {}) => ({ title, ...extra, user: { name: principal.name, role: '成员', admin: false }, csrf: 'synthetic-csrf' }),
  };
  const result = await connectionsPage(context);
  assert.equal(result.status, 200); assert.ok(result.body.text.includes(notice));
  assert.match(result.body.text, /只读报告未知/); assert.doesNotMatch(result.body.text, /已无分配/);
});
