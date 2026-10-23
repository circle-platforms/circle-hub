// The real-client oracle reads only client-visible text; every diagnostic is anonymised.
import { labelOf } from '../../../contracts/generated/vocabulary.ts';
import { createHash } from 'node:crypto';
import { resultTexts, type Scenario } from '../lib/accept.ts';
import { createPagerState, pagedRespond } from '../lib/pager.ts';
import type { Check } from '../lib/report.ts';
import type { StoryGold } from '../gold/trace-stories.ts';
import { lengthBounded } from './checks.ts';
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export default function scenario(gold: StoryGold): Scenario {
  const area = '需求追溯矩阵';
  const state = createPagerState();
  return {
    name: 'story-traceability', area,
    prompt: `请核对构建 ${gold.build} 的需求到用例追溯，需求范围以提供的编号清单为准。`,
    respond: turn => pagedRespond(turn, state, () => {
      const ids = gold.stories.map(s => s.story).sort((a, b) => Number(a) - Number(b));
      const stories = [];
      for (let i = 0; i < ids.length; i += 50) stories.push({ external: `plm:stories:${ids.slice(i, i + 50).join('+')}` });
      return [{ tool: 'hub_start_run', input: { pack: 'story-traceability', inputs: { stories, cases: { external: `knowledge:index:${gold.product}:${gold.build}?kind=case&key=stories&fields=document,node,title` } } } }];
    }, '已读取完整视图覆盖内的核验事实，不推断未索引用例。', 100),
    check(turns): Check[] {
      const texts = resultTexts(turns);
      const text = texts.join('\n');
      const checks: Check[] = [];
      const add = (name: string, ok: boolean, expected: string = '一致', actual: string = ok ? '一致' : '不一致或未出现') => checks.push({ area, name, expected, actual, ok });
      add('运行结果可读', text.includes('运行 run_') && !turns.some(t => t.toolResults.some(r => r.isError)));
      add('PLM 详情来源完整', text.includes('PLM 详情未读到 0 个'));
      add('需求范围依据', text.includes(`需求范围依据：${labelOf('provenance_type', gold.scope)}`));
      add('原件完整', gold.missing_documents.length === 0, '缺原件 0 份', `缺原件 ${gold.missing_documents.length} 份`);
      for (const [at, row] of gold.stories.entries()) {
        const label = `#${at + 1} ${hash(row.story)}`;
        const lines = text.split(/\r?\n/).filter(l => l.trim().startsWith(`- ${row.story} |`));
        const claim = text.split(/\r?\n/).find(l => l.includes(`需求 ${row.story}（状态：`)) ?? '';
        add(`${label} 条目存在`, lines.length > 0);
        if (row.cases.length === 0) {
          add(`${label} 缺用例为覆盖范围内的确定事实`, lines.some(l => l.includes('无已索引用例（完整视图内）')) && claim.includes('完整需求号键列表覆盖的索引视图') && claim.includes(`没有条目携带需求号 ${row.story}`) && !claim.includes('下一步'));
        } else {
          const count = new RegExp(`需求 ${escape(row.story)}（[^\\n]*?）：([0-9]+) 个已索引用例追溯：`).exec(claim);
          const section = claim.split('已索引用例追溯：')[1]?.split(/；另有|；来源部分|；需求范围/)[0] ?? '';
          const listed = section.split('；').map(p => /^([^\s]+:[^\s]+)(?:\s|$)/.exec(p)?.[1]).filter((v): v is string => !!v);
          const correct = Number(count?.[1]) === row.cases.length && listed.length === Math.min(5, row.cases.length) && new Set(listed).size === listed.length && listed.every(id => row.cases.some(c => c.id === id));
          add(`${label} 用例连接`, correct, `${row.cases.length} 个，展示 ${Math.min(5, row.cases.length)} 个`, correct ? '一致' : `展示 ${listed.length} 个，连接或计数不符`);
        }
        add(`${label} 原样状态与阶段`, claim.includes(`状态：${!row.plm_returned ? '应答未包含该编号' : row.fields_absent?.includes('status') ? '字段未提供' : row.fields_nonscalar?.includes('status') ? 'PLM 返回的值不是单个值' : String(row.status)}；阶段：${!row.plm_returned ? '应答未包含该编号' : row.fields_absent?.includes('stage') ? '字段未提供' : row.fields_nonscalar?.includes('stage') ? 'PLM 返回的值不是单个值' : String(row.stage)}`));
        if (!row.plm_returned) add(`${label} PLM 未返回`, claim.includes(`PLM 应答里没有编号 ${row.story}`));
      }
      const counts = `需求 ${gold.stories.length} 个：已追溯 ${gold.traced} 个，未追溯 ${gold.untraced} 个；PLM 没返回 ${gold.plm_unread} 个`;
      add('运行计数', text.includes(counts), counts, text.includes(counts) ? counts : '不一致或未出现');
      const states = `原样状态计数：${gold.statuses.map(s => `${String(s.status)} ${s.count} 个`).join('、')}`;
      add('非单个状态单列计数', text.includes(`PLM 返回的状态不是单个值的有 ${gold.status_nonscalar} 个，没有按状态计数`), `${gold.status_nonscalar} 个`);
      add('非单个阶段单列计数', text.includes(`PLM 返回的阶段不是单个值的有 ${gold.stage_nonscalar} 个`), `${gold.stage_nonscalar} 个`);
      add('按原样状态分组', text.includes(states) && (gold.statuses.length > 0 || /原样状态计数：[ \t]*(?:$|\r?\n|；用例明细)/m.test(text)), `${gold.statuses.length} 组，SHA-256 ${hash(states)}`);
      checks.push(lengthBounded(area, turns));
      return checks;
    },
  };
}
