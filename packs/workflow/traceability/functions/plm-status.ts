// Helper functions for reading PLM defect statuses and closed status evaluation.
import CLOSED_DEFAULT from '../tables/closed-statuses.json' with { type: 'json' };
import { normalizeId } from './ids.ts';
import { isRecord } from './text.ts';

export interface DefectSystemInfo {
  status: string | null;
  unknownReason: string | null;
  isClosed: boolean;
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

/** Parses PLM batch responses from sources record (Record<string, string> of reference -> JSON string). */
export function parsePlmResponses(sources: Readonly<Record<string, string>> | undefined): {
  statuses: Map<string, string>;
  unread: Set<string>;
} {
  const statuses = new Map<string, string>();
  const unread = new Set<string>();
  if (!sources) return { statuses, unread };

  for (const text of Object.values(sources)) {
    if (typeof text !== 'string') continue;
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed)) {
        if (Array.isArray(parsed.bugs)) {
          for (const bug of parsed.bugs) {
            if (isRecord(bug) && (typeof bug.id === 'string' || typeof bug.id === 'number')) {
              const idNorm = normalizeId(String(bug.id));
              if (typeof bug.status === 'string') {
                statuses.set(idNorm, bug.status);
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
  return { statuses, unread };
}

/** Determines defect system status and closed status for one defect. */
export function defectSystemInfoOf(
  bug: string,
  systems: readonly string[] = [],
  plmStatuses: Map<string, string>,
  plmUnread: Set<string>,
  closedSet: Set<string>,
): DefectSystemInfo {
  const isBugzillaOnly = systems.includes('bugzilla') && !systems.includes('plm');
  if (isBugzillaOnly) {
    return {
      status: null,
      unknownReason: '系统为 bugzilla，不从 PLM 查询',
      isClosed: false,
    };
  }

  const norm = normalizeId(bug);
  const foundStatus = plmStatuses.get(norm);
  if (foundStatus !== undefined) {
    return {
      status: foundStatus,
      unknownReason: null,
      isClosed: closedSet.has(foundStatus),
    };
  }

  if (plmUnread.has(norm)) {
    return {
      status: null,
      unknownReason: '缺陷系统未读到',
      isClosed: false,
    };
  }

  return {
    status: null,
    unknownReason: '缺陷系统未读到',
    isClosed: false,
  };
}

export function defectSystemText(info: DefectSystemInfo): string {
  if (info.status !== null) return `缺陷系统：${info.status}`;
  return info.unknownReason ? `缺陷系统：未知（${info.unknownReason}）` : '缺陷系统：未知';
}
