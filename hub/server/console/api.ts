import {deletionCheck} from '../member-deletion.ts';
import {RecordsError} from '../../records/api.ts';
// /console/api: the read-only JSON interface of the console (the reserved interfaces of the doc “circle-hub 控制台前端：
// 模块与接口”, owner's choice of 2026-11-01 to build the read part first). Same session and same visibility as the pages,
// built from the same helpers, so a page and its interface never disagree: GET only; absent and forbidden alike answer 404
// with SOURCE_UNAVAILABLE (D05 R[3]); every value is its code plus its interface term (display rule 20); token values and
// credential contents never appear. The write interfaces, which run the same commands as the forms, are console/api-write.ts.
// An error is {code, message, fix}; a situation without a registered code (not signed in, a bad parameter) has code null.
import {tokensForMembers} from './member-reads.ts';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { AccountStatusSchema,ACTION_RESULT, TASK_RESULT, isEnvironment, isNodeLevel, isTaskResult, uiLabelOf, type TaskResult } from '../../../contracts/generated/vocabulary.ts';
import { partitionCountsOf } from '../../../contracts/src/validation.ts';
import type { CallLogLine, User, TokenInfo } from '../../records/api.ts';
import type { CommandRun } from '../command-bridge.ts';
import { nodeCitations } from './citations.ts';
import { circlesOf, environmentState } from './connections.ts';
import type { JobStore } from './manage.ts';
import { PERIODS, RECENT_LIMIT, blockers, checkCounts, runsSince, startOfDay } from './overview.ts';
import { PACK_ID, byId, shownVersion, stateOf } from './packs.ts';
import { NEUTRAL, readableLines, rootReadable, type PageContext } from './pages.ts';
import { searchHub } from './search.ts';
import { authorityFingerprint, certificateFacts, secretsOf, storageFacts } from './settings.ts';
import { pendingCount, primaryResult, taskResultOf } from './status.ts';
import { TOOL_LABELS, loadTasks, packTitles, taskSteps, taskTitle } from './tasks.ts';
import { readsJson, systemReads } from './trial.ts';

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface ApiOptions {
  jobs: JobStore;
  run: ((argv: string[]) => Promise<CommandRun>) | null;
}

const DAY = 86_400_000;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^run_[0-9a-z]{26}$/;
const USER_ID = /^usr_[0-9a-z]{26}$/;

export const neutral = (): ApiResult => ({ status: 404, body: { code: 'SOURCE_UNAVAILABLE', message: NEUTRAL, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix } });
const bad = (message: string, fix: string): ApiResult => ({ status: 400, body: { code: null, message, fix } });
const ok = (body: unknown): ApiResult => ({ status: 200, body });

const param = (ctx: PageContext, name: string): string | undefined => {
  const value = ctx.url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
};

const nowOf = (ctx: PageContext): number => (ctx.deps.now?.() ?? new Date()).getTime();

async function person(ctx: PageContext, id: string | null | undefined): Promise<{ id: string; name: string } | null> {
  return id === null || id === undefined ? null : { id, name: await ctx.userName(id) };
}

