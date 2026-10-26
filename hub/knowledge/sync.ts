import { labelOf } from '../../contracts/generated/vocabulary.ts';
import type { KnowledgeEntryCounts } from '../../contracts/src/views.ts';
import {knowledgeSourceLoader,reconcileCredentialRequests} from './credential-policy.ts';
// The knowledge sync (W09 standing obligation, executed by the Hub): run the product pack's sync declaration (read the start
// pages, parse them, ask the plan function which pages to read next, until it is done or a limit is hit, which is reported),
// store every planned build of every name family, produce the root of every own-tree build that is missing or whose sources
// or producer changed, and move each touched line's current root to its newest build by compare-and-set. Idempotent (an
// unchanged build is skipped), resumable (every production or failure is a generate action; a rerun skips what is done),
// bounded (concurrency, per-build bytes, rounds and reads) and reported per build.
import { z } from 'zod';
import type { ProtocolCode } from '../../contracts/generated/protocol.ts';
import {resolveProductVariables,sameVariableUses,productionVariableUses} from './variables.ts';
import {emptyScopeNote} from './empty-scope.ts';
import type {VariableUse} from '../../contracts/src/variables.ts';
import { BuildInfo, SyncPlanOutput, expandTemplate } from '../../contracts/src/product.ts';
import type { SyncPlanInput } from '../../contracts/src/product.ts';
import type { ProductHandle } from '../ports.ts';
import { canonicalize, newId, sha256Hex, type ActionBody, type Principal } from '../records/api.ts';
import { SANDBOX_ERRORS, SandboxError, callPackFunction } from '../rules/api.ts';
import type { Builds, LineReconciliation } from './builds.ts';
import { mapLimited } from './concurrency.ts';
import { DEFAULT_SANDBOX, requireAdmin, type KnowledgeContext } from './context.ts';
import { compareText, cutText } from './digest.ts';
import { describeError } from './errors.ts';
import { PLACEMENT_CHAIN } from './calibration.ts';
import { ListLoader, uniqueList } from './lists.ts';
import { infoOf, plannedSources, produceTree } from './produce.ts';
import {loadSyncCheckpoint,saveSyncCheckpoint,syncCheckpointKey} from './sync-checkpoint.ts';
import {requestKnowledgeFact} from './requests.ts';
import {KnowledgeStore,buildKey} from './store.ts';
import {readProblemRows} from './problem-journal.ts';
import { readPage } from './page.ts';
import { SourceLoader } from './sources.ts';
import { ACTION, COMPONENTS, INDEX, buildProblem, fold, listRoles, recordedOf, withoutLists, pointerName } from './store.ts';

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
  /** List sources stored at most this many seconds ago are used again without a read (default the limit, 86400; 0 reads every one). */
  maxAgeSeconds?: number;
  /** List sources read at the same time per production (default the limit, 4). */
  readConcurrency?: number;
  signal?: AbortSignal;
}

/** Outcome words of the per-build report, as the brief names them; no vocabulary axis holds them yet (README, Needs). */
export type BuildOutcome = 'produced' | 'skipped' | 'failed' | 'registered';

export interface SyncBuildReport {
  /** Distinct content identities for this root only; unlike the legacy raw composition row fields. */
  entry_counts?: KnowledgeEntryCounts;
  name: string;
  family: string;
  line: string;
  base: string;
  outcome: BuildOutcome;
  /** Chinese reason. */
  reason: string;
  reason_code?: ProtocolCode;
  root: string | null;
  composition: string | null;
  /** Dry run only: a root would be produced. */
  would_produce?: boolean;
  refused?: number;
  unplaced?: number;
  /** Listed sources the production could not use. */
  skipped?: number;
  /** Producer calls made and answered from stored outputs. */
  calls?: { made: number; reused: number };
  /** Entries without path not sent to the judgment service per producer. */
  placement_skipped?: Record<string, number>;
}

