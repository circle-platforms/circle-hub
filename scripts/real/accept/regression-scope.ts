// Capability 4a, the regression scope, through the real client: the Hub's scope of a build pair is compared with the
// independent command diff in the gold file (added+modified paths are the changed paths; removed paths are not in the
// scope), and every case of the scope sits on a changed path while a case off them is out.
import { resultTexts, type LoggedTurn, type Scenario } from '../lib/accept.ts';
import type { Turn, Reply } from '../scripted-model.ts';
import type { Check } from '../lib/report.ts';
import { lengthBounded, pathSetMatches, runStarted } from './checks.ts';
import { contentHeader } from './content-header.ts';
import { labelOf, type ChangeKind } from '../../../contracts/generated/vocabulary.ts';

export interface ScopeCaseGold {
  /** The item id as the Hub writes it (document:node). */
  id: string;
  path: string;
}

export interface ScopeGold {
  /** Required totals.unplaced from independent case-commands gold for the later build. */
  caseCommandsUnplaced: number;
  product: string;
  earlier: string;
  later: string;
  /** added+modified of gold/command-diff.ts: the paths a case on them is in scope for. */
  changed: string[];
  /** removed paths of gold/command-diff.ts (not part of the scope). */
  removed: string[];
  /** The gold's change kind per path (added/modified/removed): the Hub's answer states each one. */
  kinds?: Array<{ path: string; kind: ChangeKind }>;
  /** The cases the gold expects in the scope, each on a changed path. */
  inScope: ScopeCaseGold[];
  /** Item ids the gold expects outside the scope (cases off every changed path). */
  outOfScope: string[];
}

export default function scenario(gold: ScopeGold): Scenario {
  validateScopeGold(gold, 'regression-scope');
  const area = '回归范围';
  const pack = 'regression-scope';
  const readFacets = facetReader();
  return {
    name: 'regression-scope',
    area,
    prompt: `请对比 ${gold.earlier} 和 ${gold.later} 两个构建，给出回归范围。`,
    respond: (turn) =>
      turn.index === 0
        ? [{ tool: 'hub_start_run', input: { pack, inputs: { impact: { external: `knowledge:impact:${gold.product}:${gold.earlier}..${gold.later}?changed=definition&attached=case&attached_fields=document,node,title,priority,negative&catalog=commands@1` }, facets: { external: `knowledge:facets:${gold.product}:${gold.later}?kind=case&by=commands` } } } }]
        : readFacets(turn, '对比完成。'),
    check(turns: LoggedTurn[]): Check[] {
      const answerTurns = withoutFacetPages(turns);
      const text = resultTexts(answerTurns).join('\n');
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
      // The full diff table includes removed rows marked outside the regression scope.
      // Check every supplied kind while keeping removed paths out of the changed-path set above.
      const kindChecks = (gold.kinds ?? []).map((k) => {
        const label = labelOf('change_kind', k.kind);
        const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // The label must immediately follow this complete path, not a neighboring table row.
        const matches = new RegExp(`${escape(k.path)}(?:[ \\t]+|[ \\t]*[（(][ \\t]*)${escape(label)}(?=[\\s）)；;，,。:：]|$)`).test(text);
        return {
          area,
          name: `路径 ${k.path} 的变更种类是 ${label}`,
          expected: `回答里 ${k.path} 标为 ${label}`,
          actual: matches ? label : '不是',
          ok: matches,
        };
      });
      return [facetCountCheck(area, gold.caseCommandsUnplaced, turns), runStarted(area, answerTurns), ...changedChecks, ...kindChecks, ...caseChecks, ...outChecks, lengthBounded(area, turns)];
    },
  };
}

/** Only the measured numbers enter this check; no case identifiers or paths. */
export function unplacedChecks(area: string, expected: number | undefined, text: string): Check[] {
  if (expected === undefined) return [];
  const actual = [...new Set([...text.matchAll(/(\d+) 个用例没有解析出命令/g)].map((m) => Number(m[1])))];
  return [{ area, name: '回放运行说明未归位用例数', expected: String(expected), actual: actual.length ? actual.join('、') : '未给出', ok: Number.isSafeInteger(expected) && expected >= 0 && actual.length === 1 && actual[0] === expected }];
}

