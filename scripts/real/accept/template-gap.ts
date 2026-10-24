// Capability 2, the template gap check, through the real client: one document, the Hub's count of cases compared with the
// independent count in the gold file, and the report that names the missing categories.
// Gold: { document, cases, product?, build?, case_index? }. A build or case_index:true enables the document-scoped
// command index and requires nonblank product and build. case_index:false does not disable an index implied by build.
// Legacy gold without either trigger checks document categories only; it makes no command-coverage claim.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';

export interface GapGold {
  document: string;
  /** Number of case nodes counted independently of the Hub. */
  cases: number;
  product?: string;
  build?: string;
  case_index?: boolean;
}

export default function scenario(gold: GapGold): Scenario {
  const area = '模板缺口检查';
  const pack = 'template-gap';
  const bindIndex = gold.build !== undefined || gold.case_index === true;
  if (bindIndex) {
    const missing = (['product', 'build'] as const).filter(key => typeof gold[key] !== 'string' || gold[key]!.trim() === '');
    if (missing.length) throw new TypeError(`按命令核对缺少 ${missing.join('、')}；下一步：在金标准补齐 product 和 build 后重跑`);
  }
  return {
    name: 'template-gap',
    area,
    prompt: `请按团队模板检查敏捷平台上的测试脑图 ${gold.document} 缺哪些类别。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack, ...(gold.product ? { product: gold.product } : {}), ...(bindIndex ? { build: gold.build } : {}), inputs: {
          documents: { external: `agile:mindmap:${gold.document}` },
          ...(bindIndex ? { case_index: { external: `knowledge:index:${gold.product}:${gold.build}?kind=case&key=document&only=${encodeURIComponent(gold.document)}&fields=document,node,commands,title,path_labels` } } : {}),
        } } }]
        : [{ text: '检查完成。' }],
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const has = (needle: string): boolean => text.includes(needle);
      const categoriesListed = /缺 \d+ 个模板类别(?:（[^（）\r\n]+）)?：/.test(text);
      return [
        { area, name: '模型拿到了运行结果，不是错误', expected: '回答里有“运行 run_…”，没有“出错”', actual: has('运行 run_') && !has('出错：') ? '有运行结果' : text.slice(0, 120), ok: has('运行 run_') && !has('出错：') },
        { area, name: '用例数与独立的数法一致', expected: `用例 ${gold.cases} 个`, actual: has(`用例 ${gold.cases} 个`) ? '一致' : '不一致', ok: has(`用例 ${gold.cases} 个`) },
        { area, name: '给出缺的类别，不是只给一个数', expected: '条目摘要里有“缺 N 个模板类别”和类别名', actual: categoriesListed ? '有' : '没有', ok: categoriesListed },
        ...(bindIndex ? [{ area, name: '按命令覆盖已计算', expected: '条目摘要给出命令数和缺类别的命令数', actual: /按命令：\d+ 个命令，\d+ 个缺类别/.test(text) ? '已计算' : '没有确定的按命令覆盖摘要', ok: /按命令：\d+ 个命令，\d+ 个缺类别/.test(text) }] : []),
        { area, name: '回答没有超过客户端能转交的长度', expected: '每个工具结果不超过 30000 个字符', actual: `最长 ${Math.max(0, ...resultTexts(turns).map((t) => t.length))} 个字符`, ok: resultTexts(turns).every((t) => t.length <= 30_000) },
      ];
    },
  };
}
