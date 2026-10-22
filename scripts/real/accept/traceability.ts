// Capability 5, the traceability matrix, through the real client: the Hub's matrix of one build is compared with the
// independent double-loop join in the gold file — every defect's listed cases are the same, a defect with no case is
// reported as unknown.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
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
  /** The cases the independent join found; empty when untraced. */
  cases: JoinCaseGold[];
}

export interface TraceGold {
  product: string;
  build: string;
  defects: DefectGold[];
}

export default function scenario(gold: TraceGold): Scenario {
  const area = '追溯矩阵';
  const pack = 'traceability@1.0.0';
  return {
    name: 'traceability',
    area,
    prompt: `请对构建 ${gold.build} 出缺陷到用例的追溯矩阵。`,
    respond: (turn) =>
      turn.index === 0
        ? [
            {
              tool: 'hub_start_run',
              input: {
                pack,
                product: gold.product,
                inputs: {
                  defects: { external: `knowledge:index:${gold.product}:${gold.build}?kind=defect&key=bug` },
                  cases: { external: `knowledge:index:${gold.product}:${gold.build}?kind=case&key=defects` },
                },
              },
            },
          ]
        : [{ text: '矩阵完成。' }],
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const checks: Check[] = [runStarted(area, turns)];
      for (const defect of gold.defects) {
        const at = text.indexOf(defect.bug);
        const near = at >= 0 ? text.slice(Math.max(0, at - 100), at + 600) : '';
        const listed = defect.cases.map((c) => near.includes(c.id));
        if (defect.cases.length === 0) {
          checks.push({
            area,
            name: `没有用例的缺陷 ${defect.bug} 是未知`,
            expected: `${defect.bug} 一行列出的用例为空（未知）`,
            actual: at < 0 ? '缺陷没有出现' : /未知|没有用例|无/.test(near) ? '未知' : near.slice(0, 120),
            ok: at >= 0 && /未知|没有用例|无/.test(near),
          });
        } else {
          checks.push({
            area,
            name: `缺陷 ${defect.bug} 列出的用例与独立连接一致`,
            expected: defect.cases.map((c) => c.id).join('、'),
            actual: listed.every(Boolean) ? '一致' : `缺 ${defect.cases.filter((_, k) => !listed[k]).map((c) => c.id).join('、')}`,
            ok: listed.every(Boolean),
          });
        }
      }
      checks.push(lengthBounded(area, turns));
      return checks;
    },
  };
}
