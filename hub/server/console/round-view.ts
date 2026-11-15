/**
 * Read-only console projection of related tasks that share one subject source and build.
 * Clusters by subject src + product/version/build and structural edges (predecessor /
 * input_defaults / parameters / rec: point-lookup); conclusions use hub/server/text.ts.
 * No new tables. Read caps mirror search.ts (disclose「部分」at the bound).
 */
import { PARTITION } from '../../../contracts/generated/vocabulary.ts';
import { RunId } from '../../../contracts/src/common.ts';
import type { ItemProjection, RunRecordView, SourceBinding } from '../../../contracts/src/run.ts';
import type { ItemResult, ValidationResult } from '../../../contracts/src/validation.ts';
import type { ExportedJob, ExportedSuccessor, RunListing } from '../../ports.ts';
import { itemConclusionParts } from '../text.ts';
import { box, callout, kpi } from './ui.ts';
import { count } from './numbers.ts';
import { time } from './format.ts';
import { html, link, page, pre, table, type Html } from './html.ts';
import { NEUTRAL, neutralPage, type PageContext, type PageResult } from './context.ts';
import { RUN_ID, SHA256, param } from './params.ts';
import { roundDevicePath, roundsPath, runPath } from './routes.ts';

/** Max run-index rows scanned for reverse edges (same bound idea as search.ts RUNS_SCANNED). */
export const ROUND_RUNS_SCANNED = 300;
/** Max case rows rendered per page request; more are reached with ?cases_after=. */
export const ROUND_CASES_PAGE = 100;
const LIST_PAGE = 100;
const LINEAGE_STEPS = 1_600;
const HISTORY = { history: { limit: 1 } as const, requests: 'waiting' as const };

export const ROUND_PAGE_TITLE = '相关任务';
export const ROUND_EMPTY_CASES = '这些相关任务里还没有可读的原始用例。';
export const ROUND_PARTIAL_RUNS = '无权限：有相关任务当前账户无权查看，未列入相关任务中。请联系这些任务的执行人或管理员分享。';
export const ROUND_PARTIAL_SCAN = '部分：只查了最新的 300 个可见任务，更早的相关任务可能没列出。下一步：从这些相关任务里最新的任务页进入。';
export const ROUND_SUCCESSORS_OPAQUE = '部分：当前账户不能读取后继任务列表，表中可能缺少更晚的相关任务。下一步：请该任务的执行人或管理员打开本页，或请管理员分享权限。';
export const ROUND_NO_SUBJECT = '不适用：这个任务没有绑定同一份来源，无法归入相关任务。下一步：从带有来源绑定的任务页进入。';
export const ROUND_SAME_KEY_UNLINKED = '部分：同一来源同一构建下还有可见任务，但与当前打开的任务没有前后步骤关系，未列入相关任务。下一步：从更晚的相关任务页进入，或请执行人核对这些任务是否应连在一起。';
export const ROUND_UNLINKED = '状态未知：找不到与这个任务相连的前一步任务（输入里引用的结果在可见任务里没有唯一对应）。下一步：执行人从上一步任务的页面进入本页，或请管理员核对。';
export const ROUND_NO_CONCLUSION = '状态未知；原因缺资料（还没有可读的核对结果）；下一步由模型提交后重新交给 Hub 检查';
export const ROUND_NO_DEVICE = '尚未上机验证';
export const ROUND_DEVICE_PENDING = '设备输出还没有返回';
export const ROUND_JOBS_FORBIDDEN = '无权限：当前账户不能读取这些任务的上机验证。请联系执行人或管理员。';
export const ROUND_DEVICE_UNREADABLE = '设备输出不可读';
export const ROUND_DEVICE_TITLE = '设备输出';
export const ROUND_HUB_NOTE = '失败分析的原因和交付结果在 Circle 客户端生成，Hub 不保存。';
/** Shown only when a later page exists (`nextAfter`); not used for scan caps. */
export const ROUND_CASES_MORE = '原始用例较多，下面只列本页。下一步：打开「后一页」。';
export const ROUND_CASES_PAGE_END = '原始用例较多，下面是最后一页。下一步：打开「回到第一页」，或从当前页继续阅读。';

const REC_DIGEST = /^rec:([0-9a-f]{64})$/;

/** Digests named as `rec:` in sources when the caller did not leave input_defaults. */
export function recDigests(sources: readonly SourceBinding[]): string[] {
  const out: string[] = [];
  for (const row of sources) {
    const matched = REC_DIGEST.exec(row.reference);
    if (matched) out.push(matched[1]!);
  }
  return out;
}