function dayKey(time: number): string {
  const d = new Date(time);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// ---------------------------------------------------------------- account and overview

async function me(ctx: PageContext): Promise<ApiResult> {
  const tokens = await ctx.deps.records.principals.tokens(ctx.principal.id);
  return ok({
    id: ctx.principal.id,
    name: ctx.principal.name,
    role: ctx.principal.role,
    role_label: uiLabelOf('permission_role', ctx.principal.role),
    admin: ctx.admin,
    csrf: ctx.csrf ?? null,
    circles: tokens.filter((token) => token.revoked_at === null).length,
  });
}

async function overview(ctx: PageContext): Promise<ApiResult> {
  const raw = param(ctx, 'days') ?? '7';
  const days = Number(raw);
  if (!(PERIODS as readonly number[]).includes(days)) return bad('days 只能是 7、14 或 30', '改用 days=7、days=14 或 days=30');
  const now = nowOf(ctx);
  const since = startOfDay(now - (days - 1) * DAY);
  const { runs, more } = await runsSince(ctx, since, RECENT_LIMIT);
  const tasks = await loadTasks(ctx, runs);
  const today = startOfDay(now);
  const settled = tasks.filter((task) => task.result !== null && task.result !== 'awaiting');
  const requests = (await ctx.deps.runs.listRequests?.(ctx.principal) ?? []).filter((r) => r.answered_by === null);
  const daily = Array.from({ length: days }, (_, i) => {
    const start = startOfDay(now - (days - 1 - i) * DAY);
    const end = i + 1 < days ? startOfDay(now - (days - 2 - i) * DAY) : Infinity;
    const inDay = tasks.filter((task) => { const t = Date.parse(task.run.started_at); return t >= start && t < end; });
    return { day: dayKey(start), results: Object.fromEntries(TASK_RESULT.map((result) => [result, inDay.filter((task) => task.result === result).length])) };
  });
  return ok({
    days,
    since: new Date(since).toISOString(),
    at: new Date(now).toISOString(),
    scope: { tasks: tasks.length, limit: RECENT_LIMIT, more },
    kpis: {
      today: tasks.filter((task) => Date.parse(task.run.started_at) >= today).length,
      settled: settled.length,
      passed: settled.filter((task) => task.result === 'passed').length,
      pending: tasks.reduce((n, task) => n + task.pending, 0),
      requests: requests.length,
    },
    results: TASK_RESULT.map((result) => ({ result, label: uiLabelOf('task_result', result) })),
    daily,
    checks: checkCounts(tasks).map((c) => ({ key: c.stroke.replace('stroke-', ''), label: c.label, value: c.value })),
    blockers: blockers(tasks),
  });
}

// ---------------------------------------------------------------- tasks

async function tasks(ctx: PageContext): Promise<ApiResult> {
  const wanted = param(ctx, 'result');
  if (wanted !== undefined && !isTaskResult(wanted)) return bad('result 不是任务结果的取值', `改用 ${TASK_RESULT.join('、')} 之一`);
  const listing = await ctx.deps.runs.listRuns(ctx.principal, { pack: param(ctx, 'pack'), limit: 30, cursor: param(ctx, 'cursor') ?? null, requests: false });
  const [rows, titles] = await Promise.all([loadTasks(ctx, listing.items), packTitles(ctx)]);
  const items = [];
  for (const row of rows) {
    if (wanted !== undefined && row.result !== wanted) continue;
    const run = row.run;
    items.push({
      run: run.run,
      title: taskTitle(run, titles),
      pack: run.pack,
      product: run.product ?? null,
      version: run.version ?? null,
      build: run.build ?? null,
      runner: await person(ctx, run.runner),
      host: run.host,
      host_label: uiLabelOf('execution_host', run.host),
      started_at: run.started_at,
      items: run.items.length,
      session: run.session ?? null,
      result: row.result,
      result_label: row.result === null ? null : uiLabelOf('task_result', row.result),
      pending: row.pending,
    });
  }
  return ok({ items, next: listing.next });
}

async function task(ctx: PageContext, runId: string): Promise<ApiResult> {
  if (!RUN_ID.test(runId)) return neutral();
  const detail = await ctx.deps.runs.getRun(ctx.principal, runId);
  if (detail === null) return neutral();
  const run = detail.run;
  let calls: readonly CallLogLine[] = [];
  try {
    calls = (await ctx.deps.records.callLog.query(ctx.principal, { runId: run.run, limit: 200, newestFirst: false })).items;
  } catch {
    calls = [];
  }
  const now = nowOf(ctx);
  const steps = await taskSteps(ctx, detail, calls, now);
  const result: TaskResult = taskResultOf(detail);
  const primary = primaryResult(detail);
  const titles = await packTitles(ctx);
  return ok({
    run: run.run,
    title: taskTitle(run, titles),
    pack: run.pack,
    pack_digest: run.pack_digest,
    product: run.product ?? null,
    version: run.version ?? null,
    build: run.build ?? null,
    root: run.root ?? null,
    runner: await person(ctx, run.runner),
    host: run.host,
    host_label: uiLabelOf('execution_host', run.host),
    started_at: run.started_at,
    items: run.items.length,
    result,
    result_label: uiLabelOf('task_result', result),
    pending: pendingCount(detail),
    record: primary?.record ?? null,
    acceptance: primary?.result.acceptance ?? null,
    partitions: primary !== null && primary.result.acceptance === 'accepted' ? partitionCountsOf(primary.result.partitions) : null,
    steps: steps.map((step) => ({
      name: step.name,
      detail: step.sub,
      kind: step.fill.replace('fill-', ''),
      state: step.dot,
      start: new Date(step.start).toISOString(),
      end: new Date(step.end).toISOString(),
      moment: step.point === true,
      open: step.open === true,
      depth: step.depth,
    })),
    requests: await Promise.all((detail.requests ?? []).map(async (request) => ({
      record: request.record,
      kind: request.kind,
      kind_label: uiLabelOf('request_kind', request.kind),
      audience: /^usr_[0-9a-z]{26}$/.test(request.audience) ? await person(ctx, request.audience) : request.audience,
      due: request.due,
      answered: request.answered_by !== null && request.superseded !== true,
      superseded: request.superseded === true,
      missing: request.missing,
      next_action: request.next_action,
    }))),
    calls: calls.map((line) => ({ at: line.at, tool: line.tool, tool_label: TOOL_LABELS.get(line.tool) ?? null, call_result: line.call_result, acceptance: line.acceptance, error_code: line.error_code, duration_ms: line.duration_ms })),
  });
}

// ---------------------------------------------------------------- knowledge

async function lines(ctx: PageContext): Promise<ApiResult> {
  const out = [];
  for (const line of await readableLines(ctx)) {
    const byLine = new Map<string, { builds: number; released: number; produced: number; families: Set<string> }>();
    for (const build of await ctx.deps.knowledge.builds(line.id)) {
      const entry = byLine.get(build.line) ?? { builds: 0, released: 0, produced: 0, families: new Set<string>() };
      entry.builds += 1;
      if (build.released_at !== null) entry.released += 1;
      if (build.root !== null) entry.produced += 1;
      entry.families.add(build.family);
      byLine.set(build.line, entry);
    }
    const versions = [];
    for (const [version, entry] of byLine) {
      const current = await ctx.deps.knowledge.currentRoot(line.id, version);
      versions.push({ line: version, families: [...entry.families], builds: entry.builds, released: entry.released, produced: entry.produced, current: current === null ? null : { root: current.root, build: current.build.name, produced_at: current.produced_at } });
    }
    const unversioned = await ctx.deps.knowledge.unversionedRoot?.(line.id) ?? null;
    out.push({ id: line.id, title: line.title, names: line.names, versions, unversioned: unversioned === null ? null : { root: unversioned.root, sources: unversioned.source_count } });
  }
  return ok({ lines: out });
}

async function nodes(ctx: PageContext): Promise<ApiResult> {
  const root = param(ctx, 'root') ?? '';
  if (!SHA256.test(root)) return neutral();
  const page = await ctx.deps.knowledge.getNodes({ root, paths: [param(ctx, 'path') ?? '/'], depth: 1, cursor: param(ctx, 'cursor') ?? null }, ctx.principal);
  if (page === null) return neutral();
  return ok({ root, nodes: page.nodes, next: page.next, coverage: page.coverage });
}

/**
 * One node: its position, content hash, entries with the source references each rests on, and how many accepted
 * submissions cited it or its entries in the last 30 days (console/citations.ts), with the window stated.
 */
async function node(ctx: PageContext): Promise<ApiResult> {
  const root = param(ctx, 'root') ?? '';
  const path = param(ctx, 'path') ?? '/';
  if (!SHA256.test(root)) return neutral();
  const page = await ctx.deps.knowledge.getNodes({ root, paths: [path], depth: 0 }, ctx.principal);
  const found = page?.nodes.find((candidate) => candidate.path === path);
  if (found === undefined) return neutral();
  const citations = await nodeCitations(ctx, root, found);
  return ok({
    root,
    path: found.path,
    name: found.name,
    level: found.level,
    level_label: isNodeLevel(found.level) ? uiLabelOf('node_level', found.level) : found.level,
    reference: found.reference,
    digest: found.digest,
    children: found.children,
    entries: found.entries.map((entry) => ({ ...entry, kind_label: uiLabelOf('entry_kind', entry.kind) })),
    citations,
  });
}

async function diff(ctx: PageContext): Promise<ApiResult> {
  const from = param(ctx, 'from') ?? '';
  const to = param(ctx, 'to') ?? '';
  if (!(await rootReadable(ctx, from)) || !(await rootReadable(ctx, to))) return neutral();
  const found = await ctx.deps.knowledge.diffRoots(from, to);
  return found === null ? neutral() : ok(found);
}

function imports(ctx: PageContext, options: ApiOptions, id: string | undefined): ApiResult {
  if (!ctx.admin) return neutral();
  const view = (job: ReturnType<JobStore['list']>[number], output: boolean) => ({
    id: job.id, title: job.title, command: job.argv.slice(0, 2).join(' '), arguments: job.argv.slice(2), by: job.by, started: job.started, finished: job.finished,
    exit_code: job.result?.code ?? null, ...(output && job.result !== null ? { stdout: job.result.stdout, stderr: job.result.stderr } : {}),
  });
  if (id === undefined) return ok({ imports: options.jobs.list().map((job) => view(job, false)) });
  const job = options.jobs.get(id);
  return job === undefined ? neutral() : ok(view(job, true));
}

// ---------------------------------------------------------------- packs

async function packs(ctx: PageContext): Promise<ApiResult> {
  const out = [];
  for (const [id, versions] of byId(await ctx.deps.packs.list(ctx.principal))) {
    const pack = shownVersion(versions);
    out.push({
      id:pack.id,...(pack.space?{space:pack.space}:{}), title: pack.title, kind: pack.kind, kind_label: uiLabelOf('pack_kind', pack.kind), version: pack.version, state: stateOf(pack).text,
      owner: await person(ctx, pack.owner), published_at: pack.published_at, versions: versions.map((v) => ({ version: v.version, digest: v.digest, published_at: v.published_at, withdrawn: v.withdrawn })),
      ...(pack.assigned_to === undefined ? {} : { assigned: await Promise.all(pack.assigned_to.map((user) => person(ctx, user))) }),
    });
  }
  return ok({ packs: out });
}

async function pack(ctx: PageContext, id: string): Promise<ApiResult> {
  if (!PACK_ID.test(id)) return neutral();
  const versions = byId(await ctx.deps.packs.list(ctx.principal)).get(ctx.url.searchParams.has('space')&&ctx.url.searchParams.get('space')!=='team'?ctx.url.searchParams.get('space')+'/'+id:id);
  if (versions === undefined) return neutral();
  const shown = shownVersion(versions);
  let workflow = null;
  if (shown.kind === 'workflow') {
    const loaded = await ctx.deps.workflows.byDigest(shown.digest,shown.space).catch(() => null);
    if (loaded !== null) workflow = {
      inputs: loaded.workflow.inputs.map((input) => ({ slot: input.slot, role: input.role, description: input.description, required: input.required })),
      requirements: loaded.requirements.map((r) => ({ key: r.key, name: r.name, description: r.description, layers: r.layers.map((layer) => ({ layer, label: uiLabelOf('layer', layer) })), done_rule: r.done_rule, accepted_producer: r.accepted_producer, required: r.required, checks: r.checks })),
      checks: loaded.checks.map((c) => ({ id: c.id, title: c.title ?? null, tier: c.tier ?? null, tier_label: c.tier === undefined ? null : uiLabelOf('check_tier', c.tier), runs: c.function ?? c.interpreter ?? null, judges: c.judges })),
    };
  }
  return ok({
    id,...(shown.space?{space:shown.space}:{}), title: shown.title, kind: shown.kind, kind_label: uiLabelOf('pack_kind', shown.kind), state: stateOf(shown).text, owner: await person(ctx, shown.owner),
    versions: versions.map((v) => ({ version: v.version, digest: v.digest, published_at: v.published_at, withdrawn: v.withdrawn, active: v.active, samples: v.samples })),
    ...(shown.assigned_to === undefined ? {} : { assigned: await Promise.all(shown.assigned_to.map((user) => person(ctx, user))) }),
    workflow,
  });
}

// ---------------------------------------------------------------- connections, records, settings

async function systems(ctx: PageContext): Promise<ApiResult> {
  const resources = await ctx.deps.resources.list(ctx.principal);
  // The reads of the last day of each system, from its read manifests; null when they cannot be read now.
  const reads = await systemReads(ctx, resources.map((r) => r.id));
  return ok({
    systems: resources.map((r) => ({
      id: r.id, name: r.name, system_pack: r.system_pack, environment: r.environment, environment_label: isEnvironment(r.environment) ? uiLabelOf('environment', r.environment) : r.environment,
      enabled: r.enabled, ...(r.origins === undefined ? {} : { origins: r.origins }), ...(r.allow_plaintext === undefined ? {} : { allow_plaintext: r.allow_plaintext }),
      ...(r.binding_error === undefined ? {} : { problem: r.binding_error }),
      reads_24h: reads === null ? null : readsJson(reads.get(r.id)),
    })),
  });
}

async function systemPacks(ctx: PageContext): Promise<ApiResult> {
  if (!ctx.admin) return neutral();
  const used = new Set((await ctx.deps.resources.list(ctx.principal)).map((r) => r.system_pack));
  const ids = [...new Set((await ctx.deps.packs.list(ctx.principal)).filter((p) => p.kind === 'system' && !p.withdrawn).map((p) => p.id))];
  return ok({ system_packs: ids.map((id) => ({ id, connected: used.has(id) })) });
}

async function environments(ctx: PageContext): Promise<ApiResult> {
  if (!ctx.admin) return neutral();
  if (ctx.deps.dispatch === undefined) return ok({ wired: false, environments: [] });
  return ok({
    wired: true,
    environments: (await ctx.deps.dispatch.executors(ctx.principal)).map((view) => {
      const state = environmentState(view);
      // The derived status (its code and interface term) beside the facts it comes from (state, null when not read);
      // detail says why, line by line.
      return { ...view, state: view.state ?? null, status: state.code, status_label: state.text, status_detail: state.detail,
        calls_24h: view.calls_24h == null ? null : { ...view.calls_24h, results_label: Object.fromEntries(ACTION_RESULT.map((result) => [result, uiLabelOf('action_result', result)])) },
      };
    }),
  });
}

async function circles(ctx: PageContext): Promise<ApiResult> {
  const found = await circlesOf(ctx);
  return ok({ circles: found.map((c) => ({ token: c.token.id, owner: c.owner, label: c.token.label, created_at: c.token.created_at, last_used_at: c.token.last_used_at })) });
}

function isoOrUndefined(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

async function records(ctx: PageContext): Promise<ApiResult> {
  const from = isoOrUndefined(param(ctx, 'from'));
  const to = isoOrUndefined(param(ctx, 'to'));
  if (from === null || to === null) return bad('from 或 to 不是时间', '写成 ISO 8601 时间，例如 2026-11-01T00:00:00Z');
  const user = ctx.admin ? param(ctx, 'user') : undefined;
  let userId: string | undefined;
  if (user !== undefined) userId = /^usr_[0-9a-z]{26}$/.test(user) ? user : ((await ctx.deps.records.principals.findByName(user))?.id ?? '');
  const tool = param(ctx, 'tool');
  const run = param(ctx, 'run');
  const page = userId === '' ? { items: [], next: null } : await ctx.deps.records.callLog.query(ctx.principal, {
    ...(userId === undefined ? {} : { userId }), ...(tool === undefined ? {} : { tool }), ...(run === undefined ? {} : { runId: run }),
    ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }), limit: 100, cursor: param(ctx, 'cursor') ?? null,
  });
  const items = [];
  for (const line of page.items) {
    items.push({
      digest: line.digest, at: line.at, user: await person(ctx, line.user), tool: line.tool, tool_label: TOOL_LABELS.get(line.tool) ?? null,
      call_result: line.call_result, call_result_label: uiLabelOf('call_result', line.call_result), acceptance: line.acceptance, error_code: line.error_code,
      duration_ms: line.duration_ms, run: line.run, trace: line.trace_id, session: line.session, args_digest: line.args_digest, args_size: line.args_size,
      ...(ctx.admin ? { admin_note: line.admin_note ?? null } : {}),
    });
  }
  return ok({ records: items, next: page.next });
}

