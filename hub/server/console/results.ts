// Read-only production results computed at start_run, separate from later model commentary.
import { DYNAMIC_TERMINAL, LAYER, STATIC_TERMINAL, isDynamicTerminal, isStaticTerminal, labelOf } from '../../../contracts/generated/vocabulary.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { PARTITION } from '../../../contracts/generated/vocabulary.ts';
import { NOT_APPLICABLE, coverageText, statusText, terminalKind, terminalText } from '../claims.ts';
import { countsLine } from '../text.ts';
import { code, definitions, html, link, page, section, table } from './html.ts';
import { ruleWithdrawalNotice, claimBlockAtRead, sharedRunNotice, neutralPage, missingProductionResult, type PageContext, type PageResult } from './pages.ts';

const production = (run: RunRecord): boolean => run.requirements.length > 0 && run.requirements.every((r) => r.accepted_producer === 'fact');
const param = (ctx: PageContext, key: string): string | undefined => ctx.url.searchParams.get(key) || undefined;

export async function resultsPage(ctx: PageContext): Promise<PageResult> {
  const pack = param(ctx, 'pack');
  const build = param(ctx, 'build');
  const listing = await ctx.deps.runs.listRuns(ctx.principal, { pack, limit: 50, cursor: param(ctx, 'cursor') ?? null });
  const runs = listing.items.filter((run) => production(run) && (build === undefined || run.build === build));
  const partial=listing.next !== null || param(ctx,'cursor') !== undefined;
  const empty=partial ? `这一页的 ${listing.items.length} 个运行里没有符合筛选的生产运行` : '没有符合筛选的生产运行';
  const filter = html`<form class="filters" method="get" action="/console/results"><label>任务包 <input name="pack" value="${pack ?? ''}"></label><label>构建 <input name="build" value="${build ?? ''}"></label><button type="submit">筛选</button></form>`;
  const next = listing.next === null ? '' : html`<p>${link('/console/results', '下一页', { pack, build, cursor: listing.next })}</p>`;
  return { status: 200, body: page(ctx.chrome('结果'), html`${filter}${partial || runs.length !== listing.items.length ? html`<p class="notice">${partial?'部分：':''}本页检查了 ${listing.items.length} 个运行，列出 ${runs.length} 个符合筛选的生产运行${listing.next !== null ? '；继续查看下一页' : ''}</p>` : ''}${table(
    ['运行', '任务包', '产品 / 版本 / 构建', '开始时间', '条目'],
    runs.map((run) => [html`${link(`/console/results/${run.run}`, run.run)}${sharedRunNotice(ctx,run)}`, run.pack, [run.product, run.version, run.build].filter(Boolean).join(' / '), run.started_at, run.items.length]),
    empty,
  )}${next}`) };
}

export async function resultPage(ctx: PageContext, runId: string): Promise<PageResult> {
  if (!/^run_[0-9a-z]{26}$/.test(runId)) return neutralPage(ctx);
  const detail = await ctx.deps.runs.getRun(ctx.principal, runId);
  if (detail === null || !production(detail.run)) return neutralPage(ctx);
  const renderClaim=claimBlockAtRead(detail.rule_withdrawn===true);
  const terminal = param(ctx, 'terminal');
  const rawOffset = param(ctx, 'offset') ?? '0';
  if ((terminal !== undefined && !isStaticTerminal(terminal) && !isDynamicTerminal(terminal)) || !/^(0|[1-9][0-9]*)$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) {
    return { status: 400, body: page(ctx.chrome('请求有误'), html`<p class="error">筛选终态或分页位置不对</p>`) };
  }
  const authority = html`<p>${link(`/console/runs/${runId}`, '查看运行（权威视图）')}</p>`;
  if (detail.production === null) return { status: 200, body: page(ctx.chrome(`结果 ${runId}`), html`${sharedRunNotice(ctx,detail.run)}${ruleWithdrawalNotice(detail)}${authority}${missingProductionResult(detail)}`) };
  const commentary=detail.latest!==null&&detail.latest.record!==detail.production.record
    ? html`<p class="notice">另有后续受理的模型评论，结果记录 ${code(detail.latest.record)}；运行页在“模型评论（判断）”中单列，不替代本页生产结果。</p>`:'';
  const result = detail.production.result;
  const items = PARTITION.flatMap((partition) => result.partitions[partition].map(item=>({partition,item})));
  const filtered = terminal === undefined ? items : items.filter(({item}) => item.requirements.some((r) => r.layers.some((l) => l.terminal === terminal)));
  const offset = Number(rawOffset);
  const projections = new Map(detail.run.items.map((item) => [item.id, item]));
  const names = new Map(detail.run.requirements.map((r) => [r.key, r.name]));
  const rows = filtered.slice(offset, offset + 500).map(({partition,item}) => [
    code(item.item), item.label, projections.get(item.item)?.summary ?? '',
    html`${labelOf('partition',partition)}${'code' in item ? html`：${code(item.code)}` : 'reason' in item ? html`：${labelOf('reason',item.reason)}` : ''}`,
    html`${item.requirements.map((r) => {
      return html`<div>${r.requirement} ${names.get(r.requirement) ?? ''}：${statusText(r)}<br>${LAYER.map(name=>{
        const layer=r.layers.find(l=>l.layer===name);
        return html`${layer === undefined ? html`${labelOf('layer',name)}：${NOT_APPLICABLE}` : html`<span class="t-${terminalKind(layer)}">${terminalText(layer)}</span>`}<br>`;
      })}${r.claims.map(renderClaim)}</div>`;
    })}`,
  ]);
  const terminals=[...new Set([...STATIC_TERMINAL,...DYNAMIC_TERMINAL])];
  const filter = html`<form class="filters" method="get" action="/console/results/${runId}"><label>任一层终态 <select name="terminal"><option value="">全部</option>${terminals.map((value) => html`<option value="${value}"${value === terminal ? html` selected` : ''}>${isStaticTerminal(value) ? labelOf('static_terminal',value) : labelOf('dynamic_terminal',value)}</option>`)}</select></label><button type="submit">筛选</button></form>`;
  const nav = html`<p>${offset > 0 ? link(`/console/results/${runId}`, '上一页', { terminal, offset: Math.max(0, offset - 500) }) : ''} ${offset + 500 < filtered.length ? link(`/console/results/${runId}`, '下一页', { terminal, offset: offset + 500 }) : ''}</p>`;
  return { status: 200, body: page(ctx.chrome(`结果 ${runId}`), html`${sharedRunNotice(ctx,detail.run)}${ruleWithdrawalNotice(detail)}${authority}${commentary}
<p><strong>${countsLine(result.acceptance, result.acceptance === 'accepted' ? result.partitions : undefined)}</strong></p>
${definitions([['覆盖', coverageText(result.coverage) ?? '—'], ['生产结果记录（start_run 计算）', code(detail.production.record)]])}
${section('跨条目主张（不计入分区）', result.cross_item.length === 0 ? html`<p class="empty">没有</p>` : result.cross_item.map(renderClaim))}
${filter}<p>筛选后 ${filtered.length} 个；本页 ${Math.min(offset + 1, filtered.length)}–${Math.min(offset + 500, filtered.length)}</p>
${table(['编号', '名称', '摘要', '分区及原因', '要求项状态、各层终态与主张'], rows, '没有条目')}${nav}`) };
}
