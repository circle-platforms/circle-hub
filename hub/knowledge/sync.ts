// The knowledge sync (W09 standing obligation, executed by the Hub): run the product pack's sync declaration (read the start
// pages, parse them, ask the plan function which pages to read next, until it is done or a limit is hit, which is reported),
// store every planned build of every name family, produce the root of every own-tree build that is missing or whose sources
// or producer changed, and move each touched line's current root to its newest build by compare-and-set. Idempotent (an
// unchanged build is skipped), resumable (every production or failure is a generate action; a rerun skips what is done),
// bounded (concurrency, per-build bytes, rounds and reads) and reported per build.
import { SyncPlanOutput, expandTemplate } from '../../contracts/src/product.ts';
import type { BuildInfo, SyncPlanInput } from '../../contracts/src/product.ts';
import type { ProductHandle } from '../ports.ts';
import { canonicalize, newId, type ActionBody, type Principal } from '../records/api.ts';
import { SANDBOX_ERRORS, SandboxError, callPackFunction } from '../rules/api.ts';
import type { Builds, LineReconciliation } from './builds.ts';
import { requireAdmin, type KnowledgeContext } from './context.ts';
import { compareText, cutText } from './digest.ts';
import { describeError } from './errors.ts';
import { PLACEMENT_CHAIN } from './calibration.ts';
import { infoOf, plannedSources, produceTree } from './produce.ts';
import { SourceLoader } from './sources.ts';
import { ACTION, COMPONENTS, INDEX, buildProblem, fold } from './store.ts';

export const DEFAULT_MAX_ROUNDS = 6;
export const DEFAULT_MAX_READS = 300;

export interface SyncOptions {
  /** The admin whose context reads (default the service's admin). */
  by?: Principal | null;
  /** Version lines to sync; passed to the plan function as options.lines (over the declaration's options). */
  lines?: string[];
  /** Further plan options over the declaration's defaults. */
  options?: Record<string, unknown>;
  /** Run the plan and report what would be done; store no build, produce no root, move no pointer. */
  dryRun?: boolean;
  /** Re-read the sources of builds that already have a root and produce again when a digest changed. */
  recheck?: boolean;
  /** Also produce own-tree builds that are not released and no released alias needs. */
  includeUnreleased?: boolean;
  /** Builds produced at the same time (default the service limit, 2). */
  concurrency?: number;
  signal?: AbortSignal;
}

/** Outcome words of the per-build report, as the brief names them; no vocabulary axis holds them yet (README, Needs). */
export type BuildOutcome = 'produced' | 'skipped' | 'failed';

export interface SyncBuildReport {
  name: string;
  family: string;
  line: string;
  base: string;
  outcome: BuildOutcome;
  /** Chinese reason. */
  reason: string;
  root: string | null;
  composition: string | null;
  /** Dry run only: a root would be produced. */
  would_produce?: boolean;
  refused?: number;
  unplaced?: number;
}

export interface SyncReport {
  sync: string;
  product: string;
  pack: string;
  dry_run: boolean;
  started_at: string;
  ended_at: string;
  plan: {
    rounds: number;
    done: boolean;
    note: string | null;
    builds: number;
    reads: number;
    failed_reads: Array<{ id: string; reason: string }>;
    limits: { rounds: boolean; reads: boolean; max_rounds: number; max_reads: number };
  };
  builds: SyncBuildReport[];
  pointers: LineReconciliation[];
  counts: { produced: number; skipped: number; failed: number };
  warnings: string[];
  /** A failure of the whole sync (no declaration, a broken plan function); builds are then not processed. */
  error: string | null;
}

