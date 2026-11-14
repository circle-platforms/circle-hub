/**
 * Read-only console projection of one 脑图编译 round (Boss 22:25 first slice).
 * Clusters runs by predecessor lineage + subject src + product/version/build; conclusions use
 * hub/server/text.ts itemConclusion (same sentence as tool text). No new tables.
 */
import { PARTITION } from '../../../contracts/generated/vocabulary.ts';
import type { ItemProjection, RunRecordView, SourceBinding } from '../../../contracts/src/run.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import type { ExportedJob, ExportedSuccessor } from '../../ports.ts';
import { caseName, itemConclusion } from '../text.ts';
import { kpi, box } from './ui.ts';
import { count } from './numbers.ts';
import { time } from './format.ts';
import { html, link, page, table, type Html } from './html.ts';
import { NEUTRAL, neutralPage, type PageContext, type PageResult } from './context.ts';
import { RUN_ID, SHA256, param } from './params.ts';
import { roundDevicePath, roundsPath, runPath } from './routes.ts';

const COMPILE_PACK_PREFIXES = ['case-compile', 'recompose'] as const;
const LINEAGE_CAP = 20;

export const ROUND_EMPTY_ANCHOR = '请从任务页打开本轮，或在地址里写上运行编号。';
export const ROUND_EMPTY_CASES = '这一轮还没有可读的原始用例。';
export const ROUND_PARTIAL_RUNS = '这一轮里有部分运行当前账号读不到，表里只列可见的。';
export const ROUND_NO_CONCLUSION = '这条原始用例还没有 Hub 核对结论。';
export const ROUND_HUB_MISSING_FAILURE = 'Hub 没有';
export const ROUND_HUB_MISSING_DELIVERY = 'Hub 没有';
export const ROUND_NO_DEVICE = '还没有设备输出';
export const ROUND_DEVICE_UNREADABLE = '设备输出不可读';
export const ROUND_DEVICE_TITLE = '设备输出';

export function packNameOf(pack: string): string {
  const at = pack.indexOf('@');
  return at < 0 ? pack : pack.slice(0, at);
}

