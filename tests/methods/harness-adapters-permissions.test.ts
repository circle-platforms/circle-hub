import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  disposition,
  exportPermission,
  hubPermissionSchema,
  type HubPermission,
  type PermissionRole,
} from '../../packages/harness-adapters/index.ts';

// The worked example from docs/design/permission-export.md: scope
// scp_example with three synthetic tools.
const policy = hubPermissionSchema.parse({
  schema: 'hub-permission/1',
  scopeId: 'scp_example',
  twoPersonRule: true,
  singleAdminMode: false,
  roleOrder: ['guest', 'member', 'administrator'],
  tools: [
    { name: 'documents.search', effect: 'read', minimumRole: 'guest', approval: false },
    { name: 'buildsite.command_check', effect: 'read', minimumRole: 'member', approval: false },
    { name: 'case-gateway.dispatch', effect: 'write', minimumRole: 'member', approval: true },
  ],
});

const ROLES: PermissionRole[] = ['guest', 'member', 'administrator'];

test('disposition: the three rules, and deny for tools outside the catalog', () => {
  assert.equal(disposition(policy, 'guest', 'documents.search'), 'allow');
  assert.equal(disposition(policy, 'guest', 'buildsite.command_check'), 'deny');
  assert.equal(disposition(policy, 'member', 'case-gateway.dispatch'), 'ask');
  assert.equal(disposition(policy, 'administrator', 'case-gateway.dispatch'), 'ask');
  // effect: write without approval is allow — the change set already decided.
  const write = hubPermissionSchema.parse({
    ...policy,
    tools: [{ name: 'reports.publish', effect: 'write', minimumRole: 'member', approval: false }],
  });
  assert.equal(disposition(write, 'member', 'reports.publish'), 'allow');
  assert.equal(disposition(write, 'guest', 'reports.publish'), 'deny');
  assert.equal(disposition(policy, 'administrator', 'nope.missing'), 'deny');
});

test('hub-permission/1 stores inputs only, never a computed disposition', () => {
  assert.equal('disposition' in hubPermissionSchema.shape, false);
  assert.equal('dispositions' in hubPermissionSchema.shape, false);
  assert.throws(() => hubPermissionSchema.parse({ ...policy, scopeId: 'example' }));
  assert.throws(() => hubPermissionSchema.parse({ ...policy, schema: 'hub-permission/2' }));
});

test('Claude Code permission export matches the spec table for all three roles', () => {
  const member = JSON.parse(exportPermission('claude-code', policy, 'member')['.claude/settings.member.json'] as string);
  assert.deepEqual(member, {
    permissions: {
      allow: ['mcp__hub__documents.search', 'mcp__hub__buildsite.command_check'],
      ask: ['mcp__hub__case-gateway.dispatch'],
      deny: [],
    },
  });
  const guest = JSON.parse(exportPermission('claude-code', policy, 'guest')['.claude/settings.guest.json'] as string);
  assert.deepEqual(guest, {
    permissions: {
      allow: ['mcp__hub__documents.search'],
      ask: [],
      deny: ['mcp__hub__buildsite.command_check', 'mcp__hub__case-gateway.dispatch'],
    },
  });
  const administrator = JSON.parse(exportPermission('claude-code', policy, 'administrator')['.claude/settings.administrator.json'] as string);
  assert.deepEqual(administrator, member);
});

test('Codex permission export matches the spec example for all three roles', () => {
  const member = exportPermission('codex', policy, 'member')['.codex/permissions.member.toml'] as string;
  assert.equal(
    member,
    '[mcp_servers.hub]\n' +
      'enabled_tools = ["documents.search", "buildsite.command_check", "case-gateway.dispatch"]\n' +
      'disabled_tools = []\n\n' +
      '[mcp_servers.hub.tools."documents.search"]\napproval_mode = "auto"\n\n' +
      '[mcp_servers.hub.tools."buildsite.command_check"]\napproval_mode = "auto"\n\n' +
      '[mcp_servers.hub.tools."case-gateway.dispatch"]\napproval_mode = "prompt"\n',
  );
  const guest = exportPermission('codex', policy, 'guest')['.codex/permissions.guest.toml'] as string;
  assert.equal(
    guest,
    '[mcp_servers.hub]\n' +
      'enabled_tools = ["documents.search"]\n' +
      'disabled_tools = ["buildsite.command_check", "case-gateway.dispatch"]\n\n' +
      '[mcp_servers.hub.tools."documents.search"]\napproval_mode = "auto"\n',
  );
  assert.equal(exportPermission('codex', policy, 'administrator')['.codex/permissions.administrator.toml'], member);
});

