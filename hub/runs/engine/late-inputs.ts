import type { BoundInput, LateBoundInput, RunContext, SubjectItem } from '../../../contracts/src/pack.ts';
import { ItemRefreshInput, ItemRefreshOutput } from '../../../contracts/src/pack.ts';
import { RunLateExport, type RunRecord } from '../../../contracts/src/run.ts';
import type { LateInputRow, LateLocks } from '../../../contracts/src/validation.ts';
import { canSeeRun, digestOf, recordExistence, sha256Hex, type Principal, type StoredRecord } from '../../records/api.ts';
import type { LoadedWorkflow } from '../../ports.ts';
import { parseReference, parserKey, recReference, recognizeAsync, type ReaderIdentity } from '../../refs/api.ts';
import { SandboxError, callPackFunction, type SandboxOptions } from '../../rules/api.ts';
import type { EngineContext } from './deps.ts';
import { describe } from './errors.ts';
import { packIdOf } from './lineage.ts';
import { abandonDecision } from './management.ts';
import { latestSubmittedResult } from './predecessor-defaults.ts';
import { principalOf, sourceReader } from './readers.ts';
import { keyOwner, runById, successorsOf } from './store.ts';
import { isObject } from './util.ts';
import { recordInput } from './inputs.ts';
import { recordBytes } from './exact.ts';

export interface LateEvaluation {
  inputs: LateInputRow[];
  expect?: string | null;
}

export interface LateOverlay {
  refresh: string | null;
  items: Map<string, Record<string, unknown>>;
  failure?: unknown;
}

export function lateSlotsOf(workflow: Pick<LoadedWorkflow, 'workflow'>): Set<string> {
  return new Set(workflow.workflow.inputs.filter((slot) => slot.from_runs?.after_start === true).map((slot) => slot.slot));
}

export function lateFromLocks(late: LateLocks | undefined): LateEvaluation | undefined {
  return late === undefined ? undefined : { inputs: late.inputs.map((row) => ({ ...row })), expect: late.refresh };
}

async function runnerNow(ctx: EngineContext, run: RunRecord): Promise<Principal | null> {
  const id = run.runner ?? run.configurer;
  if (id === undefined || ctx.deps.records.principals === undefined) return null;
  const user = await ctx.deps.records.principals.get(id).catch(() => null);
  if (user === null || user === undefined || user.disabled) return null;
  return { id: user.id, name: user.name, role: user.role };
}

async function waitingFact(ctx: EngineContext, bound: StoredRecord<RunRecord>): Promise<string> {
  const owner = keyOwner(bound.body);
  const successors = (await successorsOf(ctx.deps.records.store, bound.body.run)).filter((s) => packIdOf(s.body.pack) === packIdOf(bound.body.pack) && keyOwner(s.body) === owner);
  if (successors.length > 0) return `运行 ${bound.body.run} 已被 ${successors[successors.length - 1].body.run} 取代，不再受理提交`;
  if ((await abandonDecision(ctx, bound.body.run)) !== null) return `运行 ${bound.body.run} 已放弃，不再受理提交`;
  return `运行 ${bound.body.run} 还没有已受理提交`;
}

export async function resolveLateInputs(ctx: EngineContext, run: RunRecord): Promise<LateInputRow[] | null> {
  if (run.late_inputs === undefined || run.late_inputs.length === 0) return null;
  const store = ctx.deps.records.store;
  const runner = await runnerNow(ctx, run);
  const rows: LateInputRow[] = [];
  for (const row of run.late_inputs) {
    const bound = await runById(store, row.run);
    if (bound === null) { rows.push({ slot: row.slot, run: row.run, missing: `运行 ${row.run} 不存在` }); continue; }
    if (runner === null || !canSeeRun(runner, bound.body)) {
      const existence = runner === null ? 'neutral' : await recordExistence(store, runner.id, bound);
      rows.push({ slot: row.slot, run: row.run, missing: existence === 'neutral' ? `运行 ${row.run} 对运行者不可用` : `运行者没有读取运行 ${row.run} 的权限` });
      continue;
    }
    const result = await latestSubmittedResult(ctx, bound, { locked: false });
    if (result !== null) rows.push({ slot: row.slot, run: row.run, reference: recReference(result.digest) });
    else rows.push({ slot: row.slot, run: row.run, missing: await waitingFact(ctx, bound) });
  }
  return rows;
}

export async function runReaderOf(ctx: EngineContext, run: RunRecord): Promise<ReaderIdentity> {
  const id = run.runner ?? run.configurer ?? 'hub';
  const user = ctx.deps.records.principals !== undefined ? await ctx.deps.records.principals.get(id) : null;
  return { user: id, role: user?.role ?? 'user', run: run.run };
}

