// Read-only rendering of EnvironmentReadiness for 连接 → 运行环境. The page never judges, summarizes, or invents links.
import type { EnvironmentReadiness, EnvironmentReadinessCheck, EnvironmentReadinessExecutor } from '../../dispatch/api.ts';
import { code, html, type Html } from './html.ts';
import { technical } from './presentation.ts';
import { box, callout, chip, when, type Tone } from './ui.ts';

/** Three-state chip from a check's satisfied field; the page does not recompute it. */
export function readinessSatisfiedChip(satisfied: boolean | null): { text: string; tone: Tone } {
  if (satisfied === true) return { text: '已确认', tone: 'pass' };
  if (satisfied === false) return { text: '错误', tone: 'fail' };
  return { text: '未知', tone: 'unknown' };
}

/** Unknown and error rows keep the report's missing_fact / next_action verbatim. */
export function readinessCheckBlock(check: EnvironmentReadinessCheck): Html {
  const allocationPreview=check.condition==='assignment';
  const state=allocationPreview?{text:'配置预览',tone:'plain' as const}:readinessSatisfiedChip(check.satisfied);
  const disclose = !allocationPreview && check.satisfied !== true && (check.missing_fact !== undefined || check.next_action !== undefined);
  return html`<div class="ch-stack" data-readiness-check data-condition="${check.condition}">
<div class="ch-actions">${chip(state.text, state.tone)}<span>${check.label}</span><span class="ch-meta" data-condition-id>${check.condition}</span><span class="ch-meta">${when(check.observed_at)}</span></div>
${allocationPreview?html`<p class="ch-meta">测试环境的分配还没有启用，现在谁能预订仍按工作流的分配和预订规则判断。此项仅为分配配置事实，不作执行许可。</p>`:''}
${disclose ? html`<p class="ch-meta">缺什么：${check.missing_fact ?? '未说明'}；下一步：${check.next_action ?? '未说明'}</p>` : ''}
</div>`;
}

export function readinessUnknownNotice(missing = '报告尚未接线', next = '请管理员在 Hub 装配中接入只读就绪报告后重读'): Html {
  return callout('unknown', html`只读报告未知。缺什么：${missing}；下一步：${next}`);
}

function occupancyLines(row: EnvironmentReadinessExecutor): Html {
  if (row.occupancy === null) return html`<p class="ch-meta">本地租约占用未知</p>`;
  if (row.occupancy.length === 0) return html`<p class="ch-meta">本地声明资源没有有效租约（不表示物理空闲）</p>`;
  return html`${row.occupancy.map((entry) => html`<p class="ch-meta">${entry.mine ? '本人占用' : '他人占用'} · 自 ${when(entry.since)}${entry.until ? html` · 至 ${when(entry.until)}` : html` · 不限时长`}</p>`)}`;
}

function executorBlock(row: EnvironmentReadinessExecutor): Html {
  return html`<section class="ch-stack" data-readiness-executor data-ordinal="${row.ordinal}">
${row.executor === undefined ? '' : technical(html`${code(row.executor)}`, '查看执行器身份')}
${row.checks.map(readinessCheckBlock)}
${occupancyLines(row)}
${row.baseline_registrations.length ? html`<p class="ch-meta">基线登记元数据：${row.baseline_registrations.map((item) => html`第 ${item.ordinal} 项 ${when(item.recorded_at)}`)}</p>` : ''}
</section>`;
}

/** One target's readiness report as returned by the port; no page-side verdict. */
export function readinessReportCard(report: EnvironmentReadiness): Html {
  if (report.target === null) {
    return box(
      { title: '测试环境就绪', meta: when(report.observed_at) },
      html`${readinessUnknownNotice(report.missing_fact ?? '该目标当前没有可查看的执行器配置', report.next_action ?? '核对目标配置与账户分配后重读')}
${report.limitations.map((line) => html`<p class="ch-meta">${line}</p>`)}`,
    );
  }
  return box(
    { title: report.target, meta: html`观察 ${when(report.observed_at)}`, hint: '只读观察，不作上机或预订许可' },
    html`${report.executors.map(executorBlock)}
${report.missing_fact || report.next_action ? html`<p class="ch-meta">缺什么：${report.missing_fact ?? '未说明'}；下一步：${report.next_action ?? '未说明'}</p>` : ''}
${report.limitations.map((line) => html`<p class="ch-meta">${line}</p>`)}`,
  );
}

/** Load readiness for each target through the optional port; never invents a report. */
export async function loadReadinessReports(
  readiness: ((caller: import('../../records/api.ts').Principal, target: string) => Promise<EnvironmentReadiness>) | undefined,
  caller: import('../../records/api.ts').Principal,
  targets: readonly string[],
): Promise<Array<{ target: string; body: Html }>> {
  if (!readiness) {
    return targets.map((target) => ({ target, body: box({ title: target }, readinessUnknownNotice()) }));
  }
  const out: Array<{ target: string; body: Html }> = [];
  for (const target of targets) {
    try {
      out.push({ target, body: readinessReportCard(await readiness(caller, target)) });
    } catch {
      out.push({ target, body: box({ title: target }, readinessUnknownNotice('只读报告读取未完成', '恢复只读就绪报告读取后重读')) });
    }
  }
  return out;
}
