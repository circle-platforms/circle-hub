import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemberCapabilities, Principal } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import type { PageContext } from './context.ts';
import { memberCapabilitiesHref, memberCapabilitiesPage, renderMemberCapabilities } from './member-capabilities.ts';
import { mePath } from './routes.ts';

const INTERNAL_ID = /usr_|tm_|res_|exe_|run_/;

function sample(partial: Partial<MemberCapabilities> = {}): MemberCapabilities {
  return {
    member: { name: '合成成员甲', enabled: true },
    teams: ['team-a'],
    workflows: [{ name: '用例复核', ref: 'case-review@1.0.0' }],
    skills: [{ name: '通用解析', ref: 'parse-skill@1.0.0' }],
    connections: [{ name: '合成连接', systemPack: 'hub-test-system', environment: '合成实验室' }],
    unassigned_workflows_count: 0,
    unattributed_holdings: [],
    environments: [],
    environmentAccess: { enforced: true, ready: false, missing: '测试环境使用权限尚未接线', nextAction: '请管理员完成测试环境分配与使用权限接线后重新查询' },
    denials: [],
    ...partial,
  };
}

function context(options: {
  admin?: boolean;
  url?: string;
  view?: MemberCapabilities;
  userId?: string;
}): PageContext {
  const principal = {
    id: options.admin ? 'usr_01adminzzzzzzzzzzzzzzzzzz' : 'usr_01memberzzzzzzzzzzzzzzzz',
    name: options.admin ? '合成管理员' : '合成成员甲',
    role: options.admin ? 'admin' as const : 'user' as const,
  };
  const view = options.view ?? sample();
  return {
    deps: {
      memberCapabilities: async (by: Principal, userId?: string) => {
        assert.equal(by.id, principal.id);
        if (userId !== undefined && userId !== by.id && !options.admin) {
          const { AccessError } = await import('../../records/errors.ts');
          throw new AccessError('对象不存在或无权读取');
        }
        if (options.userId !== undefined) assert.equal(userId, options.userId);
        return view;
      },
    } as unknown as ServerDeps,
    principal,
    admin: options.admin === true,
    url: new URL(options.url ?? 'http://127.0.0.1/console/me'),
    userName: async (id) => id ?? '—',
    chrome: (title, extra = {}) => ({
      title,
      ...extra,
      user: { name: principal.name, role: principal.role === 'admin' ? '管理员' : '成员', admin: principal.role === 'admin' },
      csrf: 'synthetic-csrf',
    }),
  };
}

test('assigned member sees team-a content without internal ids', async () => {
  const page = await memberCapabilitiesPage(context({}));
  assert.equal(page.status, 200);
  const text = page.body.text;
  assert.match(text, /我能做的事/);
  assert.match(text, /team-a/);
  assert.match(text, /用例复核/);
  assert.match(text, /通用解析/);
  assert.match(text, /合成连接/);
  assert.match(text, /未知/);
  assert.match(text, /测试环境使用权限尚未接线/);
  assert.match(text, /连接新的客户端/);
  assert.match(text, /确认码/);
  assert.match(text, /&quot;name&quot;: &quot;Hub&quot;/);
  assert.doesNotMatch(text.replace(/href="[^"]*"/g, ''), INTERNAL_ID);
});

test('occupancy without until shows unlimited duration', () => {
  const html = renderMemberCapabilities(sample({
    environmentAccess: { enforced: true, ready: true, missing: null, nextAction: null },
    environments: [{
      name: '合成实验室', enabled: true, assigned: true, can_use: true, missing: [],
      occupancy: [{ since: '2026-11-09T02:00:00.000Z', until: null, mine: false, name: '合成成员乙' }],
    }],
  })).text;
  assert.match(html, /不限时长/);
  assert.match(html, /被合成成员乙的运行占用/);
  assert.doesNotMatch(html, /到何时未知/);
});

test('occupied without assignment shows 已无分配; assigned occupancy does not', () => {
  const revokedEnvs = [{
    name: '本人仍占用的合成环境',
    assigned: false,
    can_use: false,
    occupancy: [
      { name: '合成成员甲', since: '2026-11-14T04:30:00.000Z', until: null, mine: true },
    ],
    missing: ['占着但已无分配'],
  }] as unknown as MemberCapabilities['environments'];
  const revoked = renderMemberCapabilities(sample({
    environmentAccess: { enforced: true, ready: true, missing: null, nextAction: null },
    environments: revokedEnvs,
  })).text;
  assert.match(revoked, /已无分配/);
  assert.match(revoked, /本人占用/);
  assert.match(revoked, /不限时长/);
  assert.doesNotMatch(revoked, /到何时未知/);

  const assignedEnvs = [{
    name: '合成实验室',
    assigned: true,
    can_use: true,
    occupancy: { since: '2026-11-09T02:00:00.000Z', until: '2026-11-09T03:00:00.000Z', mine: true },
  }] as unknown as MemberCapabilities['environments'];
  const assigned = renderMemberCapabilities(sample({
    environmentAccess: { enforced: true, ready: true, missing: null, nextAction: null },
    environments: assignedEnvs,
  })).text;
  assert.match(assigned, /本人占用/);
  assert.doesNotMatch(assigned, /已无分配/);
});

test('unassigned member sees empty team guidance', async () => {
  const page = await memberCapabilitiesPage(context({
    view: sample({
      teams: [],
      workflows: [],
      skills: [],
      connections: [],
      denials: [
        { reason: '尚无可用的已分配工作流', nextAction: '请管理员把你加入团队并分配工作流，或直接向账户分配工作流' },
      ],
    }),
  }));
  assert.match(page.body.text, /请管理员把你加入团队/);
  assert.doesNotMatch(page.body.text, /team-a/);
});

test('administrator view-as uses the target projection', async () => {
  const target = 'usr_01targetzzzzzzzzzzzzzzzz';
  const page = await memberCapabilitiesPage(context({
    admin: true,
    url: `http://127.0.0.1/console/me?user=${target}`,
    userId: target,
    view: sample({ member: { name: '合成成员乙', enabled: true }, teams: ['team-a'] }),
  }));
  assert.match(page.body.text, /合成成员乙 能做的事/);
  assert.match(page.body.text, /管理员按 合成成员乙 的视角查看/);
  assert.match(page.body.text, /team-a/);
});

test('member cannot open another account projection', async () => {
  const page = await memberCapabilitiesPage(context({
    url: 'http://127.0.0.1/console/me?user=usr_01otherzzzzzzzzzzzzzzzz',
  }));
  assert.equal(page.status, 404);
});

test('ready=false does not claim proven no environment access', () => {
  const html = renderMemberCapabilities(sample({
    environments: [],
    environmentAccess: { enforced: true, ready: false, missing: '权限端口未就绪', nextAction: '请管理员接线后重试' },
  })).text;
  assert.match(html, /未知/);
  assert.match(html, /权限端口未就绪/);
  assert.match(html, /尚未核对/);
  assert.doesNotMatch(html, /没有可用的测试环境|无权使用测试环境/);
});

test('me path helpers stay stable', () => {
  assert.equal(mePath(), '/console/me');
  assert.equal(memberCapabilitiesHref(), '/console/me');
  assert.match(memberCapabilitiesHref('usr_01targetzzzzzzzzzzzzzzzz'), /\/console\/me\?user=/);
});
