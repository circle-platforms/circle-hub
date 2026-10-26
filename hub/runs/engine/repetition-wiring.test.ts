// V07 wiring: the policy a pack declares, the one the run freezes, and the two summaries that must agree. Synthetic only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchCountOf, repetitionSummary } from './repetition.ts';
import { requirementSummary } from './start.ts';
import { parseDeclarations } from '../packs/load.ts';
import { packSummary } from '../packs/ports.ts';
import { bytesOf, editJson, withFiles, workflowPack } from '../packs/testing/builder.ts';
import type { PackVersionInfo } from '../packs/types.ts';
import type { RequirementTemplate } from '../../../contracts/src/pack.ts';
import { RequirementSummary } from '../../../contracts/src/run.ts';
import { terminalLabel } from '../../server/claims.ts';

const dynamic: RequirementTemplate = { key: 'bed_run', name: '合成台架运行', description: '合成', target: 'item', required: true, done_rule: 'bookkeeping', layers: ['dynamic'], accepted_producer: 'fact', checks: [], error_handling: [], observation: 'dispatch@1' };
/** The shape `dispatchCountOf` reads: which requirements a row releases, and the rounds it writes. */
const row = (repetition?: number): { release: { requirements: string[] }; repetition?: number } => ({
  release: { requirements: ['bed_run'] },
  ...(repetition === undefined ? {} : { repetition }),
});

test('the policy in force comes from the written fields, then the work class, then one round', () => {
  // No class and nothing written: one round, aggregation "all", and the summary says where it came from.
  assert.deepEqual(repetitionSummary({ layers: ['dynamic'] }), { count: 1, aggregation: 'all', basis: 'single_round', declared: { count: false, aggregation: false, k: false } });
  // A static-only requirement never repeats, whatever the class says.
  assert.deepEqual(repetitionSummary({ layers: ['static'], workClass: 'verification' }), { count: 1, aggregation: 'all', basis: 'single_round', declared: { count: false, aggregation: false, k: false } });
  // The class defaults of V07 R[5]: verification and reproduction three rounds over all, web first pass over two.
  assert.deepEqual(repetitionSummary({ layers: ['dynamic'], workClass: 'verification' }), { count: 3, aggregation: 'all', basis: 'work_class', declared: { count: false, aggregation: false, k: false } });
  assert.deepEqual(repetitionSummary({ layers: ['dynamic'], workClass: 'reproduction' }).count, 3);
  assert.deepEqual(repetitionSummary({ layers: ['dynamic'], workClass: 'web' }), { count: 2, aggregation: 'first_pass', basis: 'work_class', declared: { count: false, aggregation: false, k: false } });
  // What the requirement wrote beats the class, and the dispatch row's count beats both.
  assert.deepEqual(repetitionSummary({ layers: ['dynamic'], workClass: 'web', declared: { count: 5, aggregation: 'k_of_n', k: 4 } }), { count: 5, aggregation: 'k_of_n', k: 4, basis: 'explicit', declared: { count: true, aggregation: true, k: true } });
  assert.deepEqual(repetitionSummary({ layers: ['dynamic'], workClass: 'verification', declared: { count: 5, aggregation: 'all' }, dispatchCount: 2 }), { count: 2, aggregation: 'all', basis: 'explicit', declared: { count: true, aggregation: true, k: false } });
  // A dispatch row that writes no count leaves the requirement's own count in force.
  assert.deepEqual(repetitionSummary({ layers: ['dynamic'], declared: { count: 4, aggregation: 'k_of_n', k: 3 }, dispatchCount: undefined }).count, 4);
  // The round-shaping declarations travel with the policy.
  assert.deepEqual(
    repetitionSummary({ layers: ['dynamic'], declared: { count: 2, aggregation: 'all' }, fresh_context: true, baseline_first: true, window_seconds: 600 }),
    { count: 2, aggregation: 'all', basis: 'explicit', declared: { count: true, aggregation: true, k: false }, fresh_context: true, baseline_first: true, window_seconds: 600 },
  );
  // An impossible policy is refused, not rounded into something else.
  assert.throws(() => repetitionSummary({ layers: ['dynamic'], declared: { count: 3, aggregation: 'all' }, dispatchCount: 11 }), /1 到 10/);
  assert.throws(() => repetitionSummary({ layers: ['dynamic'], declared: { count: 3, aggregation: 'k_of_n' } }), /k/);
  assert.throws(() => repetitionSummary({ layers: ['static'], declared: { count: 2, aggregation: 'all' } }), /静态检查不重复/);
});

