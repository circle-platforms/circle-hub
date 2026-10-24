// Capability 4b, the maintenance sweep, through the real client: the Hub's sweep of a build pair is compared with the
// independent command diff in the gold file — every case marked command-removed sits on a removed path, every case
// marked command-changed sits on a modified path, and the changed ones show a field difference.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Check } from '../lib/report.ts';
import { facetReader, facetCountCheck, withoutFacetPages, validateScopeGold } from './regression-scope.ts';
import { lengthBounded, runStarted } from './checks.ts';
import { labelOf } from '../../../contracts/generated/vocabulary.ts';

export interface SweepCaseGold {
  id: string;
  path: string;
  removed: boolean;
}

export interface SweepGold {
  /** Required totals.unplaced from independent case-commands gold for the earlier build. */
  caseCommandsUnplaced: number;
  product: string;
  earlier: string;
  later: string;
  /** The cases the gold expects: removed ones on removed paths, changed ones on modified paths. */
  cases: SweepCaseGold[];
}

export default function scenario(gold: SweepGold): Scenario {
  validateScopeGold(gold, 'maintenance-sweep');
  const area = '维护巡检';
  const pack = 'maintenance-sweep';
  const readFacets = facetReader();
  return {
    name: 'maintenance-sweep',
    area,
    prompt: `请对比 ${gold.earlier} 和 ${gold.later} 两个构建，找出需要维护的用例。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack, inputs: { impact: { external: `knowledge:impact:${gold.product}:${gold.earlier}..${gold.later}?changed=definition&attached=case&attached_fields=document,node,title&catalog=commands@1` }, facets: { external: `knowledge:facets:${gold.product}:${gold.earlier}?kind=case&by=commands` } } } }]
        : readFacets(turn, '巡检完成。'),
    check(turns: LoggedTurn[]): Check[] {
      const answerTurns = withoutFacetPages(turns);
      const text = resultTexts(answerTurns).join('\n');
      const checks: Check[] = [facetCountCheck(area, gold.caseCommandsUnplaced, turns), runStarted(area, answerTurns)];
      for (const c of gold.cases) {
        const at = text.indexOf(c.id);
        const near = at >= 0 ? text.slice(Math.max(0, at - 400), at + 400) : '';
        if (c.removed) {
          const removed = `已${labelOf('change_kind', 'removed')}`;
          checks.push({
            area,
            name: `命令${removed}的用例 ${c.id} 放在 ${labelOf('change_kind', 'removed')} 路径上`,
            expected: `${c.id} 的原因路径 ${c.path}，标记为${removed}`,
            actual: near.includes(c.path) && near.includes(removed) ? '一致' : near.slice(0, 120) || '没有出现',
            ok: near.includes(c.path) && near.includes(removed),
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
