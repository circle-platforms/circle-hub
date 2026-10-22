// Capability 6, the quality board, through the real client: the Hub's board of one build is compared group by group with
// the independent case counts in the gold file (cases, missing expected, vague expected, negative). The board describes
// the indexed cases only — the limitation the pack's own statement carries is checked to be shown to the model too.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';
import { lengthBounded, runStarted } from './checks.ts';

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
  groups: BoardGroupGold[];
}

export default function scenario(gold: BoardGold): Scenario {
  const area = '质量看板';
  const pack = 'quality-board';
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
      for (const group of gold.groups) {
        const at = text.indexOf(group.label);
        const near = at >= 0 ? text.slice(Math.max(0, at - 80), at + 300) : '';
        const numbers = {
          cases: new RegExp(`用例 ${group.cases} 个`).test(near),
          missing: new RegExp(`无期望结果 ${group.missing}`).test(near),
          vague: new RegExp(`含糊期望 ${group.vague}`).test(near),
          negative: new RegExp(`负面用例 ${group.negative}`).test(near),
        };
        checks.push({
          area,
          name: `分组 ${group.label} 的计数与独立数法一致`,
          expected: `用例 ${group.cases} 个；无期望结果 ${group.missing}；含糊期望 ${group.vague}；负面用例 ${group.negative}`,
          actual: Object.values(numbers).every(Boolean) ? '一致' : near.slice(0, 120) || '分组没有出现',
          ok: Object.values(numbers).every(Boolean),
        });
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
