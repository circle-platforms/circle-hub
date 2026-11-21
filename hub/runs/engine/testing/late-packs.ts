// Synthetic packs for inputs bound after the start (W06 R[7], decision 179): a stage workflow (toy-stage, incremental
// submissions) whose runs record each case, and a consumer workflow (toy-consume) whose stage slot binds a toy-stage run after
// the start; its refresh function reads that run's latest accepted result and tells each item whether its stage record is
// accepted and satisfied, and its check waits (unknown, awaiting_step) on an item the stage run has not accepted yet. A small
// harness over openHarness starts and submits both. Everything is invented; nothing names a real product, case or customer.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Verdict } from '../../../../contracts/generated/vocabulary.ts';
import type { RunSummary } from '../../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../../contracts/src/validation.ts';
import type { TemporaryPostgres } from '../../../testing/postgres.ts';
import { openHarness, type Harness, type HarnessOptions } from './harness.ts';
import { writePack, type PackSpec } from './packs.ts';

/** The judged document both workflows project: one item per case. */
export const CASES = { cases: [{ id: 'c1', title: '合成用例一：设置 3 区浇灌 15 分钟' }, { id: 'c2', title: '合成用例二：查看分区状态' }] };
export const ITEM = { one: 'case-c1', two: 'case-c2' } as const;
export const casesBytes = (): Uint8Array => new TextEncoder().encode(JSON.stringify(CASES));

/** One item per case of the JSON document bound to cases; the consumer also keeps what its run context said about the stage slot. */
export const PROJECT = `// Synthetic projection: one item per case of the JSON document { cases: [{ id, title }] } bound to the cases slot.
interface Case { id?: unknown; title?: unknown }
interface Bound { slot: string; model: unknown }
export default function project(input: unknown): unknown {
  const value = input as { inputs?: Bound[]; context?: { late_inputs?: unknown } };
  const doc = (value.inputs ?? []).find((row) => row.slot === 'cases')?.model as { cases?: Case[] } | undefined;
  const cases = Array.isArray(doc?.cases) ? doc.cases : [];
  if (cases.length === 0) return { error: { code: 'toy-late.no_cases', message: '文档里没有用例', fix: '给一份带 cases 数组的 JSON 文档' }, warnings: [] };
  return {
    items: cases.map((c, index) => ({
      id: 'case-' + String(c.id),
      label: String(c.title ?? ''),
      location: { parser: 'json@1', selector: 'p/cases/' + index + '/title' },
      fields: { title: String(c.title ?? ''), bound_after_start: value.context?.late_inputs ?? null, slots_seen: (value.inputs ?? []).map((row) => row.slot) },
    })),
    warnings: [],
  };
}
`;

/** The refresh function: per item, the stage record of the bound run's latest accepted result, or what it waits for. */
export const REFRESH = `// Synthetic refresh (toy-consume): the stage run's latest accepted result, bound after the start, says per item whether its
// record requirement is satisfied. An item the result does not settle waits. The frozen reads are counted to show they arrive.
interface Requirement { requirement?: string; status?: string }
interface Row { item?: string; requirements?: Requirement[] }
interface Late { slot: string; run: string; input: { model: unknown; meta: Record<string, unknown> | null } | null; missing?: string }
export default function refresh(input: unknown): unknown {
  const value = input as { items?: Array<{ id: string }>; inputs?: Array<{ slot: string }>; late?: Late[] };
  const stage = (value.late ?? []).find((row) => row.slot === 'stage');
  const envelope = stage?.input?.model as { body?: { partitions?: Record<string, Row[]> } } | undefined;
  const rows = Object.values(envelope?.body?.partitions ?? {}).flat();
  const record = typeof stage?.input?.meta?.record === 'string' ? stage.input.meta.record : null;
  const reads = (value.inputs ?? []).map((row) => row.slot);
  return {
    items: (value.items ?? []).map((item) => {
      const status = rows.find((row) => row.item === item.id)?.requirements?.find((r) => r.requirement === 'record')?.status ?? null;
      if (record !== null && (status === 'satisfied' || status === 'unsatisfied')) return { id: item.id, late: { stage: { status, record, run: stage!.run }, reads } };
      return { id: item.id, late: { waiting: { run: stage?.run ?? null, status, missing: stage?.missing ?? null }, reads } };
    }),
  };
}
`;