export async function frozenReads(ctx: EngineContext, run: RunRecord, workflow: LoadedWorkflow, reader: ReaderIdentity): Promise<BoundInput[]> {
  const reads = workflow.workflow.refresh?.reads ?? [];
  if (reads.length === 0) return [];
  const { store, artifacts } = ctx.deps.records;
  const sources = sourceReader(artifacts, 'function', run.sources);
  const out: BoundInput[] = [];
  for (const slot of reads) {
    for (const binding of run.sources.filter((source) => source.slot === slot)) {
      const ref = parseReference(binding.reference);
      let bytes: Uint8Array;
      let mediaType: string;
      let meta: Record<string, unknown> | null = null;
      if (ref.scheme === 'rec') {
        const record = await store.get(ref.record);
        const value = record === null ? null : recordBytes(record, ref.pointer);
        if (record === null || value === null) throw new Error(`frozen input ${slot}: record ${ref.record} cannot be read again`);
        bytes = value;
        mediaType = 'application/json';
        meta = { record: ref.record, kind: record.kind, schema: record.schema, created_at: record.created_at, ...(ref.pointer !== undefined ? { pointer: ref.pointer } : {}), source: sha256Hex(bytes) };
      } else if (ref.scheme === 'src') {
        const read = await sources.read(ref.sha256, reader);
        if (read === null || read.bytes === null) throw new Error(`frozen input ${slot}: source ${ref.sha256} cannot be read again`);
        bytes = read.bytes;
        mediaType = read.mediaType;
        if (binding.meta_artifact !== undefined) {
          const capture = await store.get<{ sha256?: unknown }>(binding.meta_artifact);
          const sha = capture?.kind === 'source_artifact' && typeof capture.body.sha256 === 'string' ? capture.body.sha256 : null;
          const metaSource = sha === null ? null : await artifacts.source(principalOf(reader), sha, { consumer: 'function', record: binding.meta_artifact });
          if (metaSource?.bytes) {
            try { const parsed: unknown = JSON.parse(new TextDecoder().decode(metaSource.bytes)); if (isObject(parsed)) meta = parsed; } catch { }
          }
        }
      } else throw new Error(`frozen input ${slot}: ${ref.scheme} bindings are not inputs`);
      const parsed = await recognizeAsync(ctx.parsers, bytes, mediaType);
      if (parsed === null) throw new Error(`frozen input ${slot}: no core parser reads ${mediaType}`);
      out.push({ slot, external: binding.external ?? null, sha256: sha256Hex(bytes), media_type: mediaType, parser: parserKey(parsed.parser), model: parsed.document.model, meta });
    }
  }
  return out;
}

async function lateBound(ctx: EngineContext, rows: readonly LateInputRow[]): Promise<LateBoundInput[]> {
  const out: LateBoundInput[] = [];
  for (const row of rows) {
    if (row.reference === undefined) { out.push({ slot: row.slot, run: row.run, input: null, ...(row.missing !== undefined ? { missing: row.missing } : {}) }); continue; }
    const digest = row.reference.slice('rec:'.length);
    const record = await ctx.deps.records.store.get(digest);
    const input = record === null ? null : await recordInput(ctx, row.slot, digest, record);
    if (input === null) throw new Error(`late input ${row.slot}: record ${digest} cannot be read as an input`);
    out.push({ slot: row.slot, run: row.run, input });
  }
  return out;
}

export async function refreshItems(ctx: EngineContext, run: RunRecord, workflow: LoadedWorkflow, rows: readonly LateInputRow[], options: { reader: ReaderIdentity; context: RunContext; sandbox?: SandboxOptions; traceId: string | null }): Promise<LateOverlay> {
  const fn = workflow.workflow.refresh;
  if (fn === undefined) return { refresh: null, items: new Map(), failure: new Error('the workflow declares no refresh function') };
  try {
    const items: SubjectItem[] = run.items.map((it) => ({ id: it.id, label: it.label, location: it.location, fields: it.fields }));
    const input = ItemRefreshInput.parse({ items, inputs: await frozenReads(ctx, run, workflow, options.reader), late: await lateBound(ctx, rows), parameters: run.parameters, context: options.context });
    const call = async () => (await callPackFunction({ packDir: workflow.pack.directory, module: fn.module, export: fn.export }, input, ctx.deps.sandboxLimits, options.sandbox ?? ctx.deps.sandbox)).output;
    let output: unknown;
    try {
      output = await call();
    } catch (error) {
      if (!(error instanceof SandboxError && error.code === 'SANDBOX_UNAVAILABLE')) throw error;
      ctx.log({ traceId: options.traceId, run: run.run, what: `refresh ${fn.module}`, detail: `retried once after ${describe(error)}` });
      output = await call();
    }
    const parsed = ItemRefreshOutput.safeParse(output);
    if (!parsed.success) throw new Error(`refresh output is not item-refresh-output@1: ${parsed.error.message.slice(0, 1000)}`);
    const known = new Set(run.items.map((it) => it.id));
    const overlay = new Map<string, Record<string, unknown>>();
    for (const row of parsed.data.items) {
      if (!known.has(row.id)) throw new Error(`refresh output names item ${row.id}, which is not an item of run ${run.run}`);
      if (overlay.has(row.id)) throw new Error(`refresh output names item ${row.id} twice`);
      overlay.set(row.id, row.late);
    }
    return { refresh: digestOf(parsed.data), items: overlay };
  } catch (error) {
    ctx.log({ traceId: options.traceId, run: run.run, what: `refresh ${fn.module}`, detail: describe(error) });
    return { refresh: null, items: new Map(), failure: error };
  }
}

export async function exportLateOf(ctx: EngineContext, stored: StoredRecord<RunRecord>, workflow: LoadedWorkflow | null, context: (run: RunRecord) => Promise<RunContext>): Promise<RunLateExport> {
  const run = stored.body;
  const resolvedAt = ctx.now().toISOString();
  const inputs = (await resolveLateInputs(ctx, run)) ?? [];
  const overlay = workflow === null
    ? { refresh: null, items: new Map<string, Record<string, unknown>>() }
    : await refreshItems(ctx, run, workflow, inputs, { reader: await runReaderOf(ctx, run), context: { ...(await context(run)), late_inputs: inputs }, traceId: null });
  return RunLateExport.parse({
    schema: 'run-late@1',
    run: run.run,
    run_reference: recReference(stored.digest),
    resolved_at: resolvedAt,
    late: { inputs, refresh: overlay.refresh },
    items: run.items.filter((it) => overlay.items.has(it.id)).map((it) => ({ id: it.id, late: overlay.items.get(it.id)! })),
  });
}