type SyncRead = SyncPlanInput['read'][string];

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export async function syncProduct(context: KnowledgeContext, builds: Builds, product: ProductHandle, options: SyncOptions = {}): Promise<SyncReport> {
  const by = await requireAdmin(context, options.by, '运行知识同步');
  const startedAt = context.now().toISOString();
  const sync = newId('sync');
  const productId = product.product.id;
  const declaration = product.product.sync;
  const maxRounds = declaration?.max_rounds ?? DEFAULT_MAX_ROUNDS;
  const maxReads = declaration?.max_reads ?? DEFAULT_MAX_READS;
  const dryRun = options.dryRun === true;
  const report: SyncReport = {
    sync,
    product: productId,
    pack: `${product.id}@${product.version}`,
    dry_run: dryRun,
    started_at: startedAt,
    ended_at: startedAt,
    plan: { rounds: 0, done: false, note: null, builds: 0, reads: 0, failed_reads: [], limits: { rounds: false, reads: false, max_rounds: maxRounds, max_reads: maxReads } },
    builds: [],
    pointers: [],
    counts: { produced: 0, skipped: 0, failed: 0 },
    warnings: [],
    error: null,
  };
  const finish = (): SyncReport => {
    report.ended_at = context.now().toISOString();
    for (const build of report.builds) report.counts[build.outcome]++;
    return report;
  };
  if (declaration === undefined) {
    report.error = '产品包没有声明 sync，无法同步';
    return finish();
  }
  const loader = new SourceLoader({ external: context.external, artifacts: context.records.artifacts, parsers: context.parsers }, by, 'knowledge sync');

  // ---------------------------------------------------------------- plan rounds
  const planOptions: Record<string, unknown> = { ...(declaration.options ?? {}), ...(options.options ?? {}) };
  if (options.lines !== undefined) planOptions.lines = [...options.lines];
  const values: Record<string, string> = { product: productId };
  if (options.lines !== undefined && options.lines.length === 1) values.line = options.lines[0];
  let pending: string[] = [];
  for (const template of declaration.start) {
    try {
      pending.push(expandTemplate(template, values));
    } catch (error) {
      report.error = `起始页模板 ${template} 填不出：${(error as Error).message}`;
      return finish();
    }
  }
  const read: Record<string, SyncRead> = {};
  let reads = 0;
  let output: SyncPlanOutput | null = null;
  let planAction: string | null = null;
  for (let round = 1; round <= maxRounds; round++) {
    const fresh: string[] = [];
    for (const id of pending) {
      if (Object.hasOwn(read, id)) continue;
      if (reads >= maxReads) {
        report.plan.limits.reads = true;
        break;
      }
      reads++;
      read[id] = await readPage(loader, id, context.limits.maxBuildBytes);
      fresh.push(id);
      if (!read[id].ok) report.plan.failed_reads.push({ id, reason: read[id].reason ?? '读取失败' });
    }
    report.plan.reads = reads;
    report.plan.rounds = round;
    const known = (await builds.known(productId)).map((b) => ({ name: b.name, base: b.base, root: b.root }));
    const input: SyncPlanInput = { round, options: planOptions, read, known };
    const planned = await runPlan(context, product, input);
    if (!dryRun) planAction = await writePlanAction(context, { sync, product: productId, round, fresh: fresh.length, pages: Object.keys(read), output: planned.ok ? planned.value : null, reason: planned.ok ? null : planned.reason, startedAt, read });
    if (!planned.ok) {
      report.error = planned.reason;
      return finish();
    }
    output = planned.value;
    if (output.done) break;
    if (report.plan.limits.reads) break;
    pending = output.fetch.filter((id) => !Object.hasOwn(read, id));
    if (round === maxRounds) report.plan.limits.rounds = true;
  }
  if (output === null) {
    report.error = '计划函数没有给出结果';
    return finish();
  }
  report.plan.done = output.done;
  report.plan.note = output.note === undefined ? null : cutText(output.note, 1000);
  if (report.plan.limits.rounds) report.warnings.push(`计划函数在 ${maxRounds} 轮后仍未完成，按最后一轮列出的构建继续`);
  if (report.plan.limits.reads) report.warnings.push(`读页数达到上限 ${maxReads}，计划没有读完，按最后一轮列出的构建继续`);

  // ---------------------------------------------------------------- builds
  const planned = new Map<string, BuildInfo>();
  for (const build of output.builds) planned.set(build.name, build);
  report.plan.builds = planned.size;
  const names = new Set(product.product.names.map((name) => fold(name)));
  const releasedAliasBases = new Set([...planned.values()].filter((b) => b.base !== b.name && b.released_at !== null).map((b) => b.base));
  const pack = { id: product.id, version: product.version, digest: product.digest };
  const own: BuildInfo[] = [];
  const touchedLines = new Set<string>();
  const ordered = [...planned.values()].sort((a, b) => compareText(a.line, b.line) || compareText(a.name, b.name));
  for (const build of ordered) {
    const base = { name: build.name, family: build.family, line: build.line, base: build.base, root: null, composition: null };
    // Nothing of a build the store cannot index is written; it is a failed build of the report, the others go on.
    const problem = buildProblem(productId, build);
    if (problem !== null) {
      report.builds.push({ ...base, outcome: 'failed', reason: problem });
      continue;
    }
    if (!names.has(fold(build.family))) {
      report.builds.push({ ...base, outcome: 'failed', reason: `名称族 ${cutText(build.family, 80)} 不是产品 ${productId} 的名称（${product.product.names.join('、')}）` });
      continue;
    }
    if (!dryRun) {
      try {
        await builds.record(productId, pack, build, planAction, sync);
      } catch (error) {
        report.builds.push({ ...base, outcome: 'failed', reason: `记录构建时出错：${describeError(error)}` });
        continue;
      }
    }
    touchedLines.add(build.line);
    if (build.base !== build.name) {
      const target = planned.get(build.base) ?? (await builds.resolve(productId, build.base));
      report.builds.push({
        ...base,
        outcome: 'skipped',
        reason: target === null ? `别名，基于 ${build.base}；这个基础构建不在计划里，也不在知识库里` : `别名，使用 ${build.base} 的树`,
      });
      continue;
    }
    if (Object.keys(build.sources).length === 0) {
      report.builds.push({ ...base, outcome: 'skipped', reason: '没有树的来源' });
      continue;
    }
    if (build.released_at === null && !releasedAliasBases.has(build.name) && options.includeUnreleased !== true) {
      report.builds.push({ ...base, outcome: 'skipped', reason: '未发布，不产出根' });
      continue;
    }
    own.push(build);
  }

  const results = new Map<string, SyncBuildReport>();
  await pool(own, Math.max(1, options.concurrency ?? context.limits.concurrency), async (build) => {
    const base = { name: build.name, family: build.family, line: build.line, base: build.base };
    if (options.signal?.aborted) {
      results.set(build.name, { ...base, outcome: 'failed', reason: '同步被中止，这个构建没有处理', root: null, composition: null });
      return;
    }
    try {
      results.set(build.name, await processOwnTree(context, product, build, { sync, loader, by, dryRun, recheck: options.recheck === true, signal: options.signal }));
    } catch (error) {
      // A failure of one build never stops the others; the rerun picks it up.
      results.set(build.name, { ...base, outcome: 'failed', reason: `处理时出错：${describeError(error)}`, root: null, composition: null });
    }
  });
  for (const build of own) report.builds.push(results.get(build.name) as SyncBuildReport);
  report.builds.sort((a, b) => compareText(a.line, b.line) || compareText(a.name, b.name));

  // ---------------------------------------------------------------- current roots
  if (!dryRun) {
    for (const line of [...touchedLines].sort(compareText)) {
      try {
        report.pointers.push(await builds.reconcileLine(productId, line, by));
      } catch (error) {
        report.pointers.push({ line, from: null, to: null, build: null, moved: false, reason: `移动当前根时出错：${describeError(error)}` });
      }
    }
  }
  return finish();
}

