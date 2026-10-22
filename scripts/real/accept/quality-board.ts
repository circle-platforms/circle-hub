// Capability 6, the quality board, through the real client: the Hub's board of one build is compared against the
// independent case counts in the gold file (cases, missing expected, vague expected, negative). The scenario checks
// the "合计" sentence for exact counts and rounded percentages, and verifies that the sum of each group's case count
// equals the total case count. Note: group attribution is calculated by Hub based on the commands touched by each case,
// not an independent gold fact, so group breakdown is checked by sum rather than per-group attribution.
// The board describes the indexed cases only — the limitation the pack's own statement carries is checked to be shown too.
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
  /** The group label: '版本线/模块'（模块 unplaced when the module is null）. */
  label: string;
  cases: number;
  missing: number;
  vague: number;
  negative: number;
}

export interface BoardGold {
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

function parseGroupCases(text: string): number[] {
  const withoutTotals = text.replace(/合计[：:][^\n。]+(?:。|\n|$)/g, '');
  const matches = [...withoutTotals.matchAll(/(?:(?:分组|条目)\s*[^：:\n|]+[：:|]|[-*]\s*[\w./-]+\s*\|\s*)?用例\s*(\d+)\s*个/g)];
  return matches.map((m) => Number(m[1]));
}

export default function scenario(gold: BoardGold): Scenario {
  const area = '质量看板';
  const pack = 'quality-board';

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
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack, inputs: { facets: { external: `knowledge:facets:${gold.product}:${gold.build}?kind=case&by=line,module,has_expected,vague_expected,negative` } } } }]
        : [{ text: '看板完成。' }],
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

      const groupCases = parseGroupCases(text);
      const groupSum = groupCases.reduce((a, b) => a + b, 0);
      const groupSumOk = groupCases.length > 0 && groupSum === totals.cases;

      checks.push({
        area,
        name: '各分组用例数之和与合计用例数一致',
        expected: `各组之和等于 ${totals.cases}`,
        actual: groupCases.length > 0
          ? `共 ${groupCases.length} 组，各组用例数之和为 ${groupSum}（${groupCases.join(' + ')}）`
          : '未找到分组用例数',
        ok: groupSumOk,
      });

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
