// Decision 179 (model 83: W06 R[6] exception and R[7], B03 R[0], W08): the contract shapes of an input bound after the start.
// from_runs.after_start is for one expected source and needs the workflow's refresh function, whose reads name frozen slots
// only; the run summary freezes the slot and the run (late_inputs), never a result; the run context, the subject item, the
// refresh input and output, the lock and the late export carry the shapes both sides of the protocol use.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ItemRefreshInput, ItemRefreshOutput, ItemRefreshRef, RunContext, SubjectItem, WorkflowFile, WorkflowInput, schemas } from './pack.ts';
import { RunLateExport, RunRecord } from './run.ts';
import { runRecord } from './fixtures.ts';
import { LateInputRow, LateLocks, Locks } from './validation.ts';
import { SCHEMA_REGISTRY } from './index.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const D = (c: string) => c.repeat(64);
const stage = { slot: 'stage', role: 'expected', description: '前序阶段的运行', accepts: ['application/json'], required: true, many: false, from_runs: { pack: 'synthetic-stage', after_start: true } } as const;
const workflow = (edit: (w: Record<string, any>) => void = () => {}) => {
  const w: Record<string, any> = {
    schema: 'workflow@1',
    inputs: [{ slot: 'cases', role: 'subject', description: '合成用例', accepts: ['application/json'], required: true, many: false }, { ...stage }],
    parameters: [], product: { catalogs: [] }, subject: 'cases', projection: { module: 'functions/project.ts' },
    refresh: { module: 'functions/refresh.ts', reads: ['cases'] },
  };
  edit(w);
  return w;
};
const messages = (result: { success: boolean; error?: { issues: Array<{ message: string; path: PropertyKey[] }> } }) => (result.success ? [] : result.error!.issues.map((issue) => `${issue.path.join('/')}: ${issue.message}`));

test('an input bound after the start is one expected source', () => {
  assert.ok(WorkflowInput.safeParse(stage).success);
  assert.match(messages(WorkflowInput.safeParse({ ...stage, role: 'artifact_under_verification' })).join('\n'), /role expected/);
  assert.match(messages(WorkflowInput.safeParse({ ...stage, many: true })).join('\n'), /many false/);
  assert.ok(WorkflowInput.safeParse({ ...stage, from_runs: { pack: 'synthetic-stage', after_start: false }, role: 'artifact_under_verification' }).success, 'without after_start the old rules hold');
  assert.equal(WorkflowInput.safeParse({ ...stage, from_runs: { pack: 'synthetic-stage', after_start: true, extra: 1 } }).success, false);
});

test('a workflow that binds after the start declares refresh, and refresh reads frozen slots only', () => {
  assert.ok(WorkflowFile.safeParse(workflow()).success, messages(WorkflowFile.safeParse(workflow())).join('\n'));
  assert.match(messages(WorkflowFile.safeParse(workflow((w) => { delete w.refresh; }))).join('\n'), /declares refresh/);
  assert.match(messages(WorkflowFile.safeParse(workflow((w) => { w.inputs = [w.inputs[0]]; }))).join('\n'), /refresh needs an input bound after the start/);
  assert.match(messages(WorkflowFile.safeParse(workflow((w) => { w.refresh.reads = ['nowhere']; }))).join('\n'), /unknown slot nowhere/);
  assert.match(messages(WorkflowFile.safeParse(workflow((w) => { w.refresh.reads = ['stage']; }))).join('\n'), /reaches refresh in late/);
  assert.match(messages(WorkflowFile.safeParse(workflow((w) => { w.refresh.reads = ['cases', 'cases']; }))).join('\n'), /twice/);
  assert.match(messages(WorkflowFile.safeParse(workflow((w) => { w.subject = 'stage'; }))).join('\n'), /subject slot is frozen/);
  assert.equal(ItemRefreshRef.safeParse({ module: 'functions/refresh.ts', reads: [], extra: true }).success, false, 'the reference is strict');
  assert.equal(ItemRefreshRef.safeParse({ module: 'functions/refresh.ts', reads: Array.from({ length: 17 }, (_, i) => 'slot_' + i) }).success, false);
  assert.ok(ItemRefreshRef.safeParse({ module: 'functions/refresh.ts', export: 'refresh', reads: [] }).success);
});