async function memberOf(ctx: PageContext, user: User,provided?:TokenInfo[]): Promise<Record<string, unknown>> {
  const tokens = provided??await ctx.deps.records.principals.tokens(user.id);
  const status=user.deleted_at?AccountStatusSchema.enum.deleted:user.disabled?AccountStatusSchema.enum.disabled:AccountStatusSchema.enum.enabled;
  const used = tokens.map((t) => t.last_used_at).filter((at): at is string => at !== null).sort();
  return {
    id: user.id, name: user.deleted_at?uiLabelOf('account_display_name','deleted_member'):user.name, deleted_at:user.deleted_at??null, status,status_label:uiLabelOf('account_status',status), role: user.role, role_label: uiLabelOf('permission_role', user.role), disabled: user.disabled, created_at: user.created_at,
    circles: tokens.filter((t) => t.revoked_at === null).length, last_active_at: used.at(-1) ?? null,
    tokens: tokens.map((t) => ({ id: t.id, label: t.label, client: t.client, created_at: t.created_at, last_used_at: t.last_used_at, revoked_at: t.revoked_at })),
  };
}

async function memberDeletion(ctx:PageContext,id:string):Promise<ApiResult>{
 if(!ctx.admin||!USER_ID.test(id)||!ctx.deps.records.memberDeletions)return neutral();
 const user=await ctx.deps.records.principals.get(id);if(!user)return neutral();
 if(user.deleted_at)return ok({status:await ctx.deps.records.memberDeletions.status(ctx.principal,id)});
 try{return ok(await deletionCheck(ctx.deps.records,ctx.principal,id));}catch(error){if(!(error instanceof RecordsError))throw error;return {status:409,body:{code:null,message:error.message}};}
}
async function members(ctx: PageContext): Promise<ApiResult> {
  if (!ctx.admin) return neutral();
  const users=await ctx.deps.records.principals.list(),tokens=await tokensForMembers(ctx.deps.records.principals,users.map(user=>user.id));
  return ok({ members: await Promise.all(users.map(user=>memberOf(ctx,user,tokens.get(user.id)??[]))) });
}