export interface SyncReport {
  variables?: Array<{name:string;version:number|null;default:boolean}>;
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
  scope?: Omit<SyncBuildReport, 'name' | 'family' | 'line' | 'base'>;
  pointers: LineReconciliation[];
  counts: { produced: number; registered: number; skipped: number; failed: number };
  warnings: string[];
  /** A failure of the whole sync (no declaration, a broken plan function); builds are then not processed. */
  error: string | null;
}

type SyncRead = SyncPlanInput['read'][string];

/** A plan answer as checked: its builds that are build-info@1, and those that are not (failed builds of the report). */
interface PlanAnswer {
  scope?: BuildInfo['sources'];
  fetch: string[];
  builds: BuildInfo[];
  failed_builds?: SyncPlanOutput['failed_builds'];
  invalid: Array<{ index: number; raw: unknown; reason: string }>;
  done: boolean;
  note?: string;
}

/** The envelope of sync-plan-output@1 with the builds unchecked: one build that is not build-info@1 fails only itself. */
const PlanEnvelope = z.strictObject({ failed_builds: SyncPlanOutput.shape.failed_builds, scope: SyncPlanOutput.shape.scope, fetch: SyncPlanOutput.shape.fetch, builds: z.array(z.unknown()), done: z.boolean(), note: z.string().optional() });

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
  await reconcileCredentialRequests(context);
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
    counts: { produced: 0, registered: 0, skipped: 0, failed: 0 },
    warnings: [],
    error: null,
  };
  const finish = (): SyncReport => {
    report.ended_at = context.now().toISOString();
    for (const build of report.builds) report.counts[build.outcome]++;
    if (report.scope) report.counts[report.scope.outcome]++;
    return report;
  };  if (declaration === undefined) {
    report.error = '产品包没有声明 sync，无法同步';
    return finish();
  }
  const resolved=await resolveProductVariables(product,context.records.variables,by,dryRun,{plan:{...DEFAULT_SANDBOX.plan,...context.sandbox.plan},producer:{...DEFAULT_SANDBOX.producer,...context.sandbox.producer}});
  if('problems' in resolved){report.error=resolved.problems.join('；');return finish();}
  product=resolved.product;
  report.variables=resolved.versions;
  const declarationResolved=product.product.sync!;
  const variableUses=resolved.uses;
  const loader = knowledgeSourceLoader(context,by,'knowledge sync',resolved.snapshot);

  // ---------------------------------------------------------------- plan rounds
  const planOptions: Record<string, unknown> = { ...(declarationResolved.options ?? {}), ...(options.options ?? {}) };
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
  const checkpointKey=syncCheckpointKey(productId,product.digest,planOptions);
  const saved=await loadSyncCheckpoint(context,checkpointKey,loader);
  const read: Record<string, SyncRead> = {};
  const requiredBases=new Set<string>(saved?.required_builds??[]);
  if(saved){for(const page of saved.captured)read[page.id]=await readPage(loader,page.id,context.limits.maxBuildBytes);pending=[...new Set([...saved.pending,...pending.filter(id=>!Object.hasOwn(read,id))])];}
  if(requiredBases.size)planOptions.required_builds=[...requiredBases].sort();
  let reads = 0;
  let output: PlanAnswer | null = null;
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
    if (!dryRun) planAction = await writePlanAction(context, { sync, product: productId, round, fresh: fresh.length, pages: Object.keys(read), output: planned.ok ? planned.value : null, reason: planned.ok ? null : planned.reason, startedAt, read, variables:variableUses.filter(v=>v.at.includes('#/sync/options/')) });
    if (!planned.ok) {
      report.error = planned.reason;
      return finish();
    }
    output = planned.value;
    const named=new Set([...output.builds.filter(build=>build.base!==build.name||Object.keys(build.sources).length>0).map(build=>build.name),...known.filter(build=>build.root!==null).map(build=>build.name)]);
    const unresolved=output.builds.filter(build=>build.base!==build.name&&!named.has(build.base)).map(build=>build.base);
    const newBases=unresolved.filter(name=>!requiredBases.has(name));
    newBases.forEach(name=>requiredBases.add(name));
    if(requiredBases.size)planOptions.required_builds=[...requiredBases].sort();
    pending=[...new Set([...pending.filter(id=>!Object.hasOwn(read,id)),...output.fetch.filter(id=>!Object.hasOwn(read,id))])];
    if(output.done&&newBases.length===0)break;
    output.done=false;
    if (report.plan.limits.reads) break;
    if (round === maxRounds) report.plan.limits.rounds = true;
  }
  if (output === null) {
    report.error = '计划函数没有给出结果';
    return finish();
  }
  if(!dryRun)await saveSyncCheckpoint(context,checkpointKey,loader,{sync,pending,required_builds:[...requiredBases],done:output.done&&pending.length===0});
  if(!dryRun&&context.feeding)for(const page of await loader.captured()){const receipt=await context.feeding.observeSource(by,page.sha256,{product:productId,sourceRecord:page.artifact,requested:page.id});for(const pending of receipt.pending)report.warnings.push('喂入未核对：'+pending.missing+'；下一步：'+pending.next_action);}
  const listingDigest=sha256Hex(canonicalize((await loader.captured()).map(page=>({id:page.id,artifact:page.sha256})).sort((a,b)=>compareText(a.id,b.id))));
  report.plan.done = output.done;
  report.plan.note = output.note === undefined ? null : cutText(output.note, 1000);
  if (report.plan.limits.rounds) report.warnings.push(`计划函数在 ${maxRounds} 轮后仍未完成，按最后一轮列出的构建继续`);
  if (report.plan.limits.reads) report.warnings.push(`读页数达到上限 ${maxReads}，计划没有读完，按最后一轮列出的构建继续`);

  // ---------------------------------------------------------------- builds
  const planned = new Map<string, BuildInfo>();
  for (const build of output.builds) planned.set(build.name, build);
  /** The plan's build names: the frozen known-build inventory every producer of this sync hashes (K01 R[1]). */
  const planBuilds = [...planned.keys()].sort(compareText);
  report.plan.builds = planned.size + output.invalid.length + (output.failed_builds?.length ?? 0);
  // A build the plan gave that is not build-info@1 fails alone (README decision 12); the others go on.
  for (const bad of output.invalid) {
    const raw = typeof bad.raw === 'object' && bad.raw !== null ? (bad.raw as Record<string, unknown>) : {};
    const text = (value: unknown, fallback: string): string => (typeof value === 'string' && value !== '' ? cutText(value, 200) : fallback);
    const name = text(raw.name, `（计划的第 ${bad.index + 1} 个构建）`);
    report.builds.push({ name, family: text(raw.family, '?'), line: text(raw.line, '?'), base: text(raw.base, name), outcome: 'failed', reason: bad.reason, root: null, composition: null });
  }
  const names = new Set(product.product.names.map((name) => fold(name)));
  const releasedAliasBases = new Set([...planned.values()].filter((b) => b.base !== b.name && b.released_at !== null).map((b) => b.base));
  const pack = { id: product.id, version: product.version, digest: product.digest };
  for (const failed of output.failed_builds ?? []) {
    const build = failed.build;
    const problem = buildProblem(productId, build);
    if (!dryRun && problem === null && names.has(fold(build.family))) {
      // A bad new observation must never replace an existing successful build or its root.
      if (await builds.named(productId, build.name) === null) await builds.record(productId, pack, { ...build, base: build.name, sources: {} }, planAction, sync);
      const previous = await builds.resolve(productId, build.name);
      await context.store.putAction({
        action: ACTION.generate, run: null, item: null, component: COMPONENTS.sync,
        inputs: planAction === null ? [] : [`rec:${planAction}`], lease: null,
        started_at: startedAt, ended_at: context.now().toISOString(), result: 'error',
        error_code: failed.reason, acceptance: null, codes: [],
        detail: { sync, product: productId, ...failed, root: null, composition: null, previous_root: previous?.root ?? null },
      }, [
        { key: INDEX.buildFailure, value: productId },
        { key: INDEX.buildFailureName, value: `${productId}/${fold(build.name)}` },
        { key: INDEX.buildFailureRoot, value: `${productId}/none` },
        ...(previous?.root ? [{ key: INDEX.buildFailureRoot, value: `${productId}/${previous.root}` }] : []),
      ]);
    }
    report.builds.push({ name: build.name, family: build.family, line: build.line, base: build.base,
      outcome: 'failed', reason: problem ?? `${failed.reason}：${failed.fix}`, reason_code: failed.reason, root: null, composition: null });
  }
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
      if(target===null&&!dryRun)await requestKnowledgeFact(context,{kind:'repair',subject:`${productId}/${build.base}`,missing:'计划补取后仍未列出别名所需的基础构建',action:'联系产品包作者核对构建站列表和基础构建引用，修正计划后重新同步',inputs:planAction?[`rec:${planAction}`]:[]});
      report.builds.push({
        ...base,
        outcome: target===null?'failed':'skipped',
        reason: target === null ? `别名，基于 ${build.base}；这个基础构建不在计划里，也不在知识库里` : `别名，使用 ${build.base} 的树`,
      });
      continue;
    }
    if (Object.keys(build.sources).length === 0) {
      // A build with no readable source is registered by name only (the plan lists it so the candidates know the
      // name); it gets no root, is no failure and never floods the skipped list.
      report.builds.push({ ...base, outcome: 'registered', reason: '没有可读的来源，只登记名字' });
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
      results.set(
        build.name,
        await processOwnTree(context, product, build, {
          sync,
          listingDigest,
          variables:variableUses,
          loader,
          by,
          dryRun,
          recheck: options.recheck === true,
          signal: options.signal,
          ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
          ...(options.readConcurrency === undefined ? {} : { readConcurrency: options.readConcurrency }),
        }),
      );
    } catch (error) {
      // A failure of one build never stops the others; the rerun picks it up.
      results.set(build.name, { ...base, outcome: 'failed', reason: `处理时出错：${describeError(error)}`, root: null, composition: null });
    }
  });
  for (const build of own) report.builds.push(results.get(build.name) as SyncBuildReport);
  report.builds.sort((a, b) => compareText(a.line, b.line) || compareText(a.name, b.name));

  if(!dryRun&&!options.signal?.aborted)for(const row of report.builds){
    if(row.base===row.name||row.outcome==='failed')continue;
    const base=planned.get(row.base),alias=planned.get(row.name);
    // An unpublished alias and its deliberately excluded base have no production obligation.
    // A published alias still requires its base, and actual production failures remain failures.
    if(options.includeUnreleased!==true&&base?.released_at===null&&alias?.released_at===null&&!releasedAliasBases.has(row.base)){
      row.reason=`别名的基础构建 ${row.base} 未发布，本次不产出根`;continue;
    }
    const root=await builds.rootOfBuild(productId,row.name);
    if(root===null){
      row.outcome='failed';row.reason=`基础构建 ${row.base} 没有形成可用根；已登记核对请求，修复来源或计划后重新同步`;
      await requestKnowledgeFact(context,{kind:'repair',subject:`${productId}/${row.base}`,missing:'别名依赖的基础构建没有可用根',action:'管理员核对基础构建的同步失败动作，恢复来源或请包作者修正计划后重新同步',inputs:planAction?[`rec:${planAction}`]:[]});
    }
  }

  if (output.scope !== undefined) {
    if(options.signal?.aborted) {
      report.scope={outcome:'failed',reason:'同步被中止，不分版本范围没有处理；下一步：重新同步这条产品线',root:null,composition:null};
    } else try {
      const observed=dryRun?null:await context.records.pointers.get(pointerName(productId,null));
      const result = await processOwnTree(context, product, null, { variables:variableUses, listingDigest, sync, loader, by, dryRun, recheck: options.recheck === true, signal: options.signal, maxAgeSeconds: options.maxAgeSeconds, readConcurrency: options.readConcurrency, planBuilds }, output.scope);
      const { name: _n, family: _f, line: _l, base: _b, ...scopeReport } = result;
      report.scope = scopeReport;
      if (!dryRun && result.root !== null && result.composition !== null) {
        const pointerRow={line:null,from:observed?.target??null,to:result.root,build:null};
        try {
          const production=(await context.store.productionsOfRoot(result.root)).find(row=>row.detail.product===productId&&row.detail.build===null&&row.detail.composition===result.composition);
          if(!production)throw new Error('缺少与不分版本组成对应的成功生产动作');
          const moved=await builds.moveRoot(productId,null,observed?.target??null,result.root,production.record.digest,{by,composition:result.composition,expected_action:observed?.action??null});
          const current=!moved.moved&&moved.current?.target===result.root?await context.store.pointerMove(moved.current.action):null;
          report.pointers.push({...pointerRow,moved:moved.moved,reason:moved.moved?'已移动不分版本的当前根':moved.reason+(current?.composition===result.composition?'':'；下一步：重新同步这条产品线')});
        } catch(error) {
          report.pointers.push({...pointerRow,moved:false,reason:`移动不分版本当前根时出错：${describeError(error)}；下一步：管理员恢复指针和对应生产动作后重新同步这条产品线`});
        }
      }
    } catch(error) {
      report.scope={outcome:'failed',reason:`处理不分版本范围时出错：${describeError(error)}；下一步：管理员恢复来源或存储后重新同步这条产品线`,root:null,composition:null};
    }
  }

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
  build: BuildInfo | null,
  options: { variables:VariableUse[]; listingDigest:string; sync: string; loader: SourceLoader; by: Principal; dryRun: boolean; recheck: boolean; signal?: AbortSignal; maxAgeSeconds?: number; readConcurrency?: number; planBuilds?: readonly string[] },
  scope?: BuildInfo['sources']
): Promise<SyncBuildReport> {
  options={...options,variables:productionVariableUses(product,build===null,options.variables)};
  const productId = product.product.id;
  const base = build === null ? { name: '不分版本', family: '', line: '', base: '' } : { name: build.name, family: build.family, line: build.line, base: build.base };
  const info = build === null ? null : infoOf(build);
  const newest=await context.store.newest<ActionBody>({key:build===null?INDEX.produceScope:INDEX.produce,value:build===null?productId:buildKey(productId,build.name),kind:'action'});
  const prior=newest===null?null:KnowledgeStore.produceOf(newest);
  if(prior&&!prior.completed&&prior.detail.pack.digest===product.digest&&canonicalize(prior.detail.build)===canonicalize(info===null?null:recordedOf(info).build)&&prior.detail.listing_digest===options.listingDigest&&prior.detail.source_failures?.some(failure=>failure.code==='SOURCE_ABSENT'&&failure.status===404))
    return {...base,outcome:'failed',reason:'构建来源已确定答复 HTTP 404；构建站列表未变，保留无根失败记录，列表变化后自动重查',root:null,composition:null,reason_code:'SOURCE_ABSENT'};
  const existing = await context.store.latestProduction(productId, build?.name ?? null);
  const keyOf = (s: { producer: string; slot: string; external: string | null }): string => `${s.producer}\u0000${s.slot}\u0000${s.external ?? ''}`;
  const oldSkipped=existing?.detail.problem_chunks
    ? await readProblemRows(context,existing.detail.problem_chunks.skipped)
    : existing?.detail.lists.flatMap(list=>list.skipped_count>list.skipped.length
      ? (plannedSources(product,info,scope).find(source=>source.producer===list.producer&&source.slot===list.slot)?.list??[]).map(external=>({external}))
      : list.skipped)??[];
  const refreshSources=new Set<string>(oldSkipped.map(row=>row.external));
  const planned = plannedSources(product, info, scope);
  const plannedKeys = planned.filter((s) => !s.many).map(keyOf).sort(compareText);
  const plannedLists = planned
    .filter((s) => s.many)
    .map((s) => `${s.producer}\u0000${s.slot}\u0000${sha256Hex(canonicalize(uniqueList(s.list ?? []).ids))}`)
    .sort(compareText);
  const cap = context.limits.maxBuildBytes;
  const concurrency = options.readConcurrency ?? context.limits.listReadConcurrency;
  // Why the newest production no longer stands for this build, or null when it still does (checked cheapest first).
  let changed: string | null = null;
  if (existing !== null) {
    const recorded = existing.detail.placement;
    if (existing.detail.pack.digest !== product.digest) changed = '生产器变了';
    else if (existing.record.body.component !== COMPONENTS.produce) changed = `Hub 的生产组件变了（${existing.record.body.component} → ${COMPONENTS.produce}）`;
    // The listing changed (released since, other line or platform, other sources): the composition records the build as listed.
    else if (
      canonicalize(existing.detail.build === null ? null : withoutLists(existing.detail.build)) !== canonicalize(info === null ? null : withoutLists(info)) ||
      canonicalize(existing.detail.build === null ? [] : listRoles(existing.detail.build)) !== canonicalize(info === null ? [] : listRoles(info))
    ) changed = '构建信息变了';
    else if (canonicalize(existing.detail.build) !== canonicalize(info === null ? null : recordedOf(info).build)) changed = '来源列表变了';
    else if (recorded !== null && recorded.spans > 0) {
      // Spans placed by the typed-judgment model depend on the model and the chain's calibration; a judge failure is retried.
      const model = context.placer.model;
      const threshold = model === null ? null : await context.calibration.threshold(PLACEMENT_CHAIN, model);
      if (recorded.failed > 0) changed = `上次有 ${recorded.failed} 个片段的归位判断失败`;
      else if (recorded.model !== model || recorded.threshold !== threshold) changed = '归位的模型或本链的校准变了';
    }
    if(changed===null){
      const composition=existing.detail.composition ? await context.store.composition(existing.detail.composition) : null;
      if(!sameVariableUses(composition?.variables??[],options.variables)){
        const before=new Map((composition?.variables??[]).map(v=>[v.name,v.decision]));
        const notes:string[]=[];
        for(const use of options.variables){
          if(before.get(use.name)===use.decision)continue;
          const history=await context.records.variables?.history(options.by,'var',use.name)??[];
          const from=history.find(v=>v.decision.digest===before.get(use.name))?.version;
          const to=history.find(v=>v.decision.digest===use.decision)?.version;
          notes.push(`变量 ${use.name} 从第 ${from??'未记录'} 版变为第 ${to??'未记录'} 版`);
        }
        changed=[...new Set(notes)].join('；')||'变量引用变了';
      }
    }
    if (changed === null) {
      // The same external sources as then (read, or optional and missing), and the same lists.
      const recordedKeys = [...existing.detail.sources, ...existing.detail.missing].map(keyOf).sort(compareText);
      if (recordedKeys.length !== plannedKeys.length || recordedKeys.some((key, i) => key !== plannedKeys[i])) changed = '来源变了';
      const recordedLists = existing.detail.lists.map((l) => `${l.producer}\u0000${l.slot}\u0000${l.externals}`).sort(compareText);
      if (changed === null && (recordedLists.length !== plannedLists.length || recordedLists.some((key, i) => key !== plannedLists[i]))) changed = '来源列表变了';
    }
    if (changed === null) {
      // An optional source that was missing is read again every time (one read per sync for a source builds share).
      for (const source of existing.detail.missing) {
        const observed=source.observation as {code?:string;status?:number}|undefined;
        if(observed?.code==='SOURCE_ABSENT'&&observed.status===404&&existing.detail.listing_digest===options.listingDigest)continue;
        if (source.external !== null && (await options.loader.read(source.external)).ok) {
          changed = `可选来源 ${source.external} 现在能读到了`;
          break;
        }
      }
    }
    if (changed === null) {
      // A listed source that could not be loaded is tried again (the first 50 kept per list): produced again once it loads.
      // Each load is reduced to whether it worked as soon as it is done, so no document is held after it.
      const retry = new ListLoader(context, options.loader, { maxAgeSeconds: 0, concurrency, record: !options.dryRun });
      const ids=[...refreshSources];
      const loaded = await mapLimited(ids, concurrency, async (id) => (await retry.load(id, cap)).ok);
      const now = ids.find((_, i) => loaded[i]);
      if (now !== undefined) changed = `列表里跳过的来源 ${now} 现在能用了`;
      else if(ids.length>0)changed=`上次跳过 ${ids.length} 份来源，本次全部重试`;
    }
    if (changed === null && !options.recheck) {
      return { ...base, outcome: 'skipped', reason: ['已有根，来源和生产器都没有变',emptyScopeNote((await context.store.composition(existing.detail.composition!))?.empty_scope)].filter(Boolean).join('；'), root: existing.detail.root, composition: existing.detail.composition };
    }
    if (changed === null) {
      let unchanged = true;
      for (const source of existing.detail.sources) {
        const load = await options.loader.read(source.external);
        if (!load.ok || load.artifact.body.sha256 !== source.sha256) unchanged = false;
      }
      // Every listed source is read again through the port. The [id, digest] pairs of what reads now must be those of what
      // was read then (every object read, used or skipped); only the digests are kept, never the documents.
      if (unchanged && existing.detail.lists.length > 0) {
        const again = new ListLoader(context, options.loader, { maxAgeSeconds: 0, concurrency, record: !options.dryRun });
        for (const list of existing.detail.lists) {
          const source = planned.find((s) => s.many && s.producer === list.producer && s.slot === list.slot);
          const ids = uniqueList(source?.list ?? []).ids;
          if (list.read !== undefined) {
            const digests = await mapLimited(ids, concurrency, async (id) => {
              const peek = await again.peek(id);
              return peek.ok ? peek.load.artifact.body.sha256 : null;
            });
            const pairs = ids.flatMap((id, i) => (digests[i] === null ? [] : [[id, digests[i]]]));
            if (sha256Hex(canonicalize(pairs)) !== list.read) unchanged = false;
            continue;
          }
          // A production of an earlier version recorded the pairs used only.
          const digests = await mapLimited(ids, concurrency, async (id) => {
            const load = await again.load(id, cap);
            return load.ok ? load.value.sha256 : null;
          });
          const failedThen = new Set(list.skipped.filter((s) => !s.retry).map((s) => s.external));
          const pairs = ids.flatMap((id, i) => (digests[i] !== null && !failedThen.has(id) ? [[id, digests[i]]] : []));
          if (sha256Hex(canonicalize(pairs)) !== list.loaded) unchanged = false;
        }
      }
      if (unchanged) return { ...base, outcome: 'skipped', reason: ['已有根，重读后来源摘要没有变',emptyScopeNote((await context.store.composition(existing.detail.composition!))?.empty_scope)].filter(Boolean).join('；'), root: existing.detail.root, composition: existing.detail.composition };
      changed = '来源变了';
    }
  }
  if (options.dryRun) {
    const why = existing === null ? '试运行：会产出根' : `试运行：${changed ?? '来源变了'}，会重新产出根`;
    return { ...base, outcome: 'skipped', reason: why, root: existing?.detail.root ?? null, composition: existing?.detail.composition ?? null, would_produce: true };
  }
  const produced = await produceTree(context, {
    product,
    build: info === null ? null : { ...info, root: existing?.detail.root ?? null },
    scope,
    by: options.by,
    sync: options.sync,
    listingDigest:options.listingDigest,
    retrySkipped:true,
    refreshSources,
    variables: options.variables,
    ...(options.planBuilds === undefined ? {} : { planBuilds: options.planBuilds }),
    loader: options.loader,
    signal: options.signal,
    ...(options.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: options.maxAgeSeconds }),
    ...(options.readConcurrency === undefined ? {} : { readConcurrency: options.readConcurrency }),
  });
  if (!produced.ok) return { ...base, outcome: 'failed', reason: produced.reason ?? '生产失败', ...(produced.sourceFailures?.some(source=>source.code==='SOURCE_ABSENT')?{reason_code:'SOURCE_ABSENT' as const}:{}), root: null, composition: null, refused: produced.refusedCount };
  const note = produced.refusedCount > 0 ? `；${produced.refusedCount} 个条目没有通过核对` : '';
  const skipped = produced.skippedCount > 0 ? `；跳过 ${produced.skippedCount} 份列出的来源（见组成记录）` : '';
  const calls = produced.calls.reused > 0 ? `；生产器调用 ${produced.calls.made} 次，复用 ${produced.calls.reused} 次` : '';
  const placementSkippedEntries = Object.entries(produced.placementSkipped ?? {}).filter(([, count]) => count > 0);
  const unplacedNote = produced.entryCounts.unplaced > 0 ? `；${labelOf('knowledge_count', 'tree_unplaced_entries')} ${produced.entryCounts.unplaced} 个，留在根下` : '';
  const same = existing !== null && existing.detail.root === produced.root ? '（内容与上次相同）' : '';
  const cause = existing === null ? '' : `；重新产出：${changed ?? '来源变了'}`;
  return {
    ...base,
    outcome: 'produced',
    reason: `产出根，${produced.nodes} 个节点（新写 ${produced.created} 个）、条目共 ${produced.entryCounts.total} 个（按内容去重；已挂到树上位置 ${produced.entryCounts.placed} 个）；树上挂载 ${produced.entries} 处（按路径与内容）${same}${note}${skipped}${calls}${unplacedNote}${cause}${produced.reason?'；'+produced.reason:''}`,
    root: produced.root,
    composition: produced.composition,
    refused: produced.refusedCount,
    entry_counts: produced.entryCounts,
    unplaced: produced.unplaced,
    skipped: produced.skippedCount,
    calls: produced.calls,
    ...(placementSkippedEntries.length > 0 ? { placement_skipped: Object.fromEntries(placementSkippedEntries) } : {}),
  };
}

