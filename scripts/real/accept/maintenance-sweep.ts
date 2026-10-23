// Capability 4b, the maintenance sweep, through the real client: the Hub's sweep of a build pair is compared with the
// independent command diff in the gold file — every case marked command-removed sits on a removed path, every case
// marked command-changed sits on a modified path, and the changed ones show a field difference.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';
import { lengthBounded, runStarted } from './checks.ts';

export interface SweepCaseGold {
  id: string;
  path: string;
  removed: boolean;
}

export interface SweepGold {
  /** Optional independently measured count of cases without parsed commands. */
  unplaced?: number;
  product: string;
  earlier: string;
  later: string;
  /** The cases the gold expects: removed ones on removed paths, changed ones on modified paths. */
  cases: SweepCaseGold[];
}

export default function scenario(gold: SweepGold): Scenario {
  const area = '维护巡检';
  const pack = 'maintenance-sweep';
  return {
    name: 'maintenance-sweep',
    area,
    prompt: `请对比 ${gold.earlier} 和 ${gold.later} 两个构建，找出需要维护的用例。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack, inputs: { impact: { external: `knowledge:impact:${gold.product}:${gold.earlier}..${gold.later}?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1` }, facets: { external: `knowledge:facets:${gold.product}:${gold.earlier}?kind=case&by=commands` } } } }]
        : [{ text: '巡检完成。' }],
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const checks: Check[] = [...unplacedChecks(area, gold.unplaced, text), runStarted(area, turns)];
      for (const c of gold.cases) {
        const at = text.indexOf(c.id);
        const near = at >= 0 ? text.slice(Math.max(0, at - 400), at + 400) : '';
        if (c.removed) {
          checks.push({
            area,
            name: `命令已删除的用例 ${c.id} 放在 removed 路径上`,
            expected: `${c.id} 的原因路径 ${c.path}，标记为已删除`,
            actual: near.includes(c.path) && /已删除/.test(near) ? '一致' : near.slice(0, 120) || '没有出现',
            ok: near.includes(c.path) && /已删除/.test(near),
          });
        } else {
          // A field difference is a named field with old and new values (or the pack's own "字段" wording), not
          // merely the command-changed mark.
          const hasFieldDiff = /字段[^，。；]{0,40}(旧|新|→)|差异数 [1-9]|旧值|新值|字段差异/.test(near);
          checks.push({
            area,
            name: `命令已改的用例 ${c.id} 放在 modified 路径上且有字段差异`,
            expected: `${c.id} 的原因路径 ${c.path}，有字段差异`,
            actual: near.includes(c.path) && hasFieldDiff ? '一致' : near.slice(0, 120) || '没有出现',
            ok: near.includes(c.path) && hasFieldDiff,
          });
        }
      }
      checks.push(lengthBounded(area, turns));
      return checks;
    },
  };
}

/** Only the measured numbers enter this check; no case identifiers or paths. */
function unplacedChecks(area: string, expected: number | undefined, text: string): Check[] {
  if (expected === undefined) return [];
  const actual = [...new Set([...text.matchAll(/(\d+) 个用例没有解析出命令/g)].map((m) => Number(m[1])))];
  return [{ area, name: '未归位用例数', expected: String(expected), actual: actual.length ? actual.join('、') : '未给出', ok: Number.isSafeInteger(expected) && expected >= 0 && actual.length === 1 && actual[0] === expected }];
}
