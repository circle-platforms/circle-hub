// Capability 5, the traceability matrix, through the real client: the Hub's matrix of one build is compared with the
// independent double-loop join in the gold file — every defect's listed cases are the same, a defect with no case is
// is unresolved until closed-scope evidence exists; no unknown is accepted as a passing check.
import { createHash } from 'node:crypto';
import { resultTexts, type LoggedTurn, type Scenario, claimVerdict, unknownDetail } from '../lib/accept.ts';
import { createPagerState, pagedRespond } from '../lib/pager.ts';
import type { Check } from '../lib/report.ts';
import { lengthBounded, runStarted } from './checks.ts';

export interface JoinCaseGold {
  /** The item id as the Hub writes it (document:node). */
  id: string;
  title: string;
}

export interface DefectGold {
  bug: string;
  /** fixed or known, as the release note says. */
  status: string;
  /** Defect system: plm, bugzilla, or unknown. */
  system?: string;
  systems?: string[];
  ids?: string[];
  /** Defect system status from PLM, or null when unknown. */
  defect_system_status?: string | null;
  /** Reason when defect system status is unknown. */
  defect_system_unknown_reason?: string | null;
  /** Whether the defect is closed according to closed-statuses table. */
  closed?: boolean;
  /** The cases the independent join found; empty when untraced. */
  cases: JoinCaseGold[];
}

export interface TraceGold {
  product: string;
  build: string;
  defects: DefectGold[];
  closed_defects?: number;
  closed_traced?: number;
  closed_untraced?: number;
  status_unknown?: number;
  status_unread?:number;
}

/**
 * Extracts the case ids listed in the claim statement for a given bug.
 * Format: 缺陷 <bug>（...）：N 个已索引用例追溯：<doc>:<node> <title>；...
 * Takes only the section after "已索引用例追溯：" and before "另有" or "，支持",
 * splits by "；", and requires each part to start with <doc>:<node>.
 */
export function extractStatementCaseIds(text: string, bug: string): string[] {
  const match = new RegExp(`缺陷\\s+${bug}[^\\n]*?\\d+\\s*个已索引用例追溯[：:]([^\\n]+)`).exec(text);
  if (!match) return [];
  let casesPart = match[1];
  const cutIdx = casesPart.search(/(?:[；;]?\s*另有|[，,]\s*支持)/);
  if (cutIdx !== -1) {
    casesPart = casesPart.slice(0, cutIdx);
  }
  const parts = casesPart.split(/[；;]/);
  const caseIds: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const m = trimmed.match(/^(\d+[：:](?:[a-z0-9]{6,}|[a-z0-9_-]+))(?:\s|$)/);
    if (!m) continue;
    caseIds.push(m[1]);
  }
  return caseIds;
}

/** Current item rendering is id | label | summary, followed by optional metadata.
 * Labels may contain separators; the producer emits `缺陷 id：title` or a bare fallback label. */
function itemRow(line: string): { bug: string; system: string | null; summary: string } | null {
  const parts = line.trim().replace(/^- /, '').split(' | ');
  if (!line.trim().startsWith('- ')) return null;
  const identity=(parts[0] ?? '').split(':');
  if(identity.length>2 || !/^\d+$/.test(identity.at(-1) ?? ''))return null;
  let system:string|null=null;try{system=identity.length===2?decodeURIComponent(identity[0]):null;}catch{return null;}
  while (parts.at(-1)?.startsWith('位置 ') || parts.at(-1)?.startsWith('可沿用 ')) parts.pop();
  if (parts.length < 3) return null;
  parts.shift();
  const bug = identity.at(-1)!;
  const summary = parts.pop()!;
  const labelId = /^缺陷 (\d+)(?:：|$)/.exec(parts.join(' | '))?.[1];
  return labelId === bug ? { bug, system, summary } : null;
}