type PlanRun = { ok: true; value: PlanAnswer } | { ok: false; reason: string };

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
    if (error instanceof SandboxError) {
      // A thrown structured error carries its own message (code and next action included): that is the report.
      const described = typeof error.detail.message === 'string' && error.detail.message.length > 0 ? error.detail.message : SANDBOX_ERRORS[error.code];
      return { ok: false, reason: `计划函数第 ${input.round} 轮运行失败：${described}` };
    }
    return { ok: false, reason: `计划函数第 ${input.round} 轮运行失败：${describeError(error)}` };
  }
  const issueText = (error: z.ZodError): string => {
    const issue = error.issues[0];
    return issue === undefined ? '' : cutText(`${issue.path.join('/')} ${issue.message}`, 300);
  };
  const parsed = PlanEnvelope.safeParse(output);
  if (!parsed.success) return { ok: false, reason: `计划函数第 ${input.round} 轮的输出不符合 sync-plan-output@1：${issueText(parsed.error)}` };
  const builds: BuildInfo[] = [];
  const invalid: PlanAnswer['invalid'] = [];
  parsed.data.builds.forEach((raw, index) => {
    const build = BuildInfo.safeParse(raw);
    if (build.success) builds.push(build.data);
    else invalid.push({ index, raw, reason: `计划给出的第 ${index + 1} 个构建不符合 build-info@1：${issueText(build.error)}` });
  });
  return { ok: true, value: { failed_builds: parsed.data.failed_builds, ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }), fetch: parsed.data.fetch, builds, invalid, done: parsed.data.done, ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }) } };
}

/** The parse action of one plan round: the pages read so far as inputs, what the plan answered. */
async function writePlanAction(
  context: KnowledgeContext,
  input: { sync: string; product: string; round: number; fresh: number; pages: string[]; output: PlanAnswer | null; reason: string | null; startedAt: string; read: Record<string, SyncRead>; variables:VariableUse[] },
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
      variables:input.variables,
      sync: input.sync,
      product: input.product,
      round: input.round,
      pages: input.pages.length,
      read_this_round: input.fresh,
      failed_pages: Object.values(input.read).filter((r) => !r.ok).length,
      fetch: input.output?.fetch.length ?? null,
      builds: input.output?.builds.length ?? null,
      invalid_builds: input.output?.invalid.length ?? null,
      failed_builds: input.output?.failed_builds?.length ?? 0,
      done: input.output?.done ?? null,
      // What the pack function wrote is made storable (a lone surrogate would fail the whole sync).
      note: input.output?.note === undefined ? null : cutText(input.output.note, 1000),
      reason: input.reason === null ? null : cutText(input.reason, 2000),
    },
  };
  const record = await context.store.putAction(body, [{ key: INDEX.sync, value: input.sync }]);
  return record.digest;
}
