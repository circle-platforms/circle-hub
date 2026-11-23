import assert from 'node:assert/strict';
import { join } from 'node:path';
import { INDEX } from '../../../../hub/runs/engine/store.ts';
import { temporaryDirectory } from '../../../../hub/runs/api.ts';
import { authorStepCoverage, fidelityBrief } from '../functions/fidelity.ts';
import { isRecord } from '../functions/text.ts';
import { recordFor } from '../recompose/tools/submit-records.ts';
import { call, type Hub } from './hub.ts';
import { stageRecompose } from './stage-recompose.ts';

export interface RecompositionResult {
  run: string;
  runRef: string;
  resultRef: string;
}

export async function ensureRecomposePublished(hub: Pick<Hub, 'registry' | 'alice' | 'admin'>): Promise<void> {
  if (await hub.registry.latestVersion('recompose')) return;
  const temp = await temporaryDirectory('recompose-pub-');
  try {
    const published = await hub.registry.publish(hub.alice, await stageRecompose('recompose', join(temp.path, 'recompose')));
    assert.equal(published.ok, true, JSON.stringify(published));
    if (published.ok) await hub.registry.assign(hub.admin, hub.alice.id, published.version.id);
  } finally {
    await temp.remove();
  }
}

export async function runSyntheticRecomposition(
  hub: Hub,
  input: { product: string; build: string; subject: { external: string } | { reference: string }; model?: string },
): Promise<RecompositionResult> {
  await ensureRecomposePublished(hub);
  const model = input.model ?? 'synthetic-model';
  const started = await hub.service.startRunDetailed(
    hub.alice,
    { pack: 'recompose', product: input.product, build: input.build, inputs: { subject: input.subject } },
    call(),
  );
  assert.equal(started.answer.call_result, 'ok', JSON.stringify(started.answer.errors));
  const run = started.answer.run!;
  const items = run.items.map((item) => {
    const atoms = Array.isArray((item.fields as Record<string, unknown>)?.atoms)
      ? ((item.fields as Record<string, unknown>).atoms as Array<{ reference?: string }>)
      : [];
    const sourceRef = atoms[0]?.reference ?? item.location;
    const data = recordFor(
      item,
      { method: { kind: 'declared', text: '按用例命令执行并核对预期结果', sources: [sourceRef], basis: '作者步骤已给出可执行动作或观察方式' } },
      model,
    );
    const quotes = (data.atoms as Array<{ quote_ref: string; text: string }>).map((a) => ({ reference: a.quote_ref, text: a.text }));
    return { item: item.id, handling: 'handled' as const, slots: { record: [{ text: '合成重组判断', quotes, data }] } };
  });
  const answer = await hub.service.submitResult(hub.alice, { run: run.run, model, items }, call());
  assert.equal(answer.acceptance, 'accepted', JSON.stringify(answer.errors));
  const rows = Object.values(answer.result!.partitions).flat();
  assert.equal(rows.length, run.items.length);
  for (const row of rows) {
    assert.ok(row.requirements.every((r) => r.status === 'satisfied'), JSON.stringify(row.requirements));
  }
  const saved = (await hub.kit.store.find({ kind: 'run', key: INDEX.runId, value: run.run })).items[0];
  const result = (await hub.kit.store.find({ kind: 'validation_result', key: INDEX.resultRun, value: run.run, newestFirst: true })).items[0];
  return { run: run.run, runRef: `rec:${saved.digest}`, resultRef: `rec:${result.digest}` };
}

export function attachRecompositionFields(item: any, receipt: string, value: unknown): void {
  if (!isRecord(value) || !isRecord(item?.fields?.recomposition?.record)) return;
  const record = item.fields.recomposition.record as Record<string, any>;
  const actionIds = Array.isArray(record.atoms)
    ? record.atoms.filter((a: any) => a?.kind === 'action' && typeof a.id === 'string').map((a: any) => a.id as string)
    : [];
  if (actionIds.length > 0) {
    if (Array.isArray(value.blocks) && value.blocks.length > 0 && !value.blocks.some((b: any) => isRecord(b) && Array.isArray(b.author_step_refs) && b.author_step_refs.length > 0)) {
      if (isRecord(value.blocks[0])) value.blocks[0].author_step_refs = actionIds;
    } else if (Array.isArray(value.steps) && value.steps.length > 0 && !value.steps.some((s: any) => isRecord(s) && Array.isArray(s.author_step_refs) && s.author_step_refs.length > 0)) {
      if (isRecord(value.steps[0])) value.steps[0].author_step_refs = actionIds;
    }
  }
  if (value.recomposition === undefined) {
    const expects = Array.isArray(value.expects) ? value.expects : [];
    const expectIds = expects.map((e: any, idx: number) => (isRecord(e) && typeof e.id === 'string' ? e.id : String(idx + 1)));
    const slots = Array.isArray(record.expectation_slots)
      ? record.expectation_slots.map((slot: any, idx: number) => ({ slot: slot.slot, assertions: expectIds[idx] ? [expectIds[idx]] : [] }))
      : [];
    value.recomposition = { receipt, case_id: record.case.id, slots, rebindings: [] };
  }
  const { fidelity: _old, ...plain } = value as Record<string, unknown>;
  const brief = fidelityBrief(item.id, record, plain);
  if (brief) {
    const carriers = authorStepCoverage(brief, plain).carriers;
    value.fidelity = {
      brief_sha256: brief.brief_sha256,
      steps: brief.author_steps.map((step) => ({
        n: step.n,
        verdict: 'preserved' as const,
        step_indices: carriers.filter((row) => row.refs.includes(step.n)).map((row) => row.index),
        rationale: '合成审计：计划实现了作者这一步',
      })),
      disclosure: '合成审计：作者步骤逐条保住。',
    };
  }
}
