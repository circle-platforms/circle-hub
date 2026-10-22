// Capability 3, case location, through the real client: the model starts the production run for one document and the Hub's
// answer is compared with the answer written down independently in the gold file (from the path convention of the owner's
// attribution scheme read by hand).
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';

export interface LocationGold {
  document: string;
  /** The product name to start the run with, and the product line it must be located in. */
  product: string;
  line: string;
  train?: string;
}

export default function scenario(gold: LocationGold): Scenario {
  const area = '用例定位';
  return {
    name: 'case-location',
    area,
    prompt: `请对敏捷平台上的测试脑图 ${gold.document} 做用例定位。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack: 'case-location@1.0.0', product: gold.product, inputs: { documents: { external: `agile:mindmap:${gold.document}` } } } }]
        : [{ text: '定位完成。' }],
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const has = (needle: string): boolean => text.includes(needle);
      const checks: Check[] = [
        { area, name: '模型拿到了运行结果，不是错误', expected: '回答里有“运行 run_…”，没有“出错”', actual: has('运行 run_') && !has('出错：') ? '有运行结果' : text.slice(0, 120), ok: has('运行 run_') && !has('出错：') },
        { area, name: '要求项 location 满足', expected: 'location 用例定位：满足 1', actual: has('location 用例定位：满足 1') ? '满足 1' : '未满足', ok: has('location 用例定位：满足 1') },
        { area, name: '版本线与独立依据一致', expected: `版本 ${gold.line}（目录，置信度高）`, actual: has(`版本 ${gold.line}（目录，置信度高）`) ? '一致' : '不一致', ok: has(`版本 ${gold.line}（目录，置信度高）`) },
        { area, name: '产品线', expected: `产品线 apv`, actual: has('产品线 apv') ? '一致' : '不一致', ok: has('产品线 apv') },
        { area, name: '回答没有超过客户端能转交的长度', expected: '每个工具结果不超过 30000 个字符', actual: `最长 ${Math.max(0, ...resultTexts(turns).map((t) => t.length))} 个字符`, ok: resultTexts(turns).every((t) => t.length <= 30_000) },
      ];
      if (gold.train !== undefined) checks.splice(3, 0, { area, name: '发布火车与独立依据一致', expected: `发布火车 ${gold.train}`, actual: has(`发布火车 ${gold.train}`) ? '一致' : '不一致', ok: has(`发布火车 ${gold.train}`) });
      return checks;
    },
  };
}
