// Gold script: the traceability join of one build — the defect ids of its release-note page against the defect
// ids of its indexed cases, computed with a plain double loop (no index structures; the independence of this
// script from the Hub is its whole value, so it imports nothing from hub/ or packs/). Ids compare as normalised:
// a pure ASCII digit run loses its leading zeros (the pack's ids.ts convention, re-implemented).
// Inputs: --defects <json>  [{ bug, status: fixed|known, module }]
//         --cases <json>   { documents: [{ document, cases: [{ id, title, defects: [...] }] }] }
//         (the shape of gold/cases.ts output, or a hand-trimmed variant of it)
//   node scripts/real/gold/join.ts --defects <defects.json> --cases <cases.json> --out <join.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Read the declaration, rejecting malformed tables instead of silently defaulting. */
export function parseClosedStatuses(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' && 'statuses' in raw ? raw.statuses : null;
  if (!Array.isArray(values) || !values.every((v) => typeof v === 'string' && v.trim() !== '')) throw new Error('关闭状态表必须是字符串数组或 {statuses: 字符串数组}');
  return values;
}

export function normalizeId(id: string): string {
  return /^[0-9]+$/.test(id) ? id.replace(/^0+/, '') || '0' : id;
}

export interface DefectInput {
  bug: string;
  status: string;
  module: string;
  system?: string;
}

export interface CaseInput {
  document: string;
  id: string;
  title: string;
  defects: string[];
}

export interface JoinRow {
  /** The bug id as written in the release-note page. */
  bug: string;
  status: string;
  module: string;
  system?: string;
  /** Defect system status (from PLM), or null when unknown/unread/bugzilla. */
  defect_system_status?: string | null;
  /** Reason when defect system status is unknown, or null. */
  defect_system_unknown_reason?: string | null;
  /** Whether the defect is considered closed according to closed-statuses table. */
  closed?: boolean;
  /** Every case naming this defect, in (document, id) order; empty when untraced. */
  cases: Array<{ document: string; id: string; title: string }>;
}

export interface JoinGoldOptions {
  plm?: Array<{ id: string | number; status?: string; [key: string]: unknown }>;
  closedStatuses?: string[];
}

export interface JoinGold {
  rows: JoinRow[];
  traced: number;
  untraced: number;
  closed_defects: number;
  closed_traced: number;
  closed_untraced: number;
  status_unknown?: number;
}

export function joinGold(
  defects: ReadonlyArray<DefectInput>,
  cases: ReadonlyArray<CaseInput>,
  options?: JoinGoldOptions,
): JoinGold {
  const rows: JoinRow[] = [];
  let traced = 0;
  let untraced = 0;
  let closedDefects = 0;
  let closedTraced = 0;
  let closedUntraced = 0;
  let statusUnknown = 0;

  const closedStatuses = options?.closedStatuses ?? ['closed'];
  const closedSet = new Set(closedStatuses);
  let plmMap: Map<string, string | null> | null = null;
  if (options?.plm !== undefined) {
    plmMap = new Map();
    for (const item of options.plm) {
      if (item && item.id !== undefined) {
        const idNorm = normalizeId(String(item.id));
        if (typeof item.status === 'string' && item.status.trim() !== '') {
          plmMap.set(idNorm, item.status.trim());
        } else {
          plmMap.set(idNorm, null);
        }
      }
    }
  }

  for (const defect of defects) {
    const joined: Array<{ document: string; id: string; title: string }> = [];
    const key = normalizeId(defect.bug);
    for (const kase of cases) {
      let names = false;
      for (const id of kase.defects) {
        if (normalizeId(id) === key) {
          names = true;
          break;
        }
      }
      if (names) joined.push({ document: kase.document, id: kase.id, title: kase.title });
    }
    if (joined.length === 0) untraced += 1;
    else traced += 1;

    let defectSystemStatus: string | null = null;
    let defectSystemUnknownReason: string | null = null;
    let closed = false;

    if (options?.plm !== undefined) {
      const sys = defect.system?.toLowerCase();
      if (sys !== 'plm') {
        if (sys === 'bugzilla') {
          defectSystemStatus = null;
          defectSystemUnknownReason = '系统为 bugzilla，不从 PLM 查询';
        } else {
          defectSystemStatus = null;
          defectSystemUnknownReason = '缺陷系统不明，不按编号查 PLM';
        }
      } else {
        if (plmMap !== null && plmMap.has(key)) {
          const plmStatus = plmMap.get(key);
          if (plmStatus !== null && plmStatus !== undefined) {
            defectSystemStatus = plmStatus;
            defectSystemUnknownReason = null;
            closed = closedSet.has(plmStatus);
          } else {
            defectSystemStatus = null;
            defectSystemUnknownReason = '缺陷系统的记录里没有状态';
          }
        } else {
          defectSystemStatus = null;
          defectSystemUnknownReason = '缺陷系统没有返回这个编号';
        }
      }

      if (defectSystemStatus === null) {
        statusUnknown += 1;
      }
    }

    if (closed) {
      closedDefects += 1;
      if (joined.length > 0) closedTraced += 1;
      else closedUntraced += 1;
    }

    rows.push({
      bug: defect.bug,
      status: defect.status,
      module: defect.module,
      ...(defect.system !== undefined ? { system: defect.system } : {}),
      ...(options?.plm !== undefined
        ? {
            defect_system_status: defectSystemStatus,
            defect_system_unknown_reason: defectSystemUnknownReason,
            closed,
          }
        : {}),
      cases: joined,
    });
  }
  return {
    rows,
    traced,
    untraced,
    closed_defects: closedDefects,
    closed_traced: closedTraced,
    closed_untraced: closedUntraced,
    ...(options?.plm !== undefined ? { status_unknown: statusUnknown } : {}),
  };
}

