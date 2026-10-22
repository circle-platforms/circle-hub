// Capability 5, the traceability matrix, through the real client: the Hub's matrix of one build is compared with the
// independent double-loop join in the gold file — every defect's listed cases are the same, a defect with no case is
// reported as unknown.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
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
  const pack = 'traceability';
  const pagerState = createPagerState();

  return {
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
                defects: { external: `knowledge:index:${gold.product}:${gold.build}?kind=defect&key=bug` },
                cases: { external: `knowledge:index:${gold.product}:${gold.build}?kind=case&key=defects&fields=document,node,title` },
              },
            },
          },
        ],
        '矩阵完成。',
      ),
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const lines = text.split(/\r?\n/);
      const checks: Check[] = [runStarted(area, turns)];

      for (const defect of gold.defects) {
        const linePrefix = `- ${defect.bug} | 缺陷 ${defect.bug} |`;
        const entryLine = lines.find((line) => line.trim().startsWith(linePrefix));

        if (!entryLine) {
          checks.push({
            area,
            name: defect.cases.length === 0 ? `没有用例的缺陷 ${defect.bug} 是未知` : `缺陷 ${defect.bug} 列出的用例与独立连接一致`,
            expected: defect.cases.length === 0 ? '无已索引用例（未知）' : `${defect.cases.length} 个用例`,
            actual: '条目未出现',
            ok: false,
          });
          continue;
        }

        if (defect.cases.length === 0) {
          const isUnknown = entryLine.includes('无已索引用例（未知）');
          checks.push({
            area,
            name: `没有用例的缺陷 ${defect.bug} 是未知`,
            expected: '无已索引用例（未知）',
            actual: isUnknown ? '无已索引用例（未知）' : entryLine.trim(),
            ok: isUnknown,
          });
        } else {
          const countMatch = /(\d+)\s*个用例/.exec(entryLine);
          const reportedCount = countMatch ? Number.parseInt(countMatch[1], 10) : null;
          const countOk = reportedCount === defect.cases.length;

          // Check up to the first 30 cases in the text (the full result)
          const checkCases = defect.cases.slice(0, 30);
          const missingCases = checkCases.filter((c) => !text.includes(c.id));
          const casesOk = missingCases.length === 0;

          const ok = countOk && casesOk;
          let actual = '一致';
          if (!countOk) {
            actual = `用例数不一致（报告 ${reportedCount ?? '无'} 个，独立依据 ${defect.cases.length} 个）`;
          } else if (!casesOk) {
            actual = `缺 ${missingCases.map((c) => c.id).join('、')}`;
          }

          checks.push({
            area,
            name: `缺陷 ${defect.bug} 列出的用例与独立连接一致`,
            expected: `${defect.cases.length} 个用例（${checkCases.map((c) => c.id).join('、')}）`,
            actual,
            ok,
          });
        }
      }
      checks.push(lengthBounded(area, turns));
      return checks;
    },
  };
}
