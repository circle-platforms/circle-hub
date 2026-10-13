import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  disposition,
  exportPermission,
  hubPermissionSchema,
  type PermissionExport,
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

function filesOf(result: PermissionExport): Record<string, string> {
  return result.files as Record<string, string>;
}

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
  const member = exportPermission('claude-code', policy, 'member');
  assert.deepEqual(JSON.parse(filesOf(member)['.claude/settings.member.json']), {
    permissions: {
      allow: ['mcp__hub__documents.search', 'mcp__hub__buildsite.command_check'],
      ask: ['mcp__hub__case-gateway.dispatch'],
      deny: [],
    },
  });
  assert.deepEqual(member.warnings, []);
  const guest = exportPermission('claude-code', policy, 'guest');
  assert.deepEqual(JSON.parse(filesOf(guest)['.claude/settings.guest.json']), {
    permissions: {
      allow: ['mcp__hub__documents.search'],
      ask: [],
      deny: ['mcp__hub__buildsite.command_check', 'mcp__hub__case-gateway.dispatch'],
    },
  });
  assert.deepEqual(guest.warnings, []);
  const administrator = exportPermission('claude-code', policy, 'administrator');
  assert.deepEqual(JSON.parse(filesOf(administrator)['.claude/settings.administrator.json']), JSON.parse(filesOf(member)['.claude/settings.member.json']));
});

test('Codex permission export matches the spec example for all three roles', () => {
  const member = exportPermission('codex', policy, 'member');
  assert.equal(
    filesOf(member)['.codex/permissions.member.toml'],
    '[mcp_servers.hub]\n' +
      'enabled_tools = ["documents.search", "buildsite.command_check", "case-gateway.dispatch"]\n' +
      'disabled_tools = []\n\n' +
      '[mcp_servers.hub.tools."documents.search"]\napproval_mode = "auto"\n\n' +
      '[mcp_servers.hub.tools."buildsite.command_check"]\napproval_mode = "auto"\n\n' +
      '[mcp_servers.hub.tools."case-gateway.dispatch"]\napproval_mode = "prompt"\n',
  );
  // The example has no allow+write tool, so no PERMISSION_NOT_EXPRESSIBLE.
  assert.deepEqual(member.warnings, []);
  const guest = exportPermission('codex', policy, 'guest');
  assert.equal(
    filesOf(guest)['.codex/permissions.guest.toml'],
    '[mcp_servers.hub]\n' +
      'enabled_tools = ["documents.search"]\n' +
      'disabled_tools = ["buildsite.command_check", "case-gateway.dispatch"]\n\n' +
      '[mcp_servers.hub.tools."documents.search"]\napproval_mode = "auto"\n',
  );
  assert.deepEqual(guest.warnings, []);
  assert.equal(filesOf(exportPermission('codex', policy, 'administrator'))['.codex/permissions.administrator.toml'], filesOf(member)['.codex/permissions.member.toml']);
});

test('Codex permission export: allow + effect write is enabled without an approval_mode line, with a warning', () => {
  const write = hubPermissionSchema.parse({
    ...policy,
    tools: [{ name: 'reports.publish', effect: 'write', minimumRole: 'member', approval: false }],
  });
  const member = exportPermission('codex', write, 'member');
  assert.equal(
    filesOf(member)['.codex/permissions.member.toml'],
    '[mcp_servers.hub]\nenabled_tools = ["reports.publish"]\ndisabled_tools = []\n',
  );
  assert.equal(member.warnings.length, 1);
  assert.equal(member.warnings[0].code, 'PERMISSION_NOT_EXPRESSIBLE');
  assert.equal(member.warnings[0].path, '.codex/permissions.member.toml');
  for (const part of ['codex', 'member', 'reports.publish', 'allow + effect:write']) {
    assert.ok(member.warnings[0].detail.includes(part), member.warnings[0].detail);
  }
  // deny is expressible in Codex: no warning for the guest.
  assert.deepEqual(exportPermission('codex', write, 'guest').warnings, []);
});