async function processOwnTree(
  context: KnowledgeContext,
  product: ProductHandle,
  build: BuildInfo,
  options: { sync: string; loader: SourceLoader; by: Principal; dryRun: boolean; recheck: boolean; signal?: AbortSignal },
): Promise<SyncBuildReport> {
  const productId = product.product.id;
  const base = { name: build.name, family: build.family, line: build.line, base: build.base };
  const info = infoOf(build);
  const existing = await context.store.latestProduction(productId, build.name);
  const keyOf = (s: { producer: string; slot: string; external: string | null }): string => `${s.producer}\u0000${s.slot}\u0000${s.external ?? ''}`;
  const plannedKeys = plannedSources(product, info).map(keyOf).sort(compareText);
  // Why the newest production no longer stands for this build, or null when it still does (checked cheapest first).
  let changed: string | null = null;
  if (existing !== null) {
    const recorded = existing.detail.placement;
    if (existing.detail.pack.digest !== product.digest) changed = '生产器变了';
    else if (existing.record.body.component !== COMPONENTS.produce) changed = `Hub 的生产组件变了（${existing.record.body.component} → ${COMPONENTS.produce}）`;
    // The listing changed (released since, other line or platform, other sources): the composition records the build as listed.
    else if (canonicalize(existing.detail.build) !== canonicalize(info)) changed = '构建信息变了';
    else if (recorded !== null && recorded.spans > 0) {
      // Spans placed by the typed-judgment model depend on the model and the chain's calibration; a judge failure is retried.
      const model = context.placer.model;
      const threshold = model === null ? null : await context.calibration.threshold(PLACEMENT_CHAIN, model);
      if (recorded.failed > 0) changed = `上次有 ${recorded.failed} 个片段的归类判断失败`;
      else if (recorded.model !== model || recorded.threshold !== threshold) changed = '归类判断的模型或本链的校准变了';
    }
    if (changed === null) {
      // The same external sources as then (read, or optional and missing).
      const recordedKeys = [...existing.detail.sources, ...existing.detail.missing].map(keyOf).sort(compareText);
      if (recordedKeys.length !== plannedKeys.length || recordedKeys.some((key, i) => key !== plannedKeys[i])) changed = '来源变了';
    }
    if (changed === null) {
      // An optional source that was missing is read again every time (one read per sync for a source builds share).
      for (const source of existing.detail.missing) {
        if (source.external !== null && (await options.loader.read(source.external)).ok) {
          changed = `可选来源 ${source.external} 现在能读到了`;
          break;
        }
      }
    }
    if (changed === null && !options.recheck) {
      return { ...base, outcome: 'skipped', reason: '已有根，来源和生产器都没有变', root: existing.detail.root, composition: existing.detail.composition };
    }
    if (changed === null) {
      let unchanged = true;
      for (const source of existing.detail.sources) {
        const load = await options.loader.read(source.external);
        if (!load.ok || load.artifact.body.sha256 !== source.sha256) unchanged = false;
      }
      if (unchanged) return { ...base, outcome: 'skipped', reason: '已有根，重读后来源摘要没有变', root: existing.detail.root, composition: existing.detail.composition };
      changed = '来源变了';
    }
  }
  if (options.dryRun) {
    const why = existing === null ? '试运行：会产出根' : `试运行：${changed ?? '来源变了'}，会重新产出根`;
    return { ...base, outcome: 'skipped', reason: why, root: existing?.detail.root ?? null, composition: existing?.detail.composition ?? null, would_produce: true };
  }
  const produced = await produceTree(context, {
    product,
    build: { ...info, root: existing?.detail.root ?? null },
    by: options.by,
    sync: options.sync,
    loader: options.loader,
    signal: options.signal,
  });
  if (!produced.ok) return { ...base, outcome: 'failed', reason: produced.reason ?? '生产失败', root: null, composition: null, refused: produced.refusedCount };
  const note = produced.refusedCount > 0 ? `；${produced.refusedCount} 个条目没有通过核对` : '';
  const same = existing !== null && existing.detail.root === produced.root ? '（内容与上次相同）' : '';
  const cause = existing === null ? '' : `；重新产出：${changed ?? '来源变了'}`;
  return {
    ...base,
    outcome: 'produced',
    reason: `产出根，${produced.nodes} 个节点（新写 ${produced.created} 个）、${produced.entries} 个条目${same}${note}${cause}`,
    root: produced.root,
    composition: produced.composition,
    refused: produced.refusedCount,
    unplaced: produced.unplaced,
  };
}

