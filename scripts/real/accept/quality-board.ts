import { labelOf } from '../../../contracts/generated/vocabulary.ts';
// Independently compare every (version line, module) group from agile tree locations and mindmap counts.
import { createPagerState, pagedRespond } from '../lib/pager.ts';
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';
import { lengthBounded, runStarted } from './checks.ts';

export interface BoardTotalsGold {
  cases: number;
  missing: number;
  vague: number;
  negative: number;
}

export interface BoardGroupGold {
  coverage?: { present: string[]; missing: string[]; untagged: number };
  /** The group label: '版本线/模块'（模块 unplaced when the module is null）. */
  label: string;
  cases: number;
  missing: number;
  vague: number;
  negative: number;
}

export interface BoardGold {
  types?: boolean;
  /** Bind the placement view (quality-board 1.1+): set by board.ts --types/--unplaced or by hand. Without it the
   * scenario sends the 1.0.x request, which has no placement slot. */
  placement?: boolean;
  unplaced?: number;
  product: string;
  build: string;
  totals?: BoardTotalsGold;
  groups?: BoardGroupGold[];
}

/** One decimal place with a percent sign, rounded from num / den * 100. */
export function percentOf(num: number, den: number): string {
  return `${(den === 0 ? 0 : Math.round((num / den) * 1000) / 10).toFixed(1)}%`;
}

interface ParsedTotals {
  cases: number;
  missing: number;
  pMissing: string;
  vague: number;
  pVague: string;
  negative: number;
  pNegative: string;
}

function parseReportedTotals(text: string): ParsedTotals | null {
  const match = /合计：\s*用例\s*(\d+)\s*个；无期望结果\s*(\d+)\s*个（([0-9.]+)%）；含糊期望\s*(\d+)\s*个（([0-9.]+)%）；负面用例\s*(\d+)\s*个（([0-9.]+)%）/.exec(text);
  if (!match) return null;
  return {
    cases: Number(match[1]),
    missing: Number(match[2]),
    pMissing: `${match[3]}%`,
    vague: Number(match[4]),
    pVague: `${match[5]}%`,
    negative: Number(match[6]),
    pNegative: `${match[7]}%`,
  };
}

export function parseGroups(text: string): Map<string, string> {
  const groups = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*] ([^|]+)\s*\|(?:[^|]*\|)?\s*(用例[^|\n]*)/.exec(line);
    // Both sides trimmed: the Hub separates columns with ' | ', and the summary must not keep the space before it.
    if (match) groups.set(match[1].trim(), match[2].trim());
  }
  return groups;
}