test('Codex permission export: allow + effect write is enabled without an approval_mode line', () => {
  const write = hubPermissionSchema.parse({
    ...policy,
    tools: [{ name: 'reports.publish', effect: 'write', minimumRole: 'member', approval: false }],
  });
  const member = exportPermission('codex', write, 'member')['.codex/permissions.member.toml'] as string;
  assert.equal(
    member,
    '[mcp_servers.hub]\nenabled_tools = ["reports.publish"]\ndisabled_tools = []\n',
  );
});

test('OpenCode permission export matches the spec example, with ask never written as allow', () => {
  const member = JSON.parse(exportPermission('opencode', policy, 'member')['opencode.permissions.member.json'] as string);
  assert.deepEqual(member, {
    $schema: 'https://opencode.ai/config.json',
    permissions: [
      { action: 'hub_documents_search', resource: '*', effect: 'allow' },
      { action: 'hub_buildsite_command_check', resource: '*', effect: 'allow' },
      { action: 'hub_case_gateway_dispatch', resource: '*', effect: 'ask' },
    ],
  });
  const guest = JSON.parse(exportPermission('opencode', policy, 'guest')['opencode.permissions.guest.json'] as string);
  assert.deepEqual(
    guest.permissions.map((rule: { effect: string }) => rule.effect),
    ['allow', 'deny', 'deny'],
  );
  assert.equal(exportPermission('opencode', policy, 'administrator')['opencode.permissions.administrator.json'], exportPermission('opencode', policy, 'member')['opencode.permissions.member.json']);
});

test('Gemini permission export matches the spec example (ask_user, priority 100)', () => {
  const member = exportPermission('gemini', policy, 'member')['.gemini/policies/hub.member.toml'] as string;
  assert.equal(
    member,
    '[[rule]]\nmcpName = "hub"\ntoolName = "documents.search"\ndecision = "allow"\npriority = 100\n\n' +
      '[[rule]]\nmcpName = "hub"\ntoolName = "buildsite.command_check"\ndecision = "allow"\npriority = 100\n\n' +
      '[[rule]]\nmcpName = "hub"\ntoolName = "case-gateway.dispatch"\ndecision = "ask_user"\npriority = 100\n',
  );
  const guest = exportPermission('gemini', policy, 'guest')['.gemini/policies/hub.guest.toml'] as string;
  assert.equal(guest.match(/\[\[rule\]\]/g)!.length, 3);
  assert.ok(guest.includes('toolName = "case-gateway.dispatch"\ndecision = "deny"'));
});

test('Cursor permission export: allowlist only, ask is omission, deny is not expressible', () => {
  const member = JSON.parse(exportPermission('cursor', policy, 'member')['.cursor/permissions.member.json'] as string);
  assert.deepEqual(member, { mcpAllowlist: ['hub:documents.search', 'hub:buildsite.command_check'] });
  const guest = JSON.parse(exportPermission('cursor', policy, 'guest')['.cursor/permissions.guest.json'] as string);
  assert.deepEqual(guest, { mcpAllowlist: ['hub:documents.search'] });
});

test('every harness: ask is never written as allow, and policy-level flags are not translated', () => {
  for (const harness of ['claude-code', 'codex', 'opencode', 'gemini', 'cursor'] as const) {
    for (const role of ROLES) {
      const files = exportPermission(harness, policy, role);
      assert.equal(Object.keys(files).length, 1);
      const text = Object.values(files)[0] as string;
      // twoPersonRule / singleAdminMode are recorded in the policy, never
      // translated into tool rules.
      assert.equal(text.includes('twoPersonRule'), false);
      assert.equal(text.includes('singleAdminMode'), false);
      // The approval:true tool must not land in an allow position.
      assert.equal(text.includes('hub__case-gateway.dispatch",\n    ]'), false);
      if (harness === 'opencode') {
        const parsed = JSON.parse(text) as { permissions: Array<{ action: string; effect: string }> };
        const rule = parsed.permissions.find((entry) => entry.action === 'hub_case_gateway_dispatch')!;
        assert.notEqual(rule.effect, 'allow');
      }
      if (harness === 'cursor') {
        assert.equal(text.includes('case-gateway.dispatch'), false);
      }
    }
  }
});
