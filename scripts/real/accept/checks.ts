// Shared check blocks of the four capability-4 scenarios: the run started, the length guard and the comparison of
// a Hub-reported path set with the gold answer. Texts follow the pack READMEs (the run banner, the scope note,
// the sweep reasons, the matrix rows and the board summary).
import { resultTexts, type LoggedTurn } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';

/** The run started and the model was shown its result, not an error. */
export const runStarted = (area: string, turns: LoggedTurn[]): Check => {
  const text = resultTexts(turns).join('\n');
  return {
    area,
    name: '模型拿到了运行结果，不是错误',
    expected: '回答里有“运行 run_…”，没有“出错”',
    actual: text.includes('运行 run_') && !text.includes('出错：') ? '有运行结果' : text.slice(0, 120),
    ok: text.includes('运行 run_') && !text.includes('出错：'),
  };
};

/** No tool result exceeds what the client forwards. */
export const lengthBounded = (area: string, turns: LoggedTurn[]): Check => {
  const lengths = resultTexts(turns).map((t) => t.length);
  return {
    area,
    name: '回答没有超过客户端能转交的长度',
    expected: '每个工具结果不超过 30000 个字符',
    actual: `最长 ${Math.max(0, ...lengths)} 个字符`,
    ok: lengths.every((l) => l <= 30_000),
  };
};

/** Every gold path appears in the Hub's text, and every Hub path is one of the gold paths. */
export const pathSetMatches = (area: string, label: string, gold: readonly string[], hubPaths: readonly string[]): Check[] => {
  const hubSet = new Set(hubPaths);
  const goldSet = new Set(gold);
  const missing = gold.filter((p) => !hubSet.has(p));
  const extra = hubPaths.filter((p) => !goldSet.has(p));
  return [
    {
      area,
      name: `${label}：Hub 报出的路径与独立依据一致`,
      expected: `共 ${gold.length} 条，逐条相等`,
      actual: missing.length === 0 && extra.length === 0 ? `共 ${hubPaths.length} 条，逐条相等` : `缺 ${missing.length} 条（${missing.slice(0, 5).join('、')}），多 ${extra.length} 条（${extra.slice(0, 5).join('、')}）`,
      ok: missing.length === 0 && extra.length === 0,
    },
  ];
};
