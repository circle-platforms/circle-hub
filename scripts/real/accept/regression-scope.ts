// Capability 4a, the regression scope, through the real client: the Hub's scope of a build pair is compared with the
// independent command diff in the gold file (added+modified paths are the changed paths; removed paths are not in the
// scope), and every case of the scope sits on a changed path while a case off them is out.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';
import { lengthBounded, pathSetMatches, runStarted } from './checks.ts';

export interface ScopeCaseGold {
  /** The item id as the Hub writes it (document:node). */
  id: string;
  path: string;
}

export interface ScopeGold {
  /** Optional independently measured count of cases without parsed commands. */
  unplaced?: number;
  product: string;
  earlier: string;
  later: string;
  /** added+modified of gold/command-diff.ts: the paths a case on them is in scope for. */
  changed: string[];
  /** removed paths of gold/command-diff.ts (not part of the scope). */
  removed: string[];
  /** The gold's change kind per path (added/modified/removed): the Hub's answer states each one. */
  kinds?: Array<{ path: string; kind: 'added' | 'modified' | 'removed' }>;
  /** The cases the gold expects in the scope, each on a changed path. */
  inScope: ScopeCaseGold[];
  /** Item ids the gold expects outside the scope (cases off every changed path). */
  outOfScope: string[];
}

export default function scenario(gold: ScopeGold): Scenario {
  const area = '回归范围';
  const pack = 'regression-scope';
  return {
    name: 'regression-scope',
    area,
    prompt: `请对比 ${gold.earlier} 和 ${gold.later} 两个构建，给出回归范围。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack, inputs: { impact: { external: `knowledge:impact:${gold.product}:${gold.earlier}..${gold.later}?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1` }, facets: { external: `knowledge:facets:${gold.product}:${gold.later}?kind=case&by=commands` } } } }]
        : [{ text: '对比完成。' }],
    check(turns: LoggedTurn[]): Check[] {
      const text = resultTexts(turns).join('\n');
      const hubPaths = [...text.matchAll(/\/commands\/[a-z0-9_.\-/]+/gi)].map((m) => m[0]);
      const unique = [...new Set(hubPaths)];
      const changedChecks = pathSetMatches(area, '变更路径（范围里的原因路径加未覆盖的路径）', gold.changed, unique.filter((p) => !gold.removed.includes(p)));
      const caseChecks = gold.inScope.map((c) => ({
        area,
        name: `范围里的用例 ${c.id} 放在变更路径上`,
        expected: `条目 ${c.id} 的路径 ${c.path}`,
        actual: text.includes(c.id) && text.includes(c.path) ? '在' : '不在',
        ok: text.includes(c.id) && text.includes(c.path),
      }));
      const outChecks = gold.outOfScope.map((id) => ({
        area,
        name: `不在变更路径上的用例 ${id} 不在范围里`,
        expected: `回答里没有条目 ${id}`,
        actual: text.includes(id) ? '出现了' : '没有出现',
        ok: !text.includes(id),
      }));
      // The scope never lists removed paths (they hold no later-build case), so a removed kind is not
      // checked against the answer text — the path-set check above already proves it is absent.
      const kindChecks = (gold.kinds ?? []).filter((k) => k.kind !== 'removed').map((k) => ({
        area,
        name: `路径 ${k.path} 的变更种类是 ${k.kind}`,
        expected: `回答里 ${k.path} 标为 ${k.kind}`,
        actual: new RegExp(`${k.path}[^\\n]{0,40}${k.kind}`).test(text) ? `${k.kind}` : '不是',
        ok: new RegExp(`${k.path}[^\\n]{0,40}${k.kind}`).test(text),
      }));
      return [...unplacedChecks(area, gold.unplaced, text), runStarted(area, turns), ...changedChecks, ...kindChecks, ...caseChecks, ...outChecks, lengthBounded(area, turns)];
    },
  };
}

/** Only the measured numbers enter this check; no case identifiers or paths. */
function unplacedChecks(area: string, expected: number | undefined, text: string): Check[] {
  if (expected === undefined) return [];
  const actual = [...new Set([...text.matchAll(/(\d+) 个用例没有解析出命令/g)].map((m) => Number(m[1])))];
  return [{ area, name: '未归位用例数', expected: String(expected), actual: actual.length ? actual.join('、') : '未给出', ok: Number.isSafeInteger(expected) && expected >= 0 && actual.length === 1 && actual[0] === expected }];
}