/** The check: satisfied stage record supports, an unsatisfied one refutes, a waiting item is unknown (awaiting_step). */
export const ALIGNED = `// Synthetic check (toy-consume, plan): the plan of a case may go on only once its stage record is accepted and satisfied.
interface Late { stage?: { status?: string; record?: string; run?: string }; waiting?: { run?: string | null; status?: string | null; missing?: string | null } }
export default function aligned(input: unknown): unknown {
  const subject = (input as { subject?: { item?: string; late?: Late } }).subject ?? {};
  const late = subject.late;
  if (late?.stage?.status === 'satisfied') return [{ verdict: 'support', statement: '前序记录已受理并满足（记录 ' + String(late.stage.record ?? '').slice(0, 12) + '）', grounds: [], tier: 'blocking', data: { record: late.stage.record ?? null } }];
  if (late?.stage !== undefined) return [{ verdict: 'refute', code: 'toy-consume.stage_unsatisfied', statement: '前序记录已受理，但它的记录要求项未满足', grounds: [], tier: 'blocking' }];
  const why = late?.waiting?.missing ?? ('运行 ' + String(late?.waiting?.run ?? '') + ' 里这一条还没有被受理');
  return [{ verdict: 'unknown', reason: 'awaiting_step', missing: '用例 ' + String(subject.item ?? '') + ' 的前序记录：' + why + '；下一步：等前序运行受理这一条后原样重交', statement: '等待前序：' + why, grounds: [], tier: 'blocking' }];
}
`;

const requirement = (key: string, name: string, checks: string[], errorHandling: unknown[]) => ({
  key, name, description: name + '（合成）', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'judgment', checks, error_handling: errorHandling,
});

/** The stage workflow: one judgment requirement per case, filled one case at a time (incremental submissions). */
export function stagePack(): PackSpec {
  return {
    id: 'toy-stage', version: '1.0.0', kind: 'workflow', title: '合成前序阶段', description: '测试用的合成前序阶段包',
    files: {
      'workflow.json': { json: {
        schema: 'workflow@1', incremental_submissions: true,
        inputs: [{ slot: 'cases', role: 'subject', description: '合成用例文档', accepts: ['application/json'], required: true, many: false }],
        parameters: [], product: { catalogs: [] }, subject: 'cases', projection: { module: 'functions/project.ts' },
      } },
      'requirements.json': { json: { schema: 'requirements@1', requirements: [requirement('record', '重组记录', [], [])] } },
      'checks.json': { json: { schema: 'checks@1', checks: [] } },
      'slots.schema.json': { json: { schema: 'slots@1', item: { record: { min: 1, max: 1 } }, run: {} } },
      'SKILL.md': '# 合成前序阶段\n\n逐条用例写重组记录，可以一条一条提交。\n',
      'functions/project.ts': PROJECT,
    },
  };
}

export interface ConsumeOptions { id?: string; version?: string; refresh?: string; from?: string; required?: boolean }

