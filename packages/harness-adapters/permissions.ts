import { z } from 'zod';
import type { HarnessId, VirtualFiles } from './neutral.ts';
import { canonicalJson } from './files.ts';
import { emitToml } from './toml.ts';

// hub-permission/1 (docs/design/permission-export.md): a neutral JSON derived
// from the scope's role presets and the Tool annotations. Adapters only read
// it; exporting approves nothing. Dispositions are never stored — they are
// recomputed with the three rules so they cannot drift from the presets.

export const PERMISSION_ROLES = ['guest', 'member', 'administrator'] as const;
export type PermissionRole = (typeof PERMISSION_ROLES)[number];

export const hubPermissionSchema = z.looseObject({
  schema: z.literal('hub-permission/1'),
  scopeId: z.string().regex(/^scp_/),
  // Recorded verbatim from the scope policy; adapters must not translate
  // them into tool rules.
  twoPersonRule: z.boolean(),
  singleAdminMode: z.boolean(),
  roleOrder: z.tuple([z.literal('guest'), z.literal('member'), z.literal('administrator')]),
  tools: z.array(
    z.looseObject({
      name: z.string().min(1),
      effect: z.enum(['read', 'write']),
      minimumRole: z.enum(PERMISSION_ROLES),
      approval: z.boolean(),
    }),
  ),
});
export type HubPermission = z.infer<typeof hubPermissionSchema>;

export type Disposition = 'allow' | 'ask' | 'deny';

// The three rules: below minimumRole -> deny (the tool is not in this role's
// catalog at all); approval -> ask (the same person confirms the arguments,
// not an independent reviewer); otherwise allow — including effect: write
// without approval, since the change set already decided who may use it.
// A tool absent from the policy is not in the catalog: deny.
export function disposition(policy: HubPermission, role: PermissionRole, toolName: string): Disposition {
  const tool = policy.tools.find((entry) => entry.name === toolName);
  if (tool === undefined) return 'deny';
  if (policy.roleOrder.indexOf(role) < policy.roleOrder.indexOf(tool.minimumRole)) return 'deny';
  if (tool.approval) return 'ask';
  return 'allow';
}

// One file per role: these products share one project config for everyone
// and have no per-scope role slot. The files are written at a
// `permissions.<role>`-style path for the operator to pick up; they are not
// auto-loaded locations (see the brief's 待定).

function exportClaudeCodePermission(policy: HubPermission, role: PermissionRole): VirtualFiles {
  const allow: string[] = [];
  const ask: string[] = [];
  const deny: string[] = [];
  for (const tool of policy.tools) {
    const rule = `mcp__hub__${tool.name}`;
    const d = disposition(policy, role, tool.name);
    if (d === 'allow') allow.push(rule);
    else if (d === 'ask') ask.push(rule);
    else deny.push(rule);
  }
  return { [`.claude/settings.${role}.json`]: canonicalJson({ permissions: { allow, ask, deny } }) };
}

function exportCodexPermission(policy: HubPermission, role: PermissionRole): VirtualFiles {
  const enabled: string[] = [];
  const disabled: string[] = [];
  const tools: Record<string, { approval_mode: string }> = {};
  for (const tool of policy.tools) {
    const d = disposition(policy, role, tool.name);
    if (d === 'deny') {
      disabled.push(tool.name);
      continue;
    }
    enabled.push(tool.name);
    if (d === 'ask') {
      tools[tool.name] = { approval_mode: 'prompt' };
    } else if (tool.effect === 'read') {
      tools[tool.name] = { approval_mode: 'auto' };
    }
    // allow + effect: write has no defined Codex tier: the tool is enabled
    // without an approval_mode line, with no approximation invented.
  }
  return { [`.codex/permissions.${role}.toml`]: emitToml({ mcp_servers: { hub: { enabled_tools: enabled, disabled_tools: disabled, tools } } }) };
}

// MCP action names replace unsupported characters with `_`; the page does
// not list which characters, so the documented `.` and `-` are the ones
// replaced.
function opencodeAction(toolName: string): string {
  return `hub_${toolName.replace(/[.-]/g, '_')}`;
}

function exportOpencodePermission(policy: HubPermission, role: PermissionRole): VirtualFiles {
  const permissions = policy.tools.map((tool) => ({
    action: opencodeAction(tool.name),
    resource: '*',
    effect: disposition(policy, role, tool.name),
  }));
  return { [`opencode.permissions.${role}.json`]: canonicalJson({ $schema: 'https://opencode.ai/config.json', permissions }) };
}

function exportGeminiPermission(policy: HubPermission, role: PermissionRole): VirtualFiles {
  const lines: string[] = [];
  for (const tool of policy.tools) {
    const d = disposition(policy, role, tool.name);
    const decision = d === 'ask' ? 'ask_user' : d;
    if (lines.length > 0) lines.push('');
    lines.push('[[rule]]', `mcpName = "hub"`, `toolName = ${JSON.stringify(tool.name)}`, `decision = "${decision}"`, 'priority = 100');
  }
  return { [`.gemini/policies/hub.${role}.toml`]: `${lines.join('\n')}\n` };
}

// Cursor has an allowlist only: ask is written by omission (in Allowlist run
// mode the operator is re-asked) and deny is not expressible (no deny list).
function exportCursorPermission(policy: HubPermission, role: PermissionRole): VirtualFiles {
  const mcpAllowlist = policy.tools
    .filter((tool) => disposition(policy, role, tool.name) === 'allow')
    .map((tool) => `hub:${tool.name}`);
  return { [`.cursor/permissions.${role}.json`]: canonicalJson({ mcpAllowlist }) };
}

export function exportPermission(harness: HarnessId, policy: HubPermission, role: PermissionRole): VirtualFiles {
  const valid = hubPermissionSchema.parse(policy);
  switch (harness) {
    case 'claude-code':
      return exportClaudeCodePermission(valid, role);
    case 'codex':
      return exportCodexPermission(valid, role);
    case 'opencode':
      return exportOpencodePermission(valid, role);
    case 'gemini':
      return exportGeminiPermission(valid, role);
    case 'cursor':
      return exportCursorPermission(valid, role);
    default:
      throw new TypeError(`unknown harness: ${String(harness)}`);
  }
}