/**
 * One member with the invitations issued for them (never a code) and whether each was used and by which client, so the
 * page that added a member can wait for the connection to complete.
 */
async function member(ctx: PageContext, id: string): Promise<ApiResult> {
  if (!ctx.admin || !USER_ID.test(id)) return neutral();
  const user = await ctx.deps.records.principals.get(id);
  if (user === null) return neutral();
  const now = nowOf(ctx);
  const invitations = (await ctx.deps.records.principals.invitations(user.id)).map((i) => ({
    id: i.id, created_at: i.created_at, created_by: i.created_by, expires_at: i.expires_at, used_at: i.used_at, used_by_client: i.used_by_client,
    open: i.used_at === null && Date.parse(i.expires_at) > now,
  }));
  return ok({ ...(await memberOf(ctx, user)), invitations });
}

async function secrets(ctx: PageContext, options: ApiOptions): Promise<ApiResult> {
  if (!ctx.admin) return neutral();
  const found = await secretsOf(ctx, options.run);
  if (found.rows !== null) return ok({ secrets: found.rows.map((row) => ({ name: row.name, used_by: row.consumers, by: row.by, at: row.at, withdrawn: row.withdrawn })) });
  return ok({ secrets: null, listing: found.text === null ? null : { exit_code: found.text.code, lines: found.text.stdout } });
}