test('OpenCode permission export matches the spec example, with ask never written as allow', () => {
  const member = exportPermission('opencode', policy, 'member');
  assert.deepEqual(JSON.parse(filesOf(member)['opencode.permissions.member.json']), {
    $schema: 'https://opencode.ai/config.json',
    permissions: [
      { action: 'hub_documents_search', resource: '*', effect: 'allow' },
      { action: 'hub_buildsite_command_check', resource: '*', effect: 'allow' },
      { action: 'hub_case_gateway_dispatch', resource: '*', effect: 'ask' },
    ],
  });
  assert.deepEqual(member.warnings, []);
  const guest = JSON.parse(filesOf(exportPermission('opencode', policy, 'guest'))['opencode.permissions.guest.json']);
  assert.deepEqual(
    guest.permissions.map((rule: { effect: string }) => rule.effect),
    ['allow', 'deny', 'deny'],
  );
  assert.equal(filesOf(exportPermission('opencode', policy, 'administrator'))['opencode.permissions.administrator.json'], filesOf(member)['opencode.permissions.member.json']);
});

test('Gemini permission export matches the spec example (ask_user, priority 100) and flags the caveat', () => {
  const member = exportPermission('gemini', policy, 'member');
  assert.equal(
    filesOf(member)['.gemini/policies/hub.member.toml'],
    '[[rule]]\nmcpName = "hub"\ntoolName = "documents.search"\ndecision = "allow"\npriority = 100\n\n' +
      '[[rule]]\nmcpName = "hub"\ntoolName = "buildsite.command_check"\ndecision = "allow"\npriority = 100\n\n' +
      '[[rule]]\nmcpName = "hub"\ntoolName = "case-gateway.dispatch"\ndecision = "ask_user"\npriority = 100\n',
  );
  // ask_user degrades to deny in non-interactive runs: flagged per ask tool.
  assert.equal(member.warnings.length, 1);
  assert.equal(member.warnings[0].code, 'PERMISSION_NOT_EXPRESSIBLE');
  for (const part of ['gemini', 'member', 'case-gateway.dispatch', 'ask']) {
    assert.ok(member.warnings[0].detail.includes(part), member.warnings[0].detail);
  }
  const guest = exportPermission('gemini', policy, 'guest');
  assert.equal(filesOf(guest)['.gemini/policies/hub.guest.toml'].match(/\[\[rule\]\]/g)!.length, 3);
  assert.ok(filesOf(guest)['.gemini/policies/hub.guest.toml'].includes('toolName = "case-gateway.dispatch"\ndecision = "deny"'));
  // deny is expressible in Gemini: no warning for the guest.
  assert.deepEqual(guest.warnings, []);
});

test('Cursor permission export: allowlist only, ask is omission, deny warns', () => {
  const member = exportPermission('cursor', policy, 'member');
  assert.deepEqual(JSON.parse(filesOf(member)['.cursor/permissions.member.json']), { mcpAllowlist: ['hub:documents.search', 'hub:buildsite.command_check'] });
  assert.deepEqual(member.warnings, []);
  const guest = exportPermission('cursor', policy, 'guest');
  assert.deepEqual(JSON.parse(filesOf(guest)['.cursor/permissions.guest.json']), { mcpAllowlist: ['hub:documents.search'] });
  // deny has no Cursor cell: one warning per denied tool, file unchanged.
  assert.equal(guest.warnings.length, 2);
  assert.ok(guest.warnings.every((warning) => warning.code === 'PERMISSION_NOT_EXPRESSIBLE'));
  assert.ok(guest.warnings.every((warning) => warning.detail.includes('deny')));
  assert.deepEqual(
    guest.warnings.map((warning) => warning.detail),
    guest.warnings.map((warning) => warning.detail).sort(),
  );
});

test('every harness: ask is never written as allow, and policy-level flags are not translated', () => {
  for (const harness of ['claude-code', 'codex', 'opencode', 'gemini', 'cursor'] as const) {
    for (const role of ROLES) {
      const { files, warnings } = exportPermission(harness, policy, role);
      assert.equal(Object.keys(files).length, 1);
      assert.ok(warnings.every((warning) => warning.code === 'PERMISSION_NOT_EXPRESSIBLE'));
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