test('the rounds a dispatch row authorizes are what it writes, and the smallest row binds', () => {
  assert.equal(dispatchCountOf([row(3)], 'bed_run'), 3);
  assert.equal(dispatchCountOf([row(3), row(2)], 'bed_run'), 2);
  assert.equal(dispatchCountOf([row()], 'bed_run'), undefined, 'a row that writes no count decides nothing');
  assert.equal(dispatchCountOf([row(3)], 'other'), undefined, 'only the rows that release the requirement count');
  assert.equal(dispatchCountOf([], 'bed_run'), undefined);
});

test('the pack listing and the frozen run carry the same policy', () => {
  const pack = withFiles(
    editJson<any>(workflowPack(), 'requirements.json', (file) => {
      file.requirements[0] = { ...file.requirements[0], key: 'bed_run', layers: ['dynamic'], checks: [], observation: 'dispatch@1', repetition: { count: 4, aggregation: 'k_of_n', k: 3, fresh_context: true } };
    }),
    { 'ledger.json': { schema: 'ledger@1', shapes: [] } },
  );
  const declarations = parseDeclarations('workflow', new Map(Object.entries(pack.files).map(([path, content]) => [path, bytesOf(content)])));
  assert.equal(declarations.kind, 'workflow');
  if (declarations.kind !== 'workflow') return;
  const info = { id: 'synthetic', version: '10.6.0', kind: 'workflow', title: '合成', description: '合成' } as PackVersionInfo;
  const listed = packSummary(info, declarations, []);
  const started = declarations.requirements.requirements.map((t) => requirementSummary(t, declarations.ledger, declarations.checks.checks, 'synthetic@10.6.0', { workClass: declarations.workflow.work_class, effects: declarations.requirements.effects ?? [] }));
  // One projection, two callers: the frozen policy is the same in both. (The two summaries still differ on `observation`,
  // which the pack listing does not carry; that divergence predates V07 and is not this rule's to change.)
  assert.deepEqual(listed.requirements.map((r) => r.repetition), started.map((r) => r.repetition));
  // No dispatch row writes a count here, so the requirement's own policy is in force, with what it wrote named.
  assert.deepEqual(listed.requirements[0].repetition, { count: 4, aggregation: 'k_of_n', k: 3, basis: 'explicit', declared: { count: true, aggregation: true, k: true }, fresh_context: true });
  assert.ok(RequirementSummary.safeParse(listed.requirements[0]).success);
});

test('a work class declared by the workflow reaches both summaries as its default', () => {
  const pack = withFiles(editJson<any>(workflowPack(), 'workflow.json', (file) => { file.work_class = 'web'; }), {});
  const declarations = parseDeclarations('workflow', new Map(Object.entries(pack.files).map(([path, content]) => [path, bytesOf(content)])));
  assert.equal(declarations.kind, 'workflow');
  if (declarations.kind !== 'workflow') return;
  const info = { id: 'synthetic', version: '10.6.0', kind: 'workflow', title: '合成', description: '合成' } as PackVersionInfo;
  const listed = packSummary(info, declarations, []);
  const started = declarations.requirements.requirements.map((t) => requirementSummary(t, declarations.ledger, declarations.checks.checks, 'synthetic@10.6.0', { workClass: declarations.workflow.work_class, effects: declarations.requirements.effects ?? [] }));
  assert.deepEqual(listed.requirements, started);
  for (const [at, summary] of listed.requirements.entries()) {
    const template: RequirementTemplate = declarations.requirements.requirements[at];
    // Only a requirement with a dynamic layer takes the class default; a static one stays at a single round.
    assert.equal(summary.repetition?.basis, template.layers.includes('dynamic') ? 'work_class' : 'single_round', template.key);
    if (template.layers.includes('dynamic')) assert.deepEqual([summary.repetition?.count, summary.repetition?.aggregation], [2, 'first_pass']);
  }
});

test('the dynamic layer shows its observed distribution beside the terminal', () => {
  assert.equal(terminalLabel({ layer: 'dynamic', terminal: 'pass' }), '通过');
  assert.equal(terminalLabel({ layer: 'dynamic', terminal: 'pass', observation: '3/3 次未见失败' }), '通过（3/3 次未见失败）');
  assert.equal(terminalLabel({ layer: 'dynamic', terminal: 'fail', observation: '间歇：3 次里 1 次失败（第 2 次）' }), `失败（间歇：3 次里 1 次失败（第 2 次））`);
  assert.equal(terminalLabel({ layer: 'static', terminal: 'pass', observation: '不该出现在静态层' }), '通过', 'a static layer keeps its own label');
});