/** One page of the plan: read, checked like any source, parsed with the core parser for its media type. */
async function readPage(loader: SourceLoader, id: string, maxBytes: number): Promise<SyncRead> {
  const load = await loader.read(id);
  if (!load.ok) return { ok: false, media_type: null, parser: null, model: null, reason: load.reason };
  const mediaType = load.artifact.body.media_type;
  const readable = await loader.readable(load, maxBytes);
  if (!readable.ok) return { ok: false, media_type: mediaType, parser: null, model: null, reason: readable.reason };
  const parsed = loader.parse(readable.value);
  if (!parsed.ok) return { ok: false, media_type: mediaType, parser: null, model: null, reason: parsed.reason };
  return { ok: true, media_type: mediaType, parser: parsed.value.parser, model: parsed.value.document.model, reason: null };
}

type PlanRun = { ok: true; value: SyncPlanOutput } | { ok: false; reason: string };

async function runPlan(context: KnowledgeContext, product: ProductHandle, input: SyncPlanInput): Promise<PlanRun> {
  const declaration = product.product.sync;
  if (declaration === undefined) return { ok: false, reason: '产品包没有声明 sync' };
  let output: unknown;
  try {
    const run = await callPackFunction(
      { packDir: product.directory, module: declaration.plan.module, export: declaration.plan.export },
      input,
      context.sandbox.plan,
      { requireOsIsolation: context.sandbox.requireOsIsolation },
    );
    output = run.output;
  } catch (error) {
    if (error instanceof SandboxError) return { ok: false, reason: `计划函数第 ${input.round} 轮运行失败：${SANDBOX_ERRORS[error.code]}` };
    return { ok: false, reason: `计划函数第 ${input.round} 轮运行失败：${describeError(error)}` };
  }
  const parsed = SyncPlanOutput.safeParse(output);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `计划函数第 ${input.round} 轮的输出不符合 sync-plan-output@1：${issue === undefined ? '' : `${issue.path.join('/')} ${issue.message}`}` };
  }
  return { ok: true, value: parsed.data };
}