export default function scenario(gold: BoardGold): Scenario {
  const area = '质量看板';
  const pack = 'quality-board';
  const pager = createPagerState();

  const totals: BoardTotalsGold = gold.totals ?? (
    gold.groups && gold.groups.length > 0
      ? {
          cases: gold.groups.reduce((acc, g) => acc + g.cases, 0),
          missing: gold.groups.reduce((acc, g) => acc + g.missing, 0),
          vague: gold.groups.reduce((acc, g) => acc + g.vague, 0),
          negative: gold.groups.reduce((acc, g) => acc + g.negative, 0),
        }
      : { cases: 0, missing: 0, vague: 0, negative: 0 }
  );

  return {
    name: 'quality-board',
    area,
    prompt: `请对构建 ${gold.build} 出用例质量看板。`,
    respond: (turn) => pagedRespond(turn, pager, () => [{ tool: 'hub_start_run', input: { pack, inputs: {
      facets: gold.types ? [
        { external: `knowledge:facets:${gold.product}:${gold.build}?kind=case&by=line,module,has_expected,vague_expected,negative` },
        { external: `knowledge:facets:${gold.product}:${gold.build}?kind=case&by=line,module,tags` },
      ] : { external: `knowledge:facets:${gold.product}:${gold.build}?kind=case&by=line,module,has_expected,vague_expected,negative` },
      // Placement is bound only when the gold asks for it (board.ts --types/--unplaced or by hand): the deployed
      // 1.0.1 pack has no placement slot and refuses the run (hub/runs/engine/inputs.ts).
      ...(gold.placement === true || gold.unplaced !== undefined || gold.types === true ? { placement: { external: `knowledge:facets:${gold.product}:${gold.build}?kind=case&by=commands` } } : {}),
    } } }], '看板完成。'),
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const checks: Check[] = [runStarted(area, turns)];

      const reportedTotals = parseReportedTotals(text);
      const countsOk = reportedTotals !== null &&
        reportedTotals.cases === totals.cases &&
        reportedTotals.missing === totals.missing &&
        reportedTotals.vague === totals.vague &&
        reportedTotals.negative === totals.negative;

      checks.push({
        area,
        name: '合计：用例数与三项指标数值与独立依据一致',
        expected: `用例 ${totals.cases} 个；无期望结果 ${totals.missing} 个；含糊期望 ${totals.vague} 个；负面用例 ${totals.negative} 个`,
        actual: reportedTotals
          ? `用例 ${reportedTotals.cases} 个；无期望结果 ${reportedTotals.missing} 个；含糊期望 ${reportedTotals.vague} 个；负面用例 ${reportedTotals.negative} 个`
          : '未找到合计句子',
        ok: countsOk,
      });

      const expPMissing = percentOf(totals.missing, totals.cases);
      const expPVague = percentOf(totals.vague, totals.cases);
      const expPNegative = percentOf(totals.negative, totals.cases);
      const percentOk = reportedTotals !== null &&
        reportedTotals.pMissing === expPMissing &&
        reportedTotals.pVague === expPVague &&
        reportedTotals.pNegative === expPNegative;

      checks.push({
        area,
        name: '合计：各项指标百分比与计算值一致',
        expected: `无期望结果（${expPMissing}）；含糊期望（${expPVague}）；负面用例（${expPNegative}）`,
        actual: reportedTotals
          ? `无期望结果（${reportedTotals.pMissing}）；含糊期望（${reportedTotals.pVague}）；负面用例（${reportedTotals.pNegative}）`
          : '未找到合计句子',
        ok: percentOk,
      });

      const reported = parseGroups(text);
      const expectedGroups = gold.groups ?? [];
      const expectedLabels = new Set(expectedGroups.map((g) => g.label));
      const extra = [...reported.keys()].filter((label) => !expectedLabels.has(label)).length;
      const absent = expectedGroups.filter((g) => !reported.has(g.label)).length;
      checks.push({ area, name: '分组集合与独立依据一致', expected: `${expectedGroups.length} 组`, actual: `${reported.size} 组；多 ${extra} 组；少 ${absent} 组`, ok: extra === 0 && absent === 0 });
      for (const [index, group] of expectedGroups.entries()) {
        const summary = reported.get(group.label) ?? '';
        const cases = /用例\s*(\d+)\s*个/.exec(summary);
        let ok = cases !== null && Number(cases[1]) === group.cases;
        for (const [name, key] of [['无期望结果', 'missing'], ['含糊期望', 'vague'], ['负面用例', 'negative']] as const) {
          const match = new RegExp(`${name}\\s*(?:(\\d+)\\s*个（)?([0-9.]+)%`).exec(summary);
          ok = ok && match !== null && `${match[2]}%` === percentOf(group[key], group.cases) && (match[1] === undefined || Number(match[1]) === group[key]);
        }
        if (gold.types && group.coverage) {
          const untagged = /未打标签 (\d+) 个/.exec(summary);
          const missing = /没有用例带这些类型的标签：([^；\n]+)/.exec(summary);
          const reportedMissing = missing?.[1] === undefined ? undefined : missing[1].trim() === '无' ? [] : missing[1].split('、').map((type) => type.trim()).filter((type) => type !== '').sort();
          ok = ok && untagged !== null && Number(untagged[1]) === group.coverage.untagged && JSON.stringify(reportedMissing) === JSON.stringify([...group.coverage.missing].sort()) && !summary.includes('部分');
        }
        checks.push({ area, name: `#${index + 1} 分组指标一致`, expected: `${group.cases} 个；${group.missing}、${group.vague}、${group.negative}`, actual: ok ? '一致' : '缺组或计数、比例不一致', ok });
      }

      // Whenever placement is bound the Hub states the unplaced count; without a gold number a missing sentence is
      // a mismatch (a Hub output never given is 不符), with one the numbers must agree.
      if (gold.placement === true || gold.unplaced !== undefined || gold.types === true) {
        const label = labelOf('knowledge_count', 'commandless_cases');
        // Current generated wording, with legacy receipts still readable.
        const count = /^(\d+) 个/.exec(text.split(label + ' ')[1] ?? '') ?? /(\d+) 个用例没有解析出命令/.exec(text);
        const bound = gold.placement === true || gold.unplaced !== undefined || gold.types === true;
        const ok = bound && count !== null && (gold.unplaced === undefined || Number(count[1]) === gold.unplaced);
        checks.push({ area, name: gold.unplaced === undefined ? 'Hub 写出未归位用例数' : '未归位用例数与独立依据一致', expected: gold.unplaced === undefined ? `摘要里有“${label} N 个”` : `${gold.unplaced}`, actual: count ? `${count[1]}` : '未读到', ok });
      }

      checks.push({
        area,
        name: '看板说明它只描述索引里的用例',
        expected: '说明里有“已索引的用例”',
        actual: text.includes('已索引的用例') ? '有' : '没有',
        ok: text.includes('已索引的用例'),
      });
      checks.push(lengthBounded(area, turns));
      return checks;
    },
  };
}
