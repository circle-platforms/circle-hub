// Helper functions for reading PLM defect statuses and closed status evaluation.
import CLOSED_DEFAULT from '../tables/closed-statuses.json' with { type: 'json' };
import { normalizeId } from './ids.ts';
import { isRecord } from './text.ts';

export interface DefectSystemInfo {
  status: string | null;
  unknownReason: string | null;
  isClosed: boolean;
  unconnectedSystem?: string;
}

/** Parses closed status values from check.table, falling back to tables/closed-statuses.json. */
export function readClosedStatuses(table: unknown): string[] {
  if (Array.isArray(table)) {
    return table.filter((s): s is string => typeof s === 'string');
  }
  if (isRecord(table)) {
    if (Array.isArray(table.statuses)) {
      return (table.statuses as unknown[]).filter((s): s is string => typeof s === 'string');
    }
    if (Array.isArray(table.closed)) {
      return (table.closed as unknown[]).filter((s): s is string => typeof s === 'string');
    }
  }
  return Array.isArray(CLOSED_DEFAULT.statuses) ? CLOSED_DEFAULT.statuses : ['closed'];
}

function isPlmBugSource(u: { reference: string; reason?: string; external?: string; slot?: string }): boolean {
  if (typeof u.external === 'string' && (u.external.startsWith('plm:bugs:') || u.external.startsWith('plm:bugs'))) return true;
  if (typeof u.reference === 'string' && u.reference.startsWith('plm:bugs:')) return true;
  return false;
}

/** Parses PLM batch responses from sources record (Record<string, string> of reference -> JSON string). */
export function parsePlmResponses(
  sources: Readonly<Record<string, string>> | undefined,
  unreadSources?: ReadonlyArray<{ reference: string; reason: string; external?: string; slot?: string }>,
): {
  hasPlmSource: boolean;
  hasUnreadSources: boolean;
  statuses: Map<string, string | null>;
  unread: Set<string>;
} {
  const statuses = new Map<string, string | null>();
  const unread = new Set<string>();
  let hasPlmSource = false;
  const hasUnreadSources = Boolean(unreadSources && unreadSources.some(isPlmBugSource));
  if (!sources) return { hasPlmSource, hasUnreadSources, statuses, unread };

  for (const text of Object.values(sources)) {
    if (typeof text !== 'string') continue;
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed)) {
        if (Array.isArray(parsed.bugs) || Array.isArray(parsed.unread)) {
          hasPlmSource = true;
        }
        if (Array.isArray(parsed.bugs)) {
          for (const bug of parsed.bugs) {
            if (isRecord(bug) && (typeof bug.id === 'string' || typeof bug.id === 'number')) {
              const idNorm = normalizeId(String(bug.id));
              if (typeof bug.status === 'string' && bug.status.trim() !== '') {
                statuses.set(idNorm, bug.status.trim());
              } else {
                statuses.set(idNorm, null);
              }
            }
          }
        }
        if (Array.isArray(parsed.unread)) {
          for (const id of parsed.unread) {
            if (typeof id === 'string' || typeof id === 'number') {
              unread.add(normalizeId(String(id)));
            }
          }
        }
      }
    } catch {
      // Ignore non-JSON source texts.
    }
  }
  return { hasPlmSource, hasUnreadSources, statuses, unread };
}

/** Determines defect system status and closed status for one defect. */
export function defectSystemInfoOf(
  bug: string,
  systems: readonly string[] = [],
  plmStatuses: Map<string, string | null>,
  plmUnread: Set<string>,
  closedSet: Set<string>,
  hasPlmSource = true,
  hasUnreadSources = false,
): DefectSystemInfo {
  if (!systems.includes('plm')) {
    if (systems.includes('bugzilla')) {
      return {
        status: null,
        unknownReason: null,
        unconnectedSystem: 'bugzilla',
        isClosed: false,
      };
    }
    return {
      status: null,
      unknownReason: '缺陷系统不明，不按编号查 PLM',
      isClosed: false,
    };
  }

  if (!hasPlmSource) {
    return {
      status: null,
      unknownReason: '缺陷系统没有读到（来源不可用）',
      isClosed: false,
    };
  }

  const norm = normalizeId(bug);
  if (plmStatuses.has(norm)) {
    const foundStatus = plmStatuses.get(norm);
    if (foundStatus !== null && foundStatus !== undefined) {
      return {
        status: foundStatus,
        unknownReason: null,
        isClosed: closedSet.has(foundStatus),
      };
    }
    return {
      status: null,
      unknownReason: '缺陷系统的记录里没有状态',
      isClosed: false,
    };
  }

  if (plmUnread.has(norm)) {
    return {
      status: null,
      unknownReason: '缺陷系统没有返回这个编号',
      isClosed: false,
    };
  }

  if (hasUnreadSources) {
    return {
      status: null,
      unknownReason: '缺陷系统没有读到（来源不可用）',
      isClosed: false,
    };
  }

  return {
    status: null,
    unknownReason: '缺陷系统没有返回这个编号',
    isClosed: false,
  };
}

export function defectSystemText(info: DefectSystemInfo): string {
  if (info.unconnectedSystem) return `状态未读：系统未接入（${info.unconnectedSystem}）`;
  if (info.status !== null) return `缺陷系统：${info.status}`;
  return info.unknownReason ? `缺陷系统：未知（${info.unknownReason}）` : '缺陷系统：未知';
}
