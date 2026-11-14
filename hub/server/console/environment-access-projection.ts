// Same-source environmentAccess list for the member home and list_task_packs (Boss 17:20 #4).
// Fake-port projection only: no PostgreSQL, vault, network or contracts/generated edits.
import type { Principal } from '../../records/api.ts';
import { isAdmin } from '../../records/api.ts';

/** How the caller received this 测试环境 assignment (user-facing labels via assignmentSourceLabel). */
export type EnvironmentAssignmentSource = 'direct' | 'team' | 'all';

/** One assignment subject already resolved to a display name (never usr_/tm_ ids). */
export type EnvironmentAccessAssignee = {
  kind: 'account' | 'team' | 'all';
  /** Account name, team name, or the fixed word 全体. */
  name: string;
};

/** One catalog row from the thin console port (full directory before principal filtering). */
export type EnvironmentAccessCatalogItem = {
  name: string;
  enabled: boolean;
  assignments: readonly EnvironmentAccessAssignee[];
};

/**
 * Thin port the projection reads. Production will wrap records.testEnvironments.list + resource_assign;
 * tests inject a fake list.
 */
export type EnvironmentAccessPort = {
  list(): Promise<readonly EnvironmentAccessCatalogItem[]>;
  /** Display names of teams the principal currently belongs to. */
  teamsOf(principal: Principal): Promise<readonly string[]>;
};

/** One row after principal filtering — member home and list_task_packs share this shape. */
export type EnvironmentAccessViewItem = {
  name: string;
  enabled: boolean;
  assigned: boolean;
  /** Null only when the viewer is an administrator browsing an unassigned row in the full list. */
  assignmentSource: EnvironmentAssignmentSource | null;
  /** Team name when assignmentSource is team; otherwise null. */
  inheritedFrom: string | null;
  assignees: readonly EnvironmentAccessAssignee[];
};

/** User-facing label for the inheritance source column (Boss 17:20 #1 / #4). */
export function assignmentSourceLabel(source: EnvironmentAssignmentSource | null): string {
  if (source === 'direct') return '直接';
  if (source === 'team') return '从团队继承';
  if (source === 'all') return '全体';
  return '未分配';
}

function resolveAccess(
  item: EnvironmentAccessCatalogItem,
  principal: Principal,
  teams: ReadonlySet<string>,
): Pick<EnvironmentAccessViewItem, 'assigned' | 'assignmentSource' | 'inheritedFrom'> {
  const direct = item.assignments.some((row) => row.kind === 'account' && row.name === principal.name);
  if (direct) return { assigned: true, assignmentSource: 'direct', inheritedFrom: null };
  const teamHit = item.assignments.find((row) => row.kind === 'team' && teams.has(row.name));
  if (teamHit) return { assigned: true, assignmentSource: 'team', inheritedFrom: teamHit.name };
  if (item.assignments.some((row) => row.kind === 'all')) {
    return { assigned: true, assignmentSource: 'all', inheritedFrom: null };
  }
  return { assigned: false, assignmentSource: null, inheritedFrom: null };
}

/**
 * Filters the shared catalog: administrators see every name; members see only assigned rows.
 * Inheritance fields are computed once here so `/console/me` and `list_task_packs` stay aligned.
 */
export async function environmentAccessProjection(
  port: EnvironmentAccessPort,
  principal: Principal,
): Promise<readonly EnvironmentAccessViewItem[]> {
  const [catalog, teamNames] = await Promise.all([port.list(), port.teamsOf(principal)]);
  const teams = new Set(teamNames);
  const admin = isAdmin(principal);
  const out: EnvironmentAccessViewItem[] = [];
  for (const item of catalog) {
    const access = resolveAccess(item, principal, teams);
    if (!admin && !access.assigned) continue;
    out.push({
      name: item.name,
      enabled: item.enabled,
      assigned: access.assigned,
      assignmentSource: access.assignmentSource,
      inheritedFrom: access.inheritedFrom,
      assignees: item.assignments,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}