export async function main(argv: string[]): Promise<number> {
  const value = (name: string): string | undefined => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const defectsPath = value('defects');
  const casesPath = value('cases');
  const plmPath = value('plm');
  const closedPath = value('closed-statuses');
  const outPath = value('out');
  if (!defectsPath || !casesPath || !outPath) {
    process.stderr.write('用法：node scripts/real/gold/join.ts --defects <defects.json> --cases <cases.json> [--plm <plm.json>] [--closed-statuses <statuses.json>] --out <join.json>\n');
    return 2;
  }
  let defects: DefectInput[];
  let cases: CaseInput[];
  let plm: Array<{ id: string | number; status?: string; [key: string]: unknown }> | undefined;
  let closedStatuses: string[] | undefined;
  try {
    const rawDefects: unknown = JSON.parse(readFileSync(resolve(defectsPath), 'utf8'));
    if (!Array.isArray(rawDefects)) throw new Error('缺陷不是列表');
    defects = rawDefects.map((row) => {
      if (row === null || typeof row !== 'object') throw new Error('缺陷行不是对象');
      const record = row as Record<string, unknown>;
      if (typeof record.bug !== 'string' || record.bug === '') throw new Error('缺陷行没有 bug 编号');
      return {
        bug: record.bug,
        status: typeof record.status === 'string' ? record.status : '',
        module: typeof record.module === 'string' ? record.module : '',
        system: typeof record.system === 'string' ? record.system : undefined,
      };
    });
    const rawCases: unknown = JSON.parse(readFileSync(resolve(casesPath), 'utf8'));
    if (rawCases === null || typeof rawCases !== 'object' || !Array.isArray((rawCases as { documents?: unknown }).documents)) throw new Error('用例输入没有 documents');
    cases = [];
    for (const doc of (rawCases as { documents: unknown[] }).documents) {
      if (doc === null || typeof doc !== 'object') throw new Error('文档不是对象');
      const record = doc as Record<string, unknown>;
      const document = typeof record.document === 'string' ? record.document : '';
      for (const item of Array.isArray(record.cases) ? record.cases : []) {
        if (item === null || typeof item !== 'object') throw new Error('用例不是对象');
        const c = item as Record<string, unknown>;
        cases.push({
          document,
          id: typeof c.id === 'string' ? c.id : '',
          title: typeof c.title === 'string' ? c.title : '',
          defects: Array.isArray(c.defects) ? c.defects.filter((d): d is string => typeof d === 'string') : [],
        });
      }
    }
    if (plmPath) {
      const rawPlm: unknown = JSON.parse(readFileSync(resolve(plmPath), 'utf8'));
      if (rawPlm && typeof rawPlm === 'object' && Array.isArray((rawPlm as { data?: unknown }).data)) {
        plm = (rawPlm as { data: Array<{ id: string | number; status?: string }> }).data;
      } else if (Array.isArray(rawPlm)) {
        plm = rawPlm.flatMap((entry: unknown) => {
          if (entry && typeof entry === 'object' && Array.isArray((entry as { data?: unknown }).data)) {
            return (entry as { data: Array<{ id: string | number; status?: string }> }).data;
          }
          if (entry && typeof entry === 'object' && 'id' in entry) {
            return [entry as { id: string | number; status?: string }];
          }
          return [];
        });
      }
    }
    if (closedPath) {
      const rawClosed: unknown = JSON.parse(readFileSync(resolve(closedPath), 'utf8'));
      closedStatuses = parseClosedStatuses(rawClosed);
    }
  } catch (error) {
    process.stderr.write(`读不了输入：${(error as Error).message.split('\n')[0]}\n`);
    return 1;
  }
  writeFileSync(outPath, `${JSON.stringify(joinGold(defects, cases, { plm, closedStatuses }), null, 2)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('gold/join.ts')) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