/** The bound source, never a newly computed view: this is exactly the hint the projection validated. */
export function boundFacetReference(texts: readonly string[]): string | null {
  for (const text of texts) for (const line of text.split('\n')) {
    if (!line.includes('输入 facets')) continue;
    const reference = /src:[0-9a-f]{64}/.exec(line)?.[0];
    if (reference) return reference;
  }
  return null;
}
function continuation(text: string): { reference: string; cursor?: string } | null {
  const match = /(?:下一页|接着读)：get_nodes (\{[^\n]*?\})/.exec(text);
  if (!match) return null;
  try { const value = JSON.parse(match[1]) as { reference?: unknown; cursor?: unknown }; return typeof value.reference === 'string' && (value.cursor === undefined || typeof value.cursor === 'string') ? value as { reference: string; cursor?: string } : null; } catch { return null; }
}
export function facetReader(): (turn: Turn, done: string) => Reply {
  let reference: string | null = null;
  const requested = new Set<string>();
  return (turn, done) => {
    if (turn.index === 1) {
      reference = boundFacetReference(turn.toolResults.map((r) => r.text));
      if (!reference) return [{ text: '缺少已绑定 facets 的源引用，未归位数尚未核对；请补齐运行来源回答后重试。' }];
      return [{ tool: 'hub_get_nodes', input: { reference } }];
    }
    const next = continuation(turn.toolResults.map((r) => r.text).join('\n'));
    if (next) {
      const key = JSON.stringify(next);
      if (!reference || !next.reference.startsWith(reference) || requested.has(key) || requested.size >= 1024) return [{ text: '分面分页没有前进或换了源，缺少完整计数；请补齐该源的完整分页后重试。' }];
      requested.add(key);
      return [{ tool: 'hub_get_nodes', input: next }];
    }
    return [{ text: done }];
  };
}
/** Reassemble only the MCP pages of the bound source. Headers and omission notes are never input data. */
export function facetCountCheck(area: string, expected: number, turns: readonly LoggedTurn[]): Check {
  const reference = boundFacetReference(resultTexts(turns));
  const pages = turns.flatMap((t) => t.toolResults).filter((r) => !r.isError && reference !== null && contentHeader(r.text)?.reference === reference);
  let raw = '';
  let declared: number | null = null;
  let valid = pages.length > 0;
  for (let i = 0; i < pages.length; i++) {
    const text = pages[i].text;
    const header = contentHeader(text)!;
    const lines = header.lines;
    if (header.tier !== labelOf('read_tier', 'model_readable')) valid = false;
    const head = lines.findIndex((line) => line.startsWith('原文（'));
    if (head < 0) { valid = false; continue; }
    if (i === 0) {
      const count = /^原文（([0-9]+) 个字符）：$/.exec(lines[head]);
      declared = count ? Number(count[1]) : null;
      if (declared === null || !Number.isSafeInteger(declared)) valid = false;
    }
    const continuedLine = /第 \d+ 个字符/.test(lines[head]);
    let from = head + 1;
    if (lines[from]?.startsWith('（接上页：')) from++;
    let to = lines.findIndex((line, at) => at >= from && (line.startsWith('部分：') || line.startsWith('追踪 ')));
    if (to < 0) to = lines.length;
    raw += (i > 0 && !continuedLine ? '\n' : '') + lines.slice(from, to).join('\n');
    if (i === pages.length - 1 && continuation(text)) valid = false;
  }
  if (declared !== raw.length) valid = false;
  let actual: number | null = null;
  try {
    const value = JSON.parse(raw) as { schema?: string; kind?: string; by?: string[]; rows?: Array<{ values: { commands?: unknown }; count: number }>; truncated?: boolean; skipped?: number };
    if (value.schema !== 'facet-view@1' || value.kind !== 'case' || JSON.stringify(value.by) !== '["commands"]' || value.truncated !== false || value.skipped !== 0 || !Array.isArray(value.rows)) valid = false;
    else {
      const empty = value.rows.filter((row) => row.values.commands === null);
      if (empty.length > 1 || empty.some((row) => !Number.isSafeInteger(row.count) || row.count < 1)) valid = false;
      else actual = empty[0]?.count ?? 0;
    }
  } catch { valid = false; }
  return { area, name: '分面未归位数与独立抽取相符', expected: String(expected), actual: valid && actual !== null ? String(actual) : '输入不全', ok: valid && actual !== null && Number.isSafeInteger(expected) && expected >= 0 && actual === expected };
}

/** Hint source pages are observations for the numeric check, never the scope answer being judged. */
export function withoutFacetPages(turns: readonly LoggedTurn[]): LoggedTurn[] {
  const reference = boundFacetReference(resultTexts(turns));
  return turns.map((turn) => ({ ...turn, toolResults: turn.toolResults.filter((r) => !reference || contentHeader(r.text)?.reference !== reference) }));
}

export class ScopeGoldError extends Error {readonly reason:'live_replay'|'gold_count';constructor(reason:'live_replay'|'gold_count',message:string){super(message);this.name='ScopeGoldError';this.reason=reason;}}
export function validateScopeGold(gold:{caseCommandsUnplaced:number},_pack:string):void {
 if(!gold||!Number.isSafeInteger(gold.caseCommandsUnplaced)||gold.caseCommandsUnplaced<0)throw new ScopeGoldError('gold_count','caseCommandsUnplaced 必须是非负整数；从独立抽取 totals.unplaced 复制后再启动');
 if(Object.hasOwn(gold,'unplaced')||Object.hasOwn(gold,'unplacedRun'))throw new ScopeGoldError('live_replay','实时场景不能核对预先导出的运行披露；移除 unplaced 和 unplacedRun，场景只读取本次运行绑定的 facets');
}
export function disclosureMessage(value: unknown, pack: string): string {
  if (!value || typeof value !== 'object') return '';
  const wrapper = value as { run?: unknown; groups?: unknown };
  const run = wrapper.run && typeof wrapper.run === 'object' ? wrapper.run as { groups?: unknown } : wrapper;
  if (!Array.isArray(run.groups)) return '';
  const groups = run.groups.filter((v) => v && typeof v === 'object' && (v as { kind?: unknown }).kind === pack);
  return groups.length === 1 && typeof groups[0].message === 'string' ? groups[0].message : '';
}