test('a resolved late input names a complete result record or the missing fact, never both', () => {
  assert.ok(LateInputRow.safeParse({ slot: 'stage', run: RUN }).success, 'the projection context names slot and run only');
  assert.ok(LateInputRow.safeParse({ slot: 'stage', run: RUN, reference: 'rec:' + D('b') }).success);
  assert.ok(LateInputRow.safeParse({ slot: 'stage', run: RUN, missing: '运行还没有已受理提交' }).success);
  assert.equal(LateInputRow.safeParse({ slot: 'stage', run: RUN, reference: 'rec:' + D('b'), missing: '两者都写' }).success, false);
  assert.equal(LateInputRow.safeParse({ slot: 'stage', run: RUN, reference: 'rec:' + D('b') + '#/partitions' }).success, false, 'a fragment is not a validation record');
  assert.equal(LateInputRow.safeParse({ slot: 'stage', run: RUN, reference: 'src:' + D('b') }).success, false);
  assert.ok(LateLocks.safeParse({ inputs: [{ slot: 'stage', run: RUN, reference: 'rec:' + D('b') }], refresh: D('c') }).success);
  assert.ok(LateLocks.safeParse({ inputs: [{ slot: 'stage', run: RUN, missing: '缺' }], refresh: null }).success);
  assert.equal(LateLocks.safeParse({ inputs: [], refresh: null }).success, false);
  assert.ok(Locks.safeParse({ pack: 'synthetic@1.0.0', pack_digest: D('a'), late: { inputs: [{ slot: 'stage', run: RUN }], refresh: null } }).success);
});

test('the run freezes the slot and the run, the context and the subject item carry the late parts, refresh has its shapes', () => {
  // RunRecord carries RunSummary's late_inputs.
  assert.ok(RunRecord.safeParse(runRecord).success);
  assert.ok(RunRecord.safeParse({ ...runRecord, late_inputs: [{ slot: 'stage', run: RUN }] }).success, messages(RunRecord.safeParse({ ...runRecord, late_inputs: [{ slot: 'stage', run: RUN }] })).join('\n'));
  assert.ok(RunRecord.safeParse({ ...runRecord, late_inputs: [{ slot: 'stage', run: RUN, defaulted: true }] }).success);
  assert.equal(RunRecord.safeParse({ ...runRecord, late_inputs: [] }).success, false);
  assert.equal(RunRecord.safeParse({ ...runRecord, late_inputs: [{ slot: 'stage', run: RUN }, { slot: 'stage', run: RUN }] }).success, false);
  assert.equal(RunRecord.safeParse({ ...runRecord, late_inputs: [{ slot: 'stage', run: RUN, reference: 'rec:' + D('b') }] }).success, false, 'no result reference is frozen');
  const context = { product: null, names: [], line: null, build: null, root: null, parameters: {}, groups: [], late_inputs: [{ slot: 'stage', run: RUN, reference: 'rec:' + D('b') }] };
  assert.ok(RunContext.safeParse(context).success);
  const item = { id: 'case-c1', label: '合成用例一', location: 'src:' + D('a'), fields: {} };
  assert.ok(SubjectItem.safeParse({ ...item, late: { stage: { status: 'satisfied' } } }).success);
  assert.ok(SubjectItem.safeParse(item).success, 'absent when the workflow declares no refresh');
  const bound = { slot: 'stage', external: null, sha256: D('d'), media_type: 'application/json', parser: 'json@1', model: {}, meta: { record: D('b') } };
  assert.ok(ItemRefreshInput.safeParse({ items: [item], inputs: [], late: [{ slot: 'stage', run: RUN, input: bound }, { slot: 'other', run: RUN, input: null, missing: '还没有已受理提交' }], parameters: {}, context }).success);
  assert.ok(ItemRefreshOutput.safeParse({ items: [{ id: 'case-c1', late: { waiting: true } }] }).success);
  assert.equal(ItemRefreshOutput.safeParse({ items: [{ id: 'case-c1' }] }).success, false);
  assert.equal(ItemRefreshOutput.safeParse({ items: [], extra: 1 }).success, false);
  assert.equal(schemas['item-refresh-input@1'], ItemRefreshInput);
  assert.equal(SCHEMA_REGISTRY['item-refresh-output@1'], ItemRefreshOutput);
  assert.ok(RunLateExport.safeParse({ schema: 'run-late@1', run: RUN, run_reference: 'rec:' + D('a'), resolved_at: '2026-11-17T08:00:00.000Z', late: { inputs: [{ slot: 'stage', run: RUN, missing: '还没有已受理提交' }], refresh: null }, items: [] }).success);
});