export function isCompileWorkflowPack(pack: string): boolean {
  const name = packNameOf(pack);
  return COMPILE_PACK_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}-`));
}

export function subjectReference(sources: readonly SourceBinding[]): string | null {
  const subject = sources.find((row) => row.role === 'subject' && row.reference.startsWith('src:'));
  return subject?.reference ?? null;
}

export function sameRoundKeys(
  anchor: Pick<RunRecordView, 'product' | 'version' | 'build' | 'pack' | 'sources'>,
  other: Pick<RunRecordView, 'product' | 'version' | 'build' | 'pack' | 'sources'>,
): boolean {
  if (!isCompileWorkflowPack(other.pack)) return false;
  if ((anchor.product ?? null) !== (other.product ?? null)) return false;
  if ((anchor.version ?? null) !== (other.version ?? null)) return false;
  if ((anchor.build ?? null) !== (other.build ?? null)) return false;
  const a = subjectReference(anchor.sources);
  const b = subjectReference(other.sources);
  if (a === null || b === null) return false;
  return a === b;
}

export function caseIdentity(item: ItemProjection): { id: string; title: string; label: string } {
  const autoid = item.fields.autoid ?? item.fields.case_id;
  const id = typeof autoid === 'string' || typeof autoid === 'number' ? String(autoid) : item.label;
  const titled = item.fields.title;
  const title = typeof titled === 'string' && titled.length > 0
    ? titled
    : item.fields.case_id !== undefined && item.fields.title === undefined
      ? '标题未知'
      : item.label;
  return { id, title, label: item.label };
}

export function itemsOfResult(result: ValidationResult): ItemResult[] {
  return PARTITION.flatMap((partition) => result.partitions[partition]);
}

export function judgmentOfConclusion(text: string): '正确' | '错误' | null {
  if (text.includes('判断错误')) return '错误';
  if (text.includes('判断正确')) return '正确';
  return null;
}

export interface RoundCaseRow {
  id: string;
  title: string;
  conclusion: string;
  deviceAttempts: number;
  deviceRun: string | null;
  deviceSha: string | null;
}

export interface RoundTotals {
  cases: number;
  correct: number;
  wrong: number;
  unknown: number;
  batches: number;
  startedAt: string | null;
  endedAt: string | null;
}

export function buildRoundRows(input: {
  projections: readonly ItemProjection[];
  conclusionsByItem: ReadonlyMap<string, { item: ItemResult; original: ItemProjection | undefined }>;
  jobs: readonly ExportedJob[];
}): { rows: RoundCaseRow[]; totals: RoundTotals } {
  const population = input.projections.length
    ? input.projections
    : [...input.conclusionsByItem.values()].map((row) => row.original).filter((row): row is ItemProjection => row !== undefined);
  const seen = new Set<string>();
  const rows: RoundCaseRow[] = [];
  for (const projection of population) {
    const identity = caseIdentity(projection);
    if (seen.has(identity.id)) continue;
    seen.add(identity.id);
    const matched = input.conclusionsByItem.get(projection.id)
      ?? [...input.conclusionsByItem.entries()].find(([key, value]) => {
        const other = value.original ? caseIdentity(value.original).id : key;
        return other === identity.id || value.item.label === identity.id || value.item.item === projection.id;
      })?.[1];
    const conclusion = matched ? itemConclusion(matched.item, matched.original ?? projection) : ROUND_NO_CONCLUSION;
    const attempts = input.jobs.filter((job) => job.rows?.some((row) => row.item === projection.id || row.item === identity.id) || job.items.includes(projection.id) || job.items.includes(identity.id));
    const latest = [...attempts].reverse().find((job) => typeof job.device_return === 'string' && job.device_return.startsWith('src:'))
      ?? [...attempts].reverse().find((job) => typeof job.result === 'string' && job.result.startsWith('src:'));
    const ref = latest?.device_return ?? latest?.result ?? null;
    const sha = ref && /^src:([0-9a-f]{64})$/.test(ref) ? ref.slice(4) : null;
    rows.push({
      id: identity.id,
      title: identity.title,
      conclusion,
      deviceAttempts: attempts.length,
      deviceRun: latest?.verification_run ?? null,
      deviceSha: sha,
    });
  }
  let correct = 0;
  let wrong = 0;
  let unknown = 0;
  for (const row of rows) {
    const judgment = judgmentOfConclusion(row.conclusion);
    if (judgment === '正确') correct += 1;
    else if (judgment === '错误') wrong += 1;
    else unknown += 1;
  }
  const batchKeys = new Set(input.jobs.filter((job) => job.ended === 'done' && job.rows !== null).map((job) => job.job));
  return {
    rows,
    totals: {
      cases: rows.length,
      correct,
      wrong,
      unknown,
      batches: batchKeys.size,
      startedAt: null,
      endedAt: null,
    },
  };
}

type RunReader = {
  getRun(user: PageContext['principal'], run: string): Promise<{ run: RunRecordView; latest: { result: ValidationResult } | null; production: { result: ValidationResult } | null } | null>;
  exportSuccessors?(user: PageContext['principal'], run: string): Promise<{ run: string; successors: ExportedSuccessor[] } | null>;
  exportJobs?(user: PageContext['principal'], run: string): Promise<{ run: string; jobs: ExportedJob[] } | null>;
};

export async function collectRoundTree(
  runs: RunReader,
  user: PageContext['principal'],
  anchorId: string,
): Promise<{ anchor: RunRecordView; runs: RunRecordView[]; skipped: number } | null> {
  const anchorDetail = await runs.getRun(user, anchorId);
  if (anchorDetail === null) return null;
  const anchor = anchorDetail.run;
  if (!isCompileWorkflowPack(anchor.pack) || subjectReference(anchor.sources) === null) {
    return { anchor, runs: [anchor], skipped: 0 };
  }
  const upward: RunRecordView[] = [anchor];
  let at: string | undefined = anchor.predecessor;
  let depth = 0;
  while (at !== undefined && depth < LINEAGE_CAP) {
    depth += 1;
    const detail = await runs.getRun(user, at);
    if (detail === null) break;
    if (!sameRoundKeys(anchor, detail.run)) break;
    upward.push(detail.run);
    at = detail.run.predecessor;
  }
  const root = upward[upward.length - 1]!;
  const byId = new Map<string, RunRecordView>(upward.map((row) => [row.run, row]));
  const queue = [root.run];
  let skipped = 0;
  while (queue.length) {
    const id = queue.shift()!;
    const listed = runs.exportSuccessors ? await runs.exportSuccessors(user, id) : null;
    for (const successor of listed?.successors ?? []) {
      if (byId.has(successor.run)) continue;
      const detail = await runs.getRun(user, successor.run);
      if (detail === null) {
        skipped += 1;
        continue;
      }
      if (!sameRoundKeys(anchor, detail.run)) continue;
      byId.set(detail.run.run, detail.run);
      queue.push(detail.run.run);
    }
  }
  const ordered = [...byId.values()].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  return { anchor, runs: ordered, skipped };
}

async function loadJobs(runs: RunReader, user: PageContext['principal'], tree: readonly RunRecordView[]): Promise<ExportedJob[]> {
  if (!runs.exportJobs) return [];
  const out: ExportedJob[] = [];
  for (const run of tree) {
    const listed = await runs.exportJobs(user, run.run);
    if (listed) out.push(...listed.jobs);
  }
  return out;
}

function pickResult(detail: { latest: { result: ValidationResult } | null; production: { result: ValidationResult } | null }): ValidationResult | null {
  return detail.latest?.result ?? detail.production?.result ?? null;
}

export async function roundPage(ctx: PageContext): Promise<PageResult> {
  const runId = param(ctx, 'run');
  if (runId === undefined) {
    return {
      status: 200,
      body: page(ctx.chrome('一轮编译', { active: 'tasks', hint: '按任务的前驱链、脑图来源和构建聚成一轮；结论句与工具文字同一出处。' }), html`<p class="ch-meta">${ROUND_EMPTY_ANCHOR}</p><p>${link('/console/runs', '打开任务列表')}</p>`),
    };
  }
  if (!RUN_ID.test(runId)) return neutralPage(ctx);
  const tree = await collectRoundTree(ctx.deps.runs, ctx.principal, runId);
  if (tree === null) return neutralPage(ctx);

  const conclusionsByItem = new Map<string, { item: ItemResult; original: ItemProjection | undefined }>();
  let projections: ItemProjection[] = [];
  let latestActivity: string | null = null;
  for (const run of tree.runs) {
    const detail = await ctx.deps.runs.getRun(ctx.principal, run.run);
    if (detail === null) continue;
    if (detail.run.items.length) projections = detail.run.items;
    const result = pickResult(detail);
    if (result?.acceptance === 'accepted') {
      const originals = new Map(detail.run.items.map((item) => [item.id, item]));
      for (const item of itemsOfResult(result)) {
        conclusionsByItem.set(item.item, { item, original: originals.get(item.item) });
      }
    }
    const stamp = detail.latest ? detail.run.started_at : detail.run.started_at;
    if (latestActivity === null || Date.parse(stamp) >= Date.parse(latestActivity)) latestActivity = stamp;
  }

  const jobs = await loadJobs(ctx.deps.runs, ctx.principal, tree.runs);
  const { rows, totals } = buildRoundRows({ projections, conclusionsByItem, jobs });
  totals.startedAt = tree.runs[0]?.started_at ?? null;
  totals.endedAt = latestActivity;

  const duration = totals.startedAt && totals.endedAt
    ? durationText(Date.parse(totals.startedAt), Date.parse(totals.endedAt))
    : '暂无';

  const head = html`${box({ title: '本轮摘要', hint: '只读投影；不新建轮次记录。失败分析原因、交付结案和交付目录标为 Hub 没有。' }, html`
${kpi('一共', count(totals.cases))}
${kpi('正确', count(totals.correct))}
${kpi('错误', count(totals.wrong))}
${kpi('未知', count(totals.unknown))}
${kpi('上机验证批次数', count(totals.batches))}
${kpi('用时', duration)}
`)}
${tree.skipped > 0 ? html`<p class="ch-meta">${ROUND_PARTIAL_RUNS}</p>` : ''}
${definitionsBlock(tree)}
`;

  const tableRows = rows.map((row) => [
    row.id,
    row.title,
    row.conclusion,
    count(row.deviceAttempts),
    row.deviceRun && row.deviceSha
      ? link(roundDevicePath(), '打开设备输出', { run: row.deviceRun, sha256: row.deviceSha })
      : ROUND_NO_DEVICE,
    ROUND_HUB_MISSING_FAILURE,
    ROUND_HUB_MISSING_DELIVERY,
  ]);

  return {
    status: 200,
    body: page(
      ctx.chrome('一轮编译', {
        active: 'tasks',
        sub: html`${link(runPath(tree.anchor.run), '锚点任务')}`,
        hint: '每条原始用例一行；结论句与工具返回给模型的句子同一成句函数。',
      }),
      html`${head}${table(
        ['原始用例编号', '标题', '结论', '上机验证次数', '设备输出', '失败分析原因与下一步', '交付'],
        tableRows,
        ROUND_EMPTY_CASES,
      )}`,
    ),
  };
}

function definitionsBlock(tree: { anchor: RunRecordView; runs: RunRecordView[] }): Html {
  const subject = subjectReference(tree.anchor.sources) ?? '未记录';
  return html`<p class="ch-meta">工作流族 · 产品 ${tree.anchor.product ?? '未指定'} · 版本 ${tree.anchor.version ?? '未指定'} · 构建 ${tree.anchor.build ?? '未指定'} · 脑图 ${subject} · 本轮可见任务 ${count(tree.runs.length)} · 开始 ${tree.runs[0] ? time(tree.runs[0].started_at) : '未知'}</p>`;
}

function durationText(from: number, to: number): string {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '暂无';
  const minutes = Math.round((to - from) / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** Device output bytes through the same artifacts read as run-export (no new auth path). */
export async function roundDevicePage(ctx: PageContext): Promise<PageResult> {
  const runId = param(ctx, 'run');
  const sha = param(ctx, 'sha256');
  if (runId === undefined || sha === undefined || !RUN_ID.test(runId) || !SHA256.test(sha)) return neutralPage(ctx);
  const visible = await ctx.deps.runs.getRun(ctx.principal, runId);
  if (visible === null) return neutralPage(ctx);
  const source = await ctx.deps.records.artifacts.sourceForRun(ctx.principal, sha, runId)
    ?? await ctx.deps.records.artifacts.source(ctx.principal, sha);
  if (source === null || source.bytes === null) {
    return {
      status: 200,
      body: page(ctx.chrome(ROUND_DEVICE_TITLE, { active: 'tasks', sub: link(roundsPath(), '返回本轮', { run: runId }) }), html`<p>${ROUND_DEVICE_UNREADABLE}</p><p class="ch-meta">${NEUTRAL}</p>`),
    };
  }
  const text = Buffer.from(source.bytes).toString('utf8');
  const preview = text.length > 200_000 ? `${text.slice(0, 200_000)}\n…（其后省略）` : text;
  return {
    status: 200,
    body: page(
      ctx.chrome(ROUND_DEVICE_TITLE, { active: 'tasks', sub: html`${link(roundsPath(), '返回本轮', { run: runId })} · ${link(runPath(runId), '任务')}` }),
      html`<pre class="ch-code">${preview}</pre>`,
    ),
  };
}