export function subjectReference(sources: readonly SourceBinding[]): string | null {
  const subject = sources.find((row) => row.role === 'subject' && row.reference.startsWith('src:'));
  return subject?.reference ?? null;
}

export function subjectLabel(sources: readonly SourceBinding[]): string {
  const subject = sources.find((row) => row.role === 'subject' && row.reference.startsWith('src:'));
  if (subject === undefined) return '未记录';
  if (typeof subject.label === 'string' && subject.label.length > 0) return subject.label;
  return '已绑定来源';
}

/** Same subject bytes + product line + build; pack id is never consulted. */
export function sameRoundKeys(
  anchor: Pick<RunRecordView, 'product' | 'version' | 'build' | 'sources'>,
  other: Pick<RunRecordView, 'product' | 'version' | 'build' | 'sources'>,
): boolean {
  if ((anchor.product ?? null) !== (other.product ?? null)) return false;
  if ((anchor.version ?? null) !== (other.version ?? null)) return false;
  if ((anchor.build ?? null) !== (other.build ?? null)) return false;
  const a = subjectReference(anchor.sources);
  const b = subjectReference(other.sources);
  if (a === null || b === null) return false;
  return a === b;
}

/** Run ids this run names via predecessor, input_defaults, or parameters (not pack slot names). */
export function outboundRunRefs(run: Pick<RunRecordView, 'predecessor' | 'input_defaults' | 'parameters'>): string[] {
  const ids = new Set<string>();
  if (typeof run.predecessor === 'string' && RunId.safeParse(run.predecessor).success) ids.add(run.predecessor);
  for (const row of run.input_defaults ?? []) {
    if (RunId.safeParse(row.predecessor).success) ids.add(row.predecessor);
  }
  for (const value of Object.values(run.parameters ?? {})) {
    if (typeof value === 'string' && RunId.safeParse(value).success) ids.add(value);
  }
  return [...ids];
}

/**
 * Projection display without guessing pack-specific fields (autoid / title live in fields.* and differ by workflow).
 * Dedup and pairing use projection.id; the table shows label and summary as the pack wrote them.
 */
export function caseIdentity(item: ItemProjection): { id: string; label: string; summary: string } {
  return {
    id: item.id,
    label: item.label,
    summary: typeof item.summary === 'string' ? item.summary : '',
  };
}

export function itemsOfResult(result: ValidationResult): ItemResult[] {
  return PARTITION.flatMap((partition) => result.partitions[partition]);
}

export interface RoundCaseRow {
  id: string;
  label: string;
  summary: string;
  conclusion: string;
  status: '已确认' | '未确认' | '未知' | null;
  judgment: '正确' | '错误' | null;
  deviceAttempts: number;
  deviceRun: string | null;
  deviceSha: string | null;
}

export interface RoundTotals {
  cases: number;
  /** 已确认 + 判断正确 */
  correct: number;
  /** 未确认（模型结论） */
  unconfirmed: number;
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
      ?? [...input.conclusionsByItem.entries()].find(([, value]) => value.item.item === projection.id)?.[1];
    const parts = matched
      ? itemConclusionParts(matched.item, matched.original ?? projection)
      : { text: ROUND_NO_CONCLUSION, status: '未知' as const, judgment: null };
    const attempts = input.jobs.filter((job) => job.rows?.some((row) => row.item === projection.id) || job.items.includes(projection.id));
    const latest = [...attempts].reverse().find((job) => typeof job.device_return === 'string' && job.device_return.startsWith('src:'));
    const ref = latest?.device_return ?? null;
    const sha = ref && /^src:([0-9a-f]{64})$/.test(ref) ? ref.slice(4) : null;
    rows.push({
      id: identity.id,
      label: identity.label,
      summary: identity.summary,
      conclusion: parts.text,
      status: parts.status,
      judgment: parts.judgment,
      deviceAttempts: attempts.length,
      deviceRun: latest?.verification_run ?? null,
      deviceSha: sha,
    });
  }
  let correct = 0;
  let unconfirmed = 0;
  let wrong = 0;
  let unknown = 0;
  for (const row of rows) {
    if (row.judgment === '错误') wrong += 1;
    else if (row.judgment === '正确' && row.status === '已确认') correct += 1;
    else if (row.judgment === '正确' && row.status === '未确认') unconfirmed += 1;
    else unknown += 1;
  }
  const batchKeys = new Set(input.jobs.filter((job) => job.ended === 'done' && job.rows !== null).map((job) => job.job));
  return {
    rows,
    totals: {
      cases: rows.length,
      correct,
      unconfirmed,
      wrong,
      unknown,
      batches: batchKeys.size,
      startedAt: null,
      endedAt: null,
    },
  };
}

