// Capability 2, the template gap check, through the real client: one document, the Hub's count of cases compared with the
// independent count in the gold file, and the report that names the missing categories.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';

export interface GapGold {
  document: string;
  /** Number of case nodes counted independently of the Hub. */
  cases: number;
}

export default function scenario(gold: GapGold): Scenario {
  const area = '模板缺口检查';
  const pack = 'template-gap';
  return {
    name: 'template-gap',
    area,
    prompt: `请按团队模板检查敏捷平台上的测试脑图 ${gold.document} 缺哪些类别。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack, inputs: { documents: { external: `agile:mindmap:${gold.document}` } } } }]
        : [{ text: '检查完成。' }],
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const has = (needle: string): boolean => text.includes(needle);
      return [
        { area, name: '模型拿到了运行结果，不是错误', expected: '回答里有“运行 run_…”，没有“出错”', actual: has('运行 run_') && !has('出错：') ? '有运行结果' : text.slice(0, 120), ok: has('运行 run_') && !has('出错：') },
        { area, name: '用例数与独立的数法一致', expected: `用例 ${gold.cases} 个`, actual: has(`用例 ${gold.cases} 个`) ? '一致' : '不一致', ok: has(`用例 ${gold.cases} 个`) },
        { area, name: '给出缺的类别，不是只给一个数', expected: '条目摘要里有“缺 N 个模板类别”和类别名', actual: /缺 \d+ 个模板类别：/.test(text) ? '有' : '没有', ok: /缺 \d+ 个模板类别：/.test(text) },
        { area, name: '回答没有超过客户端能转交的长度', expected: '每个工具结果不超过 30000 个字符', actual: `最长 ${Math.max(0, ...resultTexts(turns).map((t) => t.length))} 个字符`, ok: resultTexts(turns).every((t) => t.length <= 30_000) },
      ];
    },
  };
}