/** The parse action of one plan round: the pages read so far as inputs, what the plan answered. */
async function writePlanAction(
  context: KnowledgeContext,
  input: { sync: string; product: string; round: number; fresh: number; pages: string[]; output: SyncPlanOutput | null; reason: string | null; startedAt: string; read: Record<string, SyncRead> },
): Promise<string> {
  const body: ActionBody = {
    action: ACTION.parse,
    run: null,
    item: null,
    inputs: input.pages.slice(0, 200),
    component: COMPONENTS.sync,
    lease: null,
    started_at: input.startedAt,
    ended_at: context.now().toISOString(),
    result: input.output === null ? 'error' : 'completed',
    error_code: null,
    acceptance: null,
    codes: [],
    detail: {
      sync: input.sync,
      product: input.product,
      round: input.round,
      pages: input.pages.length,
      read_this_round: input.fresh,
      failed_pages: Object.values(input.read).filter((r) => !r.ok).length,
      fetch: input.output?.fetch.length ?? null,
      builds: input.output?.builds.length ?? null,
      done: input.output?.done ?? null,
      // What the pack function wrote is made storable (a lone surrogate would fail the whole sync).
      note: input.output?.note === undefined ? null : cutText(input.output.note, 1000),
      reason: input.reason === null ? null : cutText(input.reason, 2000),
    },
  };
  const record = await context.store.putAction(body, [{ key: INDEX.sync, value: input.sync }]);
  return record.digest;
}