type RunReaderDetail = {
  run: RunRecordView;
  latest: { record?: string; result: ValidationResult } | null;
  production: { record?: string; result: ValidationResult } | null;
};

type RunReader = {
  getRun(user: PageContext['principal'], run: string, options?: typeof HISTORY): Promise<RunReaderDetail | null>;
  exportSuccessors?(user: PageContext['principal'], run: string): Promise<{ run: string; successors: ExportedSuccessor[] } | null>;
  exportJobs?(user: PageContext['principal'], run: string, options?: { reservations?: import('../../dispatch/api.ts').RunReservations }): Promise<{ run: string; jobs: ExportedJob[] } | null>;
  exportJobReservations?(user: PageContext['principal']): Promise<import('../../dispatch/api.ts').RunReservations | null>;
  listRuns?(user: PageContext['principal'], query?: { limit?: number; cursor?: string | null; requests?: boolean }): Promise<RunListing>;
  /** Point-lookup: validation_result digest → owning run id (or null). */
  runOfResult?(user: PageContext['principal'], digest: string): Promise<string | null>;
};

export type RoundTree = {
  anchor: RunRecordView;
  runs: RunRecordView[];
  details: Map<string, RunReaderDetail>;
  skipped: number;
  /** True when the anchor's own rec: could not be mapped to exactly one same-key run and no peer joined. */
  unlinked: boolean;
  /** True when the reverse index scan hit ROUND_RUNS_SCANNED. */
  partial: boolean;
  /** True when exportSuccessors returned null for at least one member (reader is not executor/admin). */
  successorsOpaque: boolean;
  /** True when the anchor has no subject src: (cluster of one, disclosed). */
  noSubject: boolean;
  /** Count of same-key visible runs seen in the scan that did not join for lack of an edge. */
  sameKeyUnlinked: number;
  /** getRun calls made while building the tree (for scale tests). */
  getRunCount: number;
};

function pickResult(detail: RunReaderDetail): ValidationResult | null {
  return detail.latest?.result ?? detail.production?.result ?? null;
}