/** The consumer workflow: the stage slot binds a stage run after the start; refresh and check as above. */
export function consumePack(options: ConsumeOptions = {}): PackSpec {
  const id = options.id ?? 'toy-consume';
  const sample = (verdict: Extract<Verdict, 'support' | 'refute'>, late: unknown, extra: Record<string, unknown> = {}) => ({ json: {
    id: 'aligned_' + verdict, source: 'author', check: 'aligned', note: '合成样例（' + verdict + '）',
    subject: { item: ITEM.one, label: CASES.cases[0].title, location: 'src:' + 'a'.repeat(64), fields: { title: CASES.cases[0].title }, slots: { plan: [{ text: '合成计划' }] }, evidence: [], late },
    expect: [{ verdict, tier: 'blocking', ...extra }],
  } });
  return {
    id, version: options.version ?? '1.0.0', kind: 'workflow', title: '合成后续阶段', description: '测试用的合成后续阶段包（开运行后再绑定前序结果）',
    files: {
      'workflow.json': { json: {
        schema: 'workflow@1',
        inputs: [
          { slot: 'cases', role: 'subject', description: '合成用例文档', accepts: ['application/json'], required: true, many: false },
          { slot: 'stage', role: 'expected', description: '前序阶段的运行号；开运行只认运行，每次核对取它最近一次受理的结果', accepts: ['application/json'], required: options.required ?? true, many: false, from_runs: { pack: options.from ?? 'toy-stage', after_start: true } },
        ],
        parameters: [], product: { catalogs: [] }, subject: 'cases', projection: { module: 'functions/project.ts' },
        refresh: { module: 'functions/refresh.ts', reads: ['cases'] },
      } },
      'requirements.json': { json: { schema: 'requirements@1', requirements: [requirement('plan', '计划', ['aligned'], [{ code: id + '.stage_unsatisfied', action: 'repair', max_rounds: 2 }])] } },
      'checks.json': { json: { schema: 'checks@1', checks: [{ id: 'aligned', function: { module: 'functions/aligned.ts' }, applies: 'item', judges: 'artifact_under_verification', tier: 'blocking', basis: '要求项 plan：计划依据的前序记录已被受理并满足' }] } },
      'slots.schema.json': { json: { schema: 'slots@1', item: { plan: { min: 1, max: 1 } }, run: {} } },
      'SKILL.md': '# 合成后续阶段\n\n逐条用例写计划；前序记录还没被受理的条目先等待，受理后原样重交。\n',
      'functions/project.ts': PROJECT,
      'functions/refresh.ts': options.refresh ?? REFRESH,
      'functions/aligned.ts': id === 'toy-consume' ? ALIGNED : ALIGNED.replaceAll('toy-consume.', id + '.'),
      'samples/positive/aligned_support.json': sample('support', { stage: { status: 'satisfied', record: 'b'.repeat(64), run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa' } }),
      'samples/negative/aligned_refute.json': sample('refute', { stage: { status: 'unsatisfied', record: 'b'.repeat(64), run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa' } }, { code: id + '.stage_unsatisfied' }),
    },
  };
}

/** A stage submission recording the given items (the rest not covered yet). */
export const stageSubmission = (run: string, items: readonly string[], note = '合成重组记录') => ({
  run, model: 'synthetic-stage-model', items: items.map((item) => ({ item, handling: 'handled', slots: { record: [{ text: note + ' ' + item }] } })),
});
/** A consumer submission with a plan for both items; extra slot claim fields (grounds) go into the first item's plan. */
export const consumeSubmission = (run: string, note = '合成计划', first: Record<string, unknown> = {}) => ({
  run, model: 'synthetic-consume-model', items: [ITEM.one, ITEM.two].map((item, k) => ({ item, handling: 'handled', slots: { plan: [{ text: note + ' ' + item, ...(k === 0 ? first : {}) }] } })),
});

export interface LateWorld {
  h: Harness;
  cases: string;
  startStage(session?: string): Promise<RunSummary>;
  submitStage(run: string, items: readonly string[], note?: string): Promise<{ result: ValidationResult; record: string }>;
  startConsume(stage: unknown, options?: { pack?: string; predecessor?: string; session?: string }): Promise<Awaited<ReturnType<Harness['service']['startRun']>>>;
  submitConsume(run: string, note?: string, first?: Record<string, unknown>): Promise<Awaited<ReturnType<Harness['service']['submitResult']>>>;
  close(): Promise<void>;
}

/** The harness with the two packs (and any more consumer variants) assigned to alice and the cases document uploaded. */
export async function openLateWorld(postgres: TemporaryPostgres, variants: ConsumeOptions[] = [], options: HarnessOptions = {}): Promise<LateWorld> {
  const h = await openHarness(postgres, options);
  const dir = await mkdtemp(join(tmpdir(), 'hub-late-'));
  try {
    for (const spec of [stagePack(), consumePack(), ...variants.map((variant) => consumePack(variant))]) {
      await h.workflows.add(await writePack(dir, spec));
      h.workflows.assign(h.alice.id, spec.id);
    }
    const cases = await h.upload(h.alice, casesBytes());
    return {
      h, cases,
      async startStage(session = 'stage-session') {
        const answer = await h.service.startRun(h.alice, { pack: 'toy-stage', inputs: { cases: { reference: cases } } }, h.call(session));
        assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
        return answer.run!;
      },
      async submitStage(run, items, note) {
        const answer = await h.service.submitResult(h.alice, stageSubmission(run, items, note), h.call('stage-session'));
        assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
        const stored = (await h.service.getResult(h.alice, run))!;
        return { result: stored.result, record: stored.record };
      },
      startConsume(stage, options = {}) {
        return h.service.startRun(h.alice, { pack: options.pack ?? 'toy-consume', ...(options.predecessor ? { predecessor: options.predecessor } : {}), inputs: { cases: { reference: cases }, ...(stage === undefined ? {} : { stage }) } } as unknown as Parameters<Harness['service']['startRun']>[1], h.call(options.session ?? 'consume-session'));
      },
      submitConsume(run, note, first) {
        return h.service.submitResult(h.alice, consumeSubmission(run, note, first), h.call('consume-session'));
      },
      async close() { await h.close(); await rm(dir, { recursive: true, force: true }); },
    };
  } catch (error) {
    await h.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