async function hub(ctx: PageContext): Promise<ApiResult> {
  const now = nowOf(ctx);
  const facts = ctx.hub;
  const cert = certificateFacts(facts?.certificate ?? null, now);
  return ok({
    release: facts?.release ?? null,
    started_at: facts === undefined ? null : facts.startedAt.toISOString(),
    uptime_ms: facts === undefined ? null : now - facts.startedAt.getTime(),
    https: cert === null ? { enabled: false } : { enabled: true, fingerprint: cert.fingerprint, authority_fingerprint: await authorityFingerprint(ctx.deps.config.dataDir), valid_to: cert.validTo, days_left: cert.daysLeft },
    // null when it cannot be read (unknown, not none)
    ...(await storageFacts(ctx)),
  });
}

/** One GET under /console/api/; `rest` is the path after it. */
export async function handleApi(ctx: PageContext, rest: readonly string[], options: ApiOptions): Promise<ApiResult> {
  const [head, second, third] = rest;
  if (rest.length === 1) {
    switch (head) {
      case 'me': return me(ctx);
      case 'overview': return overview(ctx);
      case 'tasks': return tasks(ctx);
      case 'packs': return packs(ctx);
      case 'systems': return systems(ctx);
      case 'system-packs': return systemPacks(ctx);
      case 'environments': return environments(ctx);
      case 'circles': return circles(ctx);
      case 'records': return records(ctx);
      case 'members': return members(ctx);
      case 'secrets': return secrets(ctx, options);
      case 'hub': return hub(ctx);
      case 'search': return ok(await searchHub(ctx, param(ctx, 'q') ?? ''));
      default: return neutral();
    }
  }
  if (rest.length === 2 && head === 'tasks') return task(ctx, second);
  if (rest.length === 2 && head === 'packs') return pack(ctx, second);
  if(rest.length===3&&head==='members'&&third==='deletion')return memberDeletion(ctx,second);
  if (rest.length === 2 && head === 'members') return member(ctx, second);
  if (head === 'knowledge') {
    if (rest.length === 2 && second === 'lines') return lines(ctx);
    if (rest.length === 2 && second === 'nodes') return nodes(ctx);
    if (rest.length === 2 && second === 'node') return node(ctx);
    if (rest.length === 2 && second === 'diff') return diff(ctx);
    if (second === 'imports' && rest.length <= 3) return imports(ctx, options, third);
  }
  return neutral();
}