export async function collectRoundTree(
  runs: RunReader,
  user: PageContext['principal'],
  anchorId: string,
): Promise<RoundTree | null> {
  let getRunCount = 0;
  const load = async (id: string): Promise<RunReaderDetail | null> => {
    getRunCount += 1;
    return runs.getRun(user, id, HISTORY);
  };

  const anchorDetail = await load(anchorId);
  if (anchorDetail === null) return null;
  const anchor = anchorDetail.run;
  if (subjectReference(anchor.sources) === null) {
    return {
      anchor,
      runs: [anchor],
      details: new Map([[anchor.run, anchorDetail]]),
      skipped: 0,
      unlinked: false,
      partial: false,
      successorsOpaque: false,
      noSubject: true,
      sameKeyUnlinked: 0,
      getRunCount,
    };
  }

  const byId = new Map<string, RunRecordView>([[anchor.run, anchor]]);
  const details = new Map<string, RunReaderDetail>([[anchor.run, anchorDetail]]);
  const queue = [anchor.run];
  let skipped = 0;
  let steps = 0;
  let partial = false;
  let successorsOpaque = false;
  /** Same-key headers seen without an edge at scan time; recount after the final member set is known. */
  const sameKeyUnjoined = new Set<string>();

  const admit = async (id: string): Promise<boolean> => {
    if (byId.has(id) || !RunId.safeParse(id).success) return false;
    const detail = await load(id);
    if (detail === null) {
      skipped += 1;
      return false;
    }
    if (!sameRoundKeys(anchor, detail.run)) return false;
    byId.set(detail.run.run, detail.run);
    details.set(detail.run.run, detail);
    queue.push(detail.run.run);
    return true;
  };

  const expandOutbound = async (id: string): Promise<void> => {
    const current = byId.get(id);
    if (current === undefined) return;
    for (const ref of outboundRunRefs(current)) await admit(ref);
    if (!runs.exportSuccessors) return;
    const listed = await runs.exportSuccessors(user, id);
    if (listed === null) {
      successorsOpaque = true;
      return;
    }
    for (const successor of listed.successors) await admit(successor.run);
  };

  while (queue.length && steps < LINEAGE_STEPS) {
    steps += 1;
    await expandOutbound(queue.shift()!);
  }

  // Forward rec: only from members already in the component; owner via point-lookup (not a full same-key scan).
  const resolveForwardRec = async (run: RunRecordView): Promise<void> => {
    if (!runs.runOfResult) return;
    for (const digest of recDigests(run.sources)) {
      const owner = await runs.runOfResult(user, digest);
      if (owner === null || owner === run.run) continue;
      await admit(owner);
    }
  };

  for (const run of [...byId.values()]) await resolveForwardRec(run);
  while (queue.length && steps < LINEAGE_STEPS) {
    steps += 1;
    const id = queue.shift()!;
    await expandOutbound(id);
    await resolveForwardRec(byId.get(id)!);
  }

  // Reverse edges: capped listRuns index scan; use listing headers (no getRun) until an edge hits the component.
  if (runs.listRuns) {
    let cursor: string | null | undefined = null;
    let scanned = 0;
    scan: while (scanned < ROUND_RUNS_SCANNED) {
      const listing: RunListing = await runs.listRuns(user, { limit: LIST_PAGE, cursor, requests: false });
      for (const header of listing.items) {
        scanned += 1;
        if (scanned > ROUND_RUNS_SCANNED) {
          partial = true;
          break scan;
        }
        if (byId.has(header.run) || !sameRoundKeys(anchor, header)) continue;
        const refs = outboundRunRefs(header);
        let joins = refs.some((ref) => byId.has(ref));
        if (!joins && runs.runOfResult) {
          for (const digest of recDigests(header.sources)) {
            const owner = await runs.runOfResult(user, digest);
            if (owner !== null && byId.has(owner)) {
              joins = true;
              break;
            }
          }
        }
        if (!joins) {
          sameKeyUnjoined.add(header.run);
          continue;
        }
        if (await admit(header.run)) {
          while (queue.length && steps < LINEAGE_STEPS) {
            steps += 1;
            const id = queue.shift()!;
            await expandOutbound(id);
            await resolveForwardRec(byId.get(id)!);
          }
        }
      }
      if (listing.next === undefined || listing.next === null || listing.next === cursor) break;
      cursor = listing.next;
      if (cursor !== null && scanned >= ROUND_RUNS_SCANNED) {
        partial = true;
        break;
      }
    }
    if (cursor !== null && cursor !== undefined && scanned >= ROUND_RUNS_SCANNED) partial = true;
  }

  const sameKeyUnlinked = [...sameKeyUnjoined].filter((id) => !byId.has(id)).length;
  const ordered = [...byId.values()].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));

  // Unlinked only describes the anchor's own unresolved rec: when it stayed alone.
  let unlinked = false;
  if (ordered.length === 1 && runs.runOfResult) {
    const named = outboundRunRefs(anchor);
    const digests = recDigests(anchor.sources);
    if (named.length === 0 && digests.length > 0) {
      const owners = new Set<string>();
      for (const digest of digests) {
        const owner = await runs.runOfResult(user, digest);
        if (owner !== null && owner !== anchor.run) owners.add(owner);
      }
      if (owners.size !== 1) unlinked = true;
    }
  }

  return { anchor, runs: ordered, details, skipped, unlinked, partial, successorsOpaque, noSubject: false, sameKeyUnlinked, getRunCount };
}

type JobsLoad = { jobs: ExportedJob[]; forbidden: boolean };

export async function loadJobs(runs: RunReader, user: PageContext['principal'], tree: readonly RunRecordView[]): Promise<JobsLoad> {
  if (!runs.exportJobs) return { jobs: [], forbidden: false };
  const out: ExportedJob[] = [];
  const seenJob = new Set<string>();
  let forbidden = false;
  const reservations = runs.exportJobReservations ? await runs.exportJobReservations(user) : null;
  const options = reservations !== null && reservations !== undefined ? { reservations } : undefined;
  for (const run of tree) {
    const listed = await runs.exportJobs(user, run.run, options);
    if (listed === null) {
      forbidden = true;
      continue;
    }
    // One reservation is indexed under both verification_run and plan_run; keep each job once.
    for (const job of listed.jobs) {
      if (seenJob.has(job.job)) continue;
      seenJob.add(job.job);
      out.push(job);
    }
  }
  return { jobs: out, forbidden };
}

/**
 * Oldest-first member runs: union projections by item.id; later accepted conclusions overwrite earlier ones
 * for the same id (so an 上机验证 after 脚本编写 replaces the earlier「等待」conclusion).
 */