export default function scenario(gold: TraceGold): Scenario {
  const area = '追溯矩阵';
  const pack = 'traceability';
  const pagerState = createPagerState();
  const countLines:string[]=[];

  return {
    countLines,
    name: 'traceability',
    area,
    prompt: `请对构建 ${gold.build} 出缺陷到用例的追溯矩阵。`,
    respond: (turn) =>
      pagedRespond(
        turn,
        pagerState,
        () => [
          {
            tool: 'hub_start_run',
            input: {
              pack,
              inputs: {
                defects: { external: `knowledge:index:${gold.product}:${gold.build}?kind=defect&key=bug&only=${[...new Set(gold.defects.flatMap(d=>d.ids ?? [d.bug]))].map(encodeURIComponent).join(',')}` },
                cases: { external: `knowledge:index:${gold.product}:${gold.build}?kind=case&key=defects&fields=document,node,title,system` },
              },
            },
          },
        ],
        '矩阵完成。',
      ),
    check(turns: LoggedTurn[]): Check[] {
      countLines.length=0;
      const pending=new Map<string,number>();
      const note=(reason:string,n=1)=>pending.set(reason,(pending.get(reason)??0)+n);
      const text = resultTexts(turns).join('\n');
      const lines = text.split(/\r?\n/);
      const rows = lines.map(itemRow).filter((row) => row !== null);
      const checks: Check[] = [runStarted(area, turns)];

      for (const [index, defect] of gold.defects.entries()) {
        const label = `#${index + 1} ${createHash('sha256').update(defect.bug).digest('hex').slice(0, 12)}`;
        const system=defect.system ?? (defect.systems?.length===1?defect.systems[0]:undefined);
        const matchingLines = rows.filter((row) => row.bug === defect.bug && (system===undefined || system==='unknown' || row.system===system)).map((row) => row.summary);

        if (matchingLines.length === 0) {
          checks.push({
            area,
            name: defect.cases.length === 0 ? `${label} 没有用例的缺陷需确定核对` : `${label} 列出的用例与独立连接一致`,
            expected: defect.cases.length === 0 ? '范围和缺席观察支持的确定结论' : `${defect.cases.length} 个用例`,
            actual: '条目未出现',
            ok: false,
          });
          continue;
        }

        if (defect.cases.length === 0) {
          note('缺完整范围或缺席观察');
          const isUnknown = matchingLines.some((l) => l.includes('无已索引用例（未知）'));
          checks.push({
            area,
            name: `${label} 没有用例的缺陷需确定核对`,
            expected: '范围和缺席观察支持的确定结论',
            actual: isUnknown ? '追溯仍未知：缺完整范围或缺席观察；下一步请集成者补齐对应事实并重跑' : '未取得可核验的确定缺席结论；下一步补齐范围和缺席观察',
            ok: false,
          });
        } else {
          const countMatch = matchingLines.map((l) => /(?:^|[；;])\s*(\d+)\s*个用例(?=[；;]|$)/.exec(l)).find(Boolean);
          const reportedCount = countMatch ? Number.parseInt(countMatch[1], 10) : null;
          const countOk = reportedCount === defect.cases.length;

          const reportedCaseIds = extractStatementCaseIds(text, defect.bug);
          const expectedListedCount = Math.min(5, defect.cases.length);
          const hasExpectedCount = reportedCaseIds.length === expectedListedCount;
          const goldCaseIds = new Set(defect.cases.map((c) => c.id));
          const allBelong = reportedCaseIds.every((id) => goldCaseIds.has(id));
          const casesOk = hasExpectedCount && allBelong;

          const ok = countOk && casesOk;
          let actual = '一致';
          if (!countOk) {
            actual = `用例数不一致（报告 ${reportedCount ?? '无'} 个，独立依据 ${defect.cases.length} 个）`;
          } else if (!casesOk) {
            const notInGold = reportedCaseIds.filter((id) => !goldCaseIds.has(id));
            if (notInGold.length > 0) {
              actual = `不属于独立依据的用例 ${notInGold.length} 个`;
            } else {
              actual = `列出用例数不足（报告 ${reportedCaseIds.length} 个，期望 ${expectedListedCount} 个）`;
            }
          }

          checks.push({
            area,
            name: `${label} 列出的用例与独立连接一致`,
            expected: `${defect.cases.length} 个用例（前 ${expectedListedCount} 个属于独立依据）`,
            actual,
            ok,
          });
        }

        if (defect.defect_system_status !== undefined) {
          if(defect.defect_system_status===null&&system!=='bugzilla')note('缺陷系统状态仍未取得');
          const knownUnread=system==='bugzilla';
          const expectedStatus = defect.defect_system_status === null
            ? (defect.defect_system_unknown_reason ? `未知（${defect.defect_system_unknown_reason}）` : '未知')
            : defect.defect_system_status;
          const escaped = expectedStatus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const statusPattern = new RegExp(`缺陷\\s+${defect.bug}[^\\n]*缺陷系统[：:]\\s*${escaped}`);
          const hasStatus = knownUnread ? text.includes('状态未读：系统未接入（bugzilla）') : statusPattern.test(text);
          checks.push({
            area,
            name: `${label} 缺陷系统状态与独立依据一致`,
            expected: '状态一致',
            actual: knownUnread&&hasStatus?'系统未接入事实一致':defect.defect_system_status===null?'状态仍未知；下一步按原回执补读缺陷系统事实后重跑':hasStatus?'状态一致':'状态不一致或未出现',
            ok: hasStatus && (knownUnread || defect.defect_system_status!==null),
          });
        }
      }

      // A status that was never read is not 0. When the gold carries no closed status AT ALL (no aggregate, no
      // per-defect status — a trace.ts run without --plm), the check fails loudly and names the rerun instead of
      // comparing the Hub's counts with an invented 0 (item 5).
      const anyClosedStatus = gold.closed_defects !== undefined || gold.defects.some((d) => d.closed !== undefined);
      if (!anyClosedStatus) {
        checks.push({
          area,
          name: '已关闭缺陷统计与独立依据一致',
          expected: '标准答案写出已关闭统计',
          actual: '标准答案没有已关闭状态：重跑 trace.ts，加 --plm --closed-statuses',
          ok: false,
        });
      } else {
        const closedRows = gold.defects.filter((d) => d.closed === true);
        const closedDefects = gold.closed_defects ?? closedRows.length;
        const expectedCounts = `已关闭缺陷 ${closedDefects} 个：已追溯 ${gold.closed_traced ?? closedRows.filter((d) => d.cases.length > 0).length} 个，未追溯 ${gold.closed_untraced ?? closedRows.filter((d) => d.cases.length === 0).length} 个`;
        const hasClosedCounts = text.includes(expectedCounts);
        checks.push({
          area,
          name: '已关闭缺陷统计与独立依据一致',
          expected: expectedCounts,
          actual: hasClosedCounts ? expectedCounts : '统计不一致或未出现',
          ok: hasClosedCounts,
        });
      }

      if (gold.status_unknown !== undefined) {
        const expectedUnknown = `缺陷系统状态未知 ${gold.status_unknown} 个（不算已关闭也不算未关闭）`;
        const hasUnknownCounts = text.includes(expectedUnknown);
        checks.push({
          area,
          name: '缺陷系统状态未知统计与独立依据一致',
          expected: expectedUnknown,
          actual: gold.status_unknown!>0?'仍有状态未知的检查；下一步补齐缺陷系统事实后重跑':hasUnknownCounts?expectedUnknown:'统计不一致或未出现',
          ok: hasUnknownCounts && gold.status_unknown===0,
        });
      }

      const positive = gold.defects.filter((d) => d.closed === true && d.cases.length > 0).length;
      // Without closed statuses the missing fact is which defects are closed and the next action is re-reading PLM;
      // only a gold that DID read statuses and found nothing points at other builds.
      const hasClosedStatus = gold.defects.some((d) => d.closed !== undefined) || gold.closed_defects !== undefined;
      checks.push({ area, name: '已关闭且已追溯的缺陷至少 1 个', expected: '至少 1 个', actual: positive > 0 ? `${positive} 个` : hasClosedStatus ? '0 个，正例没核到；导出其他构建并执行 trace-scan' : '未读：标准答案没有已关闭状态；重跑 trace.ts，加 --plm --closed-statuses', ok: positive > 0 });
      const outcomes=lines.map(claimVerdict);
      const unresolved=lines.filter(line=>claimVerdict(line)==='unknown');
      if (!outcomes.some(verdict=>verdict!==null)) checks.push({area,name:'结构化判定可用',expected:'verdict、reason、missing 字段',actual:'答案不完整：模型回执未携带结构化结论；下一步读取运行结果的结构化字段后重跑',ok:false});
      if(unresolved.length)checks.push({area,name:'检查不能以未知结束',expected:'未知 0 项',actual:`未知 ${unresolved.length} 项；${unresolved.map(unknownDetail).join('；')}`,ok:false});
      if(unresolved.length)note('回执仍含未知主张或状态',unresolved.length);
      for(const [reason,count] of pending)countLines.push(`未完成核对 ${count} 项；原因：${reason}；下一步：由集成者按私有原回执补齐对应事实后重读或重跑`);
      checks.push(lengthBounded(area, turns));
      return checks;
    },
  };
}