export function mergeMemberItems(
  members: ReadonlyArray<{ items: readonly ItemProjection[]; result: ValidationResult | null }>,
): {
  projections: ItemProjection[];
  conclusionsByItem: Map<string, { item: ItemResult; original: ItemProjection | undefined }>;
} {
  const projectionsById = new Map<string, ItemProjection>();
  const conclusionsByItem = new Map<string, { item: ItemResult; original: ItemProjection | undefined }>();
  for (const member of members) {
    for (const item of member.items) {
      if (!projectionsById.has(item.id)) projectionsById.set(item.id, item);
    }
    if (member.result?.acceptance === 'accepted') {
      const originals = new Map(member.items.map((item) => [item.id, item]));
      for (const item of itemsOfResult(member.result)) {
        conclusionsByItem.set(item.item, { item, original: originals.get(item.item) });
      }
    }
  }
  return { projections: [...projectionsById.values()], conclusionsByItem };
}

export async function roundPage(ctx: PageContext): Promise<PageResult> {
  const runId = param(ctx, 'run');
  if (runId === undefined || !RUN_ID.test(runId)) return neutralPage(ctx);

  const reader: RunReader = {
    getRun: (user, run, options) => ctx.deps.runs.getRun(user, run, options),
    exportSuccessors: ctx.deps.runs.exportSuccessors?.bind(ctx.deps.runs),
    exportJobs: ctx.deps.runs.exportJobs?.bind(ctx.deps.runs),
    exportJobReservations: ctx.deps.runs.exportJobReservations?.bind(ctx.deps.runs),
    listRuns: ctx.deps.runs.listRuns.bind(ctx.deps.runs),
    runOfResult: async (_user, digest) => {
      const stored = await ctx.deps.records.store.get(digest);
      if (stored === null || stored.kind !== 'validation_result') return null;
      const run = (stored.body as { run?: unknown }).run;
      // Visibility is enforced when admit() calls getRun on this id.
      return typeof run === 'string' && RunId.safeParse(run).success ? run : null;
    },
  };

  const tree = await collectRoundTree(reader, ctx.principal, runId);
  if (tree === null) return neutralPage(ctx);

  const members: Array<{ items: ItemProjection[]; result: ValidationResult | null }> = [];
  for (const run of tree.runs) {
    const detail = tree.details.get(run.run) ?? await ctx.deps.runs.getRun(ctx.principal, run.run, HISTORY);
    if (detail === null) continue;
    members.push({ items: detail.run.items, result: pickResult(detail) });
  }
  const { projections, conclusionsByItem } = mergeMemberItems(members);

  const { jobs, forbidden: jobsForbidden } = await loadJobs(reader, ctx.principal, tree.runs);
  const { rows: allRows, totals } = buildRoundRows({ projections, conclusionsByItem, jobs });
  totals.startedAt = tree.runs[0]?.started_at ?? null;
  totals.endedAt = null;

  const after = param(ctx, 'cases_after');
  let start = 0;
  if (after !== undefined && after.length > 0) {
    const idx = allRows.findIndex((row) => row.id === after);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const pageRows = allRows.slice(start, start + ROUND_CASES_PAGE);
  const nextAfter = start + ROUND_CASES_PAGE < allRows.length ? pageRows[pageRows.length - 1]?.id : undefined;
  const hasMorePages = allRows.length > ROUND_CASES_PAGE;

  const head = html`${box({ title: '摘要' }, html`
<p class="ch-meta">${ROUND_HUB_NOTE}</p>
${kpi('一共', count(totals.cases))}
${kpi('已确认正确', count(totals.correct))}
${kpi('未确认', count(totals.unconfirmed))}
${kpi('错误', count(totals.wrong))}
${kpi('未知', count(totals.unknown))}
${kpi('完成的上机验证', count(totals.batches))}
`)}
${tree.skipped > 0 ? callout('warn', ROUND_PARTIAL_RUNS) : ''}
${tree.partial ? callout('info', ROUND_PARTIAL_SCAN) : ''}
${tree.successorsOpaque ? callout('warn', ROUND_SUCCESSORS_OPAQUE) : ''}
${tree.noSubject ? callout('unknown', ROUND_NO_SUBJECT) : ''}
${tree.sameKeyUnlinked > 0 ? callout('info', ROUND_SAME_KEY_UNLINKED) : ''}
${tree.unlinked ? callout('unknown', ROUND_UNLINKED) : ''}
${jobsForbidden ? callout('warn', ROUND_JOBS_FORBIDDEN) : ''}
${nextAfter !== undefined ? callout('info', ROUND_CASES_MORE) : hasMorePages && start > 0 ? callout('info', ROUND_CASES_PAGE_END) : ''}
${definitionsBlock(tree)}
`;

  const tableRows = pageRows.map((row) => [
    row.label,
    row.summary,
    row.conclusion,
    count(row.deviceAttempts),
    row.deviceRun && row.deviceSha
      ? link(roundDevicePath(), '打开设备输出', { run: row.deviceRun, sha256: row.deviceSha })
      : jobsForbidden
        ? ROUND_JOBS_FORBIDDEN
        : row.deviceAttempts > 0
          ? ROUND_DEVICE_PENDING
          : ROUND_NO_DEVICE,
  ]);

  const pager = nextAfter !== undefined
    ? html`<p>${link(roundsPath(), '后一页', { run: tree.anchor.run, cases_after: nextAfter })}</p>`
    : start > 0
      ? html`<p>${link(roundsPath(), '回到第一页', { run: tree.anchor.run })}</p>`
      : '';

  return {
    status: 200,
    body: page(
      ctx.chrome(ROUND_PAGE_TITLE, {
        active: 'tasks',
        sub: html`${link(runPath(tree.anchor.run), '当前打开的任务')}`,
        hint: '把同一份来源在同一个构建上、有前后步骤关系的相关任务串在一起看；每条原始用例一行，结论与模型在 Circle 里看到的一致。',
      }),
      html`${head}${table(
        ['原始用例', '说明', '结论', '本条上机验证次数', '设备输出'],
        tableRows,
        ROUND_EMPTY_CASES,
      )}${pager}`,
    ),
  };
}

function definitionsBlock(tree: { anchor: RunRecordView; runs: RunRecordView[] }): Html {
  return html`<p class="ch-meta">产品 ${tree.anchor.product ?? '未记录'} · 版本 ${tree.anchor.version ?? '未记录'} · 构建 ${tree.anchor.build ?? '未记录'} · 来源 ${subjectLabel(tree.anchor.sources)} · 可见任务 ${count(tree.runs.length)} · 开始 ${tree.runs[0] ? time(tree.runs[0].started_at) : '未知'}</p>`;
}

/** Device output: only when exportJobs for the runner/admin names this src: as device_return. */
export async function roundDevicePage(ctx: PageContext): Promise<PageResult> {
  const runId = param(ctx, 'run');
  const sha = param(ctx, 'sha256');
  if (runId === undefined || sha === undefined || !RUN_ID.test(runId) || !SHA256.test(sha)) return neutralPage(ctx);
  const jobs = ctx.deps.runs.exportJobs ? await ctx.deps.runs.exportJobs(ctx.principal, runId) : null;
  if (jobs === null) {
    return {
      status: 200,
      body: page(ctx.chrome(ROUND_DEVICE_TITLE, { active: 'tasks', sub: link(roundsPath(), '返回相关任务', { run: runId }) }), html`<p>${ROUND_JOBS_FORBIDDEN}</p>`),
    };
  }
  const allowed = jobs.jobs.some((job) => job.device_return === `src:${sha}`);
  if (!allowed) return neutralPage(ctx);
  // Device returns are job outputs, not run sources (artifacts.sourceForRun only sees snapshot.sources / item locations).
  // Gate already matched device_return via exportJobs; read bytes the same way run-export's jobOutput does.
  const source = await ctx.deps.records.artifacts.sourceForRun(ctx.principal, sha, runId)
    ?? await ctx.deps.records.artifacts.source(ctx.principal, sha);
  if (source === null || source.bytes === null) {
    return {
      status: 200,
      body: page(ctx.chrome(ROUND_DEVICE_TITLE, { active: 'tasks', sub: link(roundsPath(), '返回相关任务', { run: runId }) }), html`<p>${ROUND_DEVICE_UNREADABLE}</p><p class="ch-meta">${NEUTRAL}</p>`),
    };
  }
  const text = Buffer.from(source.bytes).toString('utf8');
  const preview = text.length > 200_000 ? `${text.slice(0, 200_000)}\n…（其后省略）` : text;
  return {
    status: 200,
    body: page(
      ctx.chrome(ROUND_DEVICE_TITLE, { active: 'tasks', sub: html`${link(roundsPath(), '返回相关任务', { run: runId })} · ${link(runPath(runId), '任务')}` }),
      pre(preview),
    ),
  };
}
