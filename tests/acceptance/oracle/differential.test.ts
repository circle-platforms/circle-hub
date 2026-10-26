// Differential test: random scenarios through the real runs engine and the reference in oracle.ts. The pack and the
// scripted checks exist only to drive the engine; the expectations come from the reference.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { ProtocolCode } from '../../../contracts/generated/protocol.ts';
import type { CheckTier, Layer } from '../../../contracts/generated/vocabulary.ts';
import type { ChecksFile, RequirementsFile, SlotsFile, WorkflowFile } from '../../../contracts/src/pack.ts';
import type { ItemResult, RequirementResult, ValidationResult } from '../../../contracts/src/validation.ts';
import { RunSummary } from '../../../contracts/src/run.ts';
import {seedLegacyRun} from '../../../hub/runs/engine/testing/legacy-run.ts';
import { itemCell, readPackDirectory, validatePack } from '../../../hub/runs/api.ts';
import { sandboxSkip, type Harness } from '../../../hub/runs/engine/testing/harness.ts';
import {openRetryHarness as openHarness} from '../../../hub/runs/engine/testing/retry-harness.ts';
import { writePack, type PackSpec } from '../../../hub/runs/engine/testing/packs.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { expected, type CheckOutcomes, type Expected, type Outcome, type RequirementDescription, type RunDescription, type SubmissionDescription } from './oracle.ts';

const SEED = 20261022;
const HIT = 'oracle.hit';
const WIDE = 'oracle.wide';
const skip = await sandboxSkip();

let postgres: TemporaryPostgres;
let harness: Harness;
let scratch: string;

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  harness = await openHarness(postgres);
  scratch = await mkdtemp(`${tmpdir()}/oracle-diff-`);
  const dir = await writePack(scratch, pack());
  const draft = await writePack(scratch, pack('oracle-draft'));
  await harness.workflows.add(dir);
  await harness.workflows.add(draft);
  await harness.workflows.add(await writePack(scratch,pack('oracle-bootstrap',true)));
  harness.workflows.assign(harness.alice.id,'oracle-bootstrap');
  harness.workflows.assign(harness.alice.id, 'oracle');
  harness.workflows.assign(harness.alice.id, 'oracle-draft');
});

after(async () => {
  await harness?.close();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  await postgres?.stop();
});

// ---------------------------------------------------------------- the driving pack

interface Spec {
  key: string;
  producer: RequirementDescription['producer'];
  layers: Layer[];
  required: boolean;
  /** Absent when no check is installed. */
  check?: { id: string; judges: 'subject' | 'artifact_under_verification'; tier: CheckTier | null };
  negative: boolean;
  acceptsDeclaredIndependence: boolean;
  independent: boolean;
  runLevel: boolean;
  errorTable: RequirementDescription['errorTable'];
}

const SPECS: Spec[] = [
  { key: 'fact', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_fact', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'repair', maxRounds: 2 }] },
  { key: 'neg', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_neg', judges: 'subject', tier: 'blocking' }, negative: true, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'repair', maxRounds: 2 }] },
  { key: 'bare', producer: 'fact', layers: ['static'], required: true, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [] },
  { key: 'judged', producer: 'judgment', layers: ['static'], required: true, check: { id: 'c_judged', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [] },
  { key: 'indep', producer: 'independent_judgment', layers: ['static'], required: true, check: { id: 'c_indep', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: true, independent: true, runLevel: false, errorTable: [] },
  { key: 'closed', producer: 'independent_judgment', layers: ['static'], required: true, negative: false, acceptsDeclaredIndependence: false, independent: true, runLevel: false, errorTable: [] },
  { key: 'reject', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_reject', judges: 'artifact_under_verification', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'reject' }] },
  { key: 'advisory', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_advisory', judges: 'artifact_under_verification', tier: 'advisory' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'reject' }] },
  { key: 'both', producer: 'fact', layers: ['static', 'dynamic'], required: true, check: { id: 'c_both', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'repair', maxRounds: 2 }] },
  { key: 'optional', producer: 'fact', layers: ['static'], required: false, check: { id: 'c_opt', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'repair', maxRounds: 2 }] },
  { key: 'short', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_short', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'repair', maxRounds: 1 }, { code: WIDE, action: 'repair', maxRounds: 3 }] },
  { key: 'ask', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_ask', judges: 'artifact_under_verification', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'request' }] },
  { key: 'recorded', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_recorded', judges: 'artifact_under_verification', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'unknown' }] },
  { key: 'star', producer: 'fact', layers: ['static'], required: true, check: { id: 'c_star', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: '*', action: 'repair', maxRounds: 2 }] },
  { key: 'dyn', producer: 'fact', layers: ['dynamic'], required: true, check: { id: 'c_dyn', judges: 'subject', tier: 'blocking' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [{ code: HIT, action: 'repair', maxRounds: 2 }] },
  { key: 'loose', producer: 'fact', layers: ['static'], required: false, check: { id: 'c_loose', judges: 'subject', tier: 'advisory' }, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: false, errorTable: [] },
  { key: 'level', producer: 'judgment', layers: ['static'], required: true, negative: false, acceptsDeclaredIndependence: false, independent: false, runLevel: true, errorTable: [] },
];

const CHECK_SOURCE = (key: string, judges:'subject'|'artifact_under_verification'): string => `
export default function check(input) {
  const subject = input && input.subject;
  const claims = subject && subject.slots && subject.slots[${JSON.stringify(key)}];
  const data = Array.isArray(claims) && claims[0] && claims[0].data;
  const frozen = subject && subject.fields && subject.fields.scripted_outcomes && subject.fields.scripted_outcomes[${JSON.stringify(key)}];
  const source = ${judges==='subject'?'frozen':'data && data.outcomes'};
  const list = Array.isArray(source) ? source : [{ verdict: 'unknown', tier: 'blocking', reason: 'missing_input' }];
  return list.map((o) => {
    const out = { verdict: o.verdict, statement: '合成检查', grounds: [], tier: o.tier || 'blocking' };
    if (typeof o.code === 'string') out.code = o.code;
    if (typeof o.reason === 'string') out.reason = o.reason;
    if (o.verdict === 'unknown') out.missing = '合成检查缺少脚本声明的判定事实';
    return out;
  });
}
`;

const PROJECT_SOURCE = `
export default function project(input) {
  const inputs = (input && input.inputs) || [];
  const subject = inputs.find((i) => i.slot === 'map');
  const nodes = subject && subject.model && subject.model.nodes;
  if (!subject || subject.parser !== 'kityminder@1' || !Array.isArray(nodes)) {
    return { error: { code: 'oracle.bad_input', message: '被判对象不是脑图', fix: '上传脑图' }, warnings: [] };
  }
  const items = [];
  for (const node of nodes) {
    const resource = node.data && node.data.resource;
    if (!Array.isArray(resource) || resource.length === 0) continue;
    items.push({
      id: String(node.data.id),
      label: node.text || String(node.data.id),
      location: { parser: 'kityminder@1', selector: node.selector },
      fields: { negative: node.data.negative === true,scripted_outcomes:node.data.scripted_outcomes },
    });
  }
  if (items.length === 0) return { error: { code: 'oracle.no_item', message: '没有条目', fix: '给节点加上 resource' }, warnings: [] };
  return { items, warnings: [] };
}
`;

function pack(id = 'oracle', admissible=false): PackSpec {
  const requirements = SPECS.map((spec) => ({
    key: spec.key,
    name: spec.key,
    description: `${spec.key}（合成）`,
    target: spec.runLevel ? ('run' as const) : ('item' as const),
    required: spec.required,
    done_rule: 'bookkeeping' as const,
    layers: spec.layers,
    accepted_producer: spec.producer,
    ...(spec.independent ? { independent_of: 'predecessor' as const } : {}),
    ...(spec.acceptsDeclaredIndependence ? { accepts_declared_independence: true } : {}),
    checks: spec.check === undefined ? [] : [spec.check.id],
    ...(spec.negative ? { expected: { overrides: [{ when: { pointer: '/negative', equals: true }, outcome: 'refute' as const, codes: [HIT] }] } } : {}),
    error_handling: spec.errorTable.map((row) => ({ code: row.code, action: row.action, ...(row.maxRounds === undefined ? {} : { max_rounds: row.maxRounds }) })),
  }));
  const checks = SPECS.flatMap((spec) =>
    spec.check === undefined
      ? []
      : [{ id: spec.check.id, function: { module: `functions/${spec.check.id}.ts` }, applies: 'item' as const, judges: spec.check.judges, ...(spec.check.tier === null ? {} : { tier: spec.check.tier, basis: '合成检查' }) }],
  );
  if(admissible){
    for(const requirement of requirements){
      if(requirement.key==='bare')requirement.checks=['bootstrap'];
      if(requirement.accepted_producer==='fact'&&requirement.layers.includes('dynamic'))Object.assign(requirement,{observation:'synthetic.observation@1'});
    }
    checks.push({id:'bootstrap',function:{module:'functions/bootstrap.ts'},applies:'item',judges:'subject',tier:'blocking'});
  }
  const itemSlots: SlotsFile['item'] = {};
  for (const spec of SPECS) {
    if (spec.runLevel || spec.check === undefined) continue;
    itemSlots[spec.key] = {
      min: 0,
      max: 1,
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['outcomes'],
        properties: {
          outcomes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['verdict'],
              properties: { verdict: { type: 'string' }, code: { type: 'string' }, tier: { type: 'string' }, reason: { type: 'string' } },
            },
          },
        },
      },
    };
  }
  const workflow: WorkflowFile = {
    schema: 'workflow@1',
    inputs: [{ slot: 'map', role: 'subject', description: '合成脑图', accepts: ['application/json'], required: true, many: false }],
    parameters: [],
    product: { catalogs: ['commands@1'] },
    subject: 'map',
    projection: { module: 'functions/project.ts' },
  };
  const files: PackSpec['files'] = {
    'workflow.json': { json: workflow },
    'requirements.json': { json: { schema: 'requirements@1', requirements } satisfies RequirementsFile },
    'checks.json': { json: { schema: 'checks@1', checks } satisfies ChecksFile },
    'slots.schema.json': { json: { schema: 'slots@1', item: itemSlots, run: {} } satisfies SlotsFile },
    'SKILL.md': '# 合成判定\n\n按槽位里的脚本返回检查结论。\n',
    'functions/project.ts': PROJECT_SOURCE,
  };
  for (const spec of SPECS) if (spec.check !== undefined) files[`functions/${spec.check.id}.ts`] = CHECK_SOURCE(spec.key,spec.check.judges);
  if(admissible)files['functions/bootstrap.ts']="export default () => [{verdict:'support',statement:'合成引导检查',grounds:[],tier:'blocking'}];";
  return { id, version: '1.0.0', kind: 'workflow', title: '合成判定', description: '差分测试用的合成任务包', files };
}

// ---------------------------------------------------------------- scenarios

interface ItemPlan {
  id: string;
  negative: boolean;
  handling: 'handled' | 'skipped' | 'missing';
  /** Outcomes per requirement key that has a check. Ignored by the reference when the item is not handled. */
  outcomes: Record<string, Outcome[]>;
}

interface Plan {
  seed: number;
  /** Submissions already validated on this run, as choice 10 counts them. */
  roundsUsed: number;
  chargedRounds?:Record<string,number>;
  items: ItemPlan[];
  judge: { session: string; model: string; model_identity?: { model_id: string; model_family_id: string } };
  author: { session: string; model: string; model_identity?: { model_id: string; model_family_id: string } } | null;
  /** Protocol codes of a submission the boundary does not accept. Empty when it should be accepted. */
  defects: ProtocolCode[];
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

const UNKNOWN_REASONS = ['check_error', 'timeout', 'missing_input'] as const;

function randomOutcome(random: () => number, wide: boolean): Outcome {
  const roll = random();
  if (roll < 0.45) return { verdict: 'support' };
  if (roll < 0.75) return { verdict: 'refute', code: wide && random() < 0.5 ? WIDE : HIT, tier: random() < 0.5 ? 'blocking' : 'advisory' };
  return { verdict: 'unknown', reason: pick(random, UNKNOWN_REASONS) };
}

function randomPlan(seed: number, roundsUsed: number, items: { id: string; negative: boolean }[], judge: Plan['judge'], author: Plan['author']): Plan {
  const random = rng(seed);
  return {
    seed,
    roundsUsed,
    judge,
    author,
    defects: [],
    items: items.map((item) => {
      const outcomes: Record<string, Outcome[]> = {};
      for (const spec of SPECS) {
        if (spec.check === undefined) continue;
        // `both` is not refuted, because a static violation beside a dynamic layer that was not run is a combination
        // the model does not rank. `dyn` has no static layer.
        if (spec.key === 'both' || spec.key === 'dyn') outcomes[spec.key] = [{ verdict: 'support' }];
        else outcomes[spec.key] = [randomOutcome(random, spec.key === 'short' || spec.key === 'star')];
      }
      return { ...item, handling: 'handled', outcomes };
    }),
  };
}

function referenceOf(plan: Plan): Expected {
  const run: RunDescription = {
    items: plan.items.map((item) => ({ id: item.id, negative: item.negative })),
    requirements: SPECS.filter((spec) => !spec.runLevel).map((spec) => ({
      key: spec.key,
      required: spec.required,
      layers: spec.layers,
      producer: spec.producer,
      acceptsDeclaredIndependence: spec.acceptsDeclaredIndependence,
      checks: spec.check === undefined ? [] : [spec.check.id],
      negativeCodes: spec.negative ? [HIT] : null,
      errorTable: spec.errorTable,
    })),
    runLevel: SPECS.filter((spec) => spec.runLevel).map((spec) => spec.key),
    checks: SPECS.flatMap((spec) => (spec.check === undefined ? [] : [{ id: spec.check.id, judges: spec.check.judges, tier: spec.check.tier }])),
    roundsUsed: plan.roundsUsed,
    ...(plan.chargedRounds?{chargedRounds:plan.chargedRounds}:{}),
    author: plan.author,
  };
  const submission: SubmissionDescription = {
    judge: plan.judge,
    items: Object.fromEntries(plan.items.filter((item) => item.handling !== 'missing').map((item) => [item.id, { handling: item.handling === 'skipped' ? 'skipped' as const : 'handled' as const }])),
    defects: plan.defects,
  };
  const outcomes: CheckOutcomes = {};
  for (const spec of SPECS) {
    if (spec.check === undefined) continue;
    outcomes[spec.check.id] = {};
    for (const item of plan.items) outcomes[spec.check.id][item.id] = item.outcomes[spec.key] ?? [{ verdict: 'support' }];
  }
  return expected(run, submission, outcomes);
}

function mindMap(items: { id: string; negative: boolean;outcomes?:Record<string,Outcome[]> }[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    root: {
      data: { id: 'root', text: '合成', created: 1 },
      children: items.map((item) => ({ data: { id: item.id, text: item.id, created: 1, resource: ['case'], negative: item.negative,scripted_outcomes:item.outcomes??Object.fromEntries(SPECS.filter(spec=>spec.check!==undefined).map(spec=>[spec.key,[{verdict:'support'}]])) }, children: [] })),
    },
    template: 'default',
    theme: 'fresh-blue',
    version: '1.4.43',
  }));
}

function submissionOf(run: RunSummary, plan: Plan): Record<string, unknown> {
  const items = [];
  for (const item of plan.items) {
    if (item.handling === 'missing') continue;
    if (item.handling === 'skipped') {
      items.push({ item: item.id, handling: 'skipped', reason: '合成跳过' });
      continue;
    }
    const slots: Record<string, unknown[]> = {};
    for (const spec of SPECS) {
      if (spec.check === undefined || spec.runLevel) continue;
      slots[spec.key] = [{ text: '合成检查', data: { outcomes: item.outcomes[spec.key] } }];
    }
    items.push({ item: item.id, handling: 'handled', slots });
  }
  return { run: run.run, model: plan.judge.model, ...(plan.judge.model_identity === undefined ? {} : { model_identity: plan.judge.model_identity }), items };
}

async function start(items: { id: string; negative: boolean;outcomes?:Record<string,Outcome[]> }[], predecessor?: string, session = 'sess-start', map?: string, packId = 'oracle'): Promise<RunSummary> {
  const reference = map ?? (await harness.upload(harness.alice, mindMap(items)));
  const answer = await harness.service.startRun(
    harness.alice,
    { pack: 'oracle-bootstrap', product: 'Meadow', version: '10.6.1',build:'Rel_MEADOW_10_6_1_7', inputs: { map: { reference } }, ...(predecessor === undefined ? {} : { predecessor }) },
    harness.call(session),
  );
  assert.equal(answer.call_result, 'ok', JSON.stringify(answer.errors));
  // Explicit legacy record fixture: fresh admission is tested separately and is never bypassed in runtime code.
  // The admitted bootstrap supplies genuine parsed inputs and projection; only the synthetic old declaration is seeded.
  const old=await harness.workflows.forUser(harness.alice,packId);
  assert.ok(old);
  const requirements=answer.run!.requirements.map(({observation:_observation,...requirement})=>requirement);
  return seedLegacyRun(harness.kit,answer.run!,old.pack,requirements);
}

async function submit(run: RunSummary, plan: Plan): Promise<{ acceptance: string; result?: ValidationResult; counts?: Record<string, number>; errors: { code: string; item?: string; requirement?: string; rounds_left?: number }[] }> {
  const answer = await harness.service.submitResult(harness.alice, submissionOf(run, plan), harness.call(plan.judge.session));
  return {
    acceptance: answer.acceptance ?? '',
    result: answer.result as ValidationResult | undefined,
    counts: answer.counts as Record<string, number> | undefined,
    errors: (answer.errors ?? []).map((error) => ({
      code: error.code,
      ...(error.item === undefined ? {} : { item: error.item }),
      ...(error.requirement === undefined ? {} : { requirement: error.requirement }),
      ...(error.rounds_left === undefined ? {} : { rounds_left: error.rounds_left }),
    })),
  };
}

function layerView(layer: { layer: string; terminal: string; code?: string; tier?: string; reason?: string; attribution?: string }): { layer: string; terminal: string; code?: string; tier?: string; reason?: string; attribution?: string } {
  return { layer: layer.layer, terminal: layer.terminal, ...(layer.code === undefined ? {} : { code: layer.code }), ...(layer.tier === undefined ? {} : { tier: layer.tier }), ...(layer.reason === undefined ? {} : { reason: layer.reason }), ...(layer.attribution === undefined ? {} : { attribution: layer.attribution }) };
}

function cellsOf(requirements: RequirementResult[]): { static: unknown; dynamic: unknown } {
  const cell = itemCell(requirements);
  const one = (value: { terminal: string; counts: Record<string, number> } | undefined): unknown => (value === undefined ? null : { value: value.terminal, counts: value.counts });
  return { static: one(cell.static), dynamic: one(cell.dynamic) };
}

function engineView(result: ValidationResult): unknown {
  const items = [];
  for (const partition of ['delivered', 'rejected', 'quarantined', 'incomplete'] as const) {
    for (const item of result.partitions[partition] as ItemResult[]) {
      const entry: Record<string, unknown> = { item: item.item, partition };
      if ('code' in item && item.code !== undefined) entry.code = item.code;
      if ('reason' in item && item.reason !== undefined) entry.reason = item.reason;
      entry.requirements = item.requirements.map((requirement) => ({
        requirement: requirement.requirement,
        status: requirement.status,
        ...(requirement.unsatisfied_reason === undefined ? {} : { unsatisfied_reason: requirement.unsatisfied_reason }),
        layers: requirement.layers.map(layerView).sort((a, b) => String((a as { layer: string }).layer).localeCompare(String((b as { layer: string }).layer))),
      }));
      entry.cells = cellsOf(item.requirements);
      items.push(entry);
    }
  }
  return {
    acceptance: result.acceptance,
    rounds: result.rounds,
    items,
    errors: result.errors.map((error) => ({ code: error.code, ...(error.item === undefined ? {} : { item: error.item }), ...(error.requirement === undefined ? {} : { requirement: error.requirement }), ...(error.rounds_left === undefined ? {} : { rounds_left: error.rounds_left }) })),
  };
}

function referenceView(value: Expected): unknown {
  return {
    acceptance: value.acceptance,
    rounds: value.rounds,
    items: value.items.map((item) => ({
      item: item.item,
      partition: item.partition,
      ...(item.code === undefined ? {} : { code: item.code }),
      ...(item.reason === undefined ? {} : { reason: item.reason }),
      requirements: item.requirements.map((requirement) => ({
        requirement: requirement.requirement,
        status: requirement.status,
        ...(requirement.unsatisfied_reason === undefined ? {} : { unsatisfied_reason: requirement.unsatisfied_reason }),
        layers: requirement.layers.map(layerView).sort((a, b) => a.layer.localeCompare(b.layer)),
      })),
      cells: item.cells,
    })),
    errors: value.errors.map((error) => ({
      ...(error.code === undefined ? {} : { code: error.code }),
      ...(error.item === undefined ? {} : { item: error.item }),
      ...(error.requirement === undefined ? {} : { requirement: error.requirement }),
      ...(error.rounds_left === undefined ? {} : { rounds_left: error.rounds_left }),
    })),
  };
}

function sorted(value: unknown): string {
  return JSON.stringify(value, (_, inner) => {
    if (Array.isArray(inner)) {
      const items = inner.map((entry) => JSON.parse(sorted(entry)) as unknown);
      if (items.every((entry) => entry !== null && typeof entry === 'object' && 'item' in (entry as object))) {
        items.sort((a, b) => String((a as { item: string }).item).localeCompare(String((b as { item: string }).item)) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      if (items.every((entry) => entry !== null && typeof entry === 'object' && 'requirement' in (entry as object) && !('item' in (entry as object)))) {
        items.sort((a, b) => String((a as { requirement: string }).requirement).localeCompare(String((b as { requirement: string }).requirement)));
      }
      if (items.every((entry) => entry !== null && typeof entry === 'object' && 'code' in (entry as object) && !('requirement' in (entry as object) && 'status' in (entry as object)))) {
        items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return items;
    }
    if (inner !== null && typeof inner === 'object') {
      const record = inner as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return inner;
  });
}

async function agree(plan: Plan, run: RunSummary): Promise<void> {
  const got = await submit(run, plan);
  const want = referenceOf(plan);
  if (plan.defects.length > 0) {
    assert.equal(got.acceptance, 'not_accepted', JSON.stringify(got.errors));
    assert.ok(got.result);
    assert.ok(Object.values(got.result.partitions).every(items=>items.length===0),'refused submissions retain their receipt without item partitions');
    assert.equal(want.acceptance, 'not_accepted');
    assert.deepEqual(want.items, []);
    return;
  }
  assert.equal(got.acceptance, 'accepted', `seed ${plan.seed}: ${JSON.stringify(got.errors)}`);
  assert.ok(got.result);
  const left = JSON.parse(sorted({ ...JSON.parse(sorted(engineView(got.result))) as object, counts: got.counts })) as Differ;
  const right = JSON.parse(sorted({ ...JSON.parse(sorted(referenceView(want))) as object, counts: want.counts })) as Differ;
  const lines = differences(left, right);
  if (lines.length > 0) {
    writeFileSync(join(tmpdir(), 'oracle-diff.txt'), [`seed ${plan.seed}`, ...lines].join('\n'));
  }
  assert.deepEqual(lines, [], `seed ${plan.seed}: ${lines.length} differences, see ${join(tmpdir(), 'oracle-diff.txt')}`);
}

interface Differ {
  counts?: Record<string, number>;
  rounds?: { used: number; max: number };
  errors?: unknown[];
  items?: { item: string; partition?: string; reason?: string; code?: string; requirements?: { requirement: string; status?: string; unsatisfied_reason?: string; layers?: unknown[] }[]; cells?: unknown }[];
}

function differences(engine: Differ, oracle: Differ): string[] {
  const lines: string[] = [];
  if (JSON.stringify(engine.counts) !== JSON.stringify(oracle.counts)) lines.push(`counts engine ${JSON.stringify(engine.counts)} oracle ${JSON.stringify(oracle.counts)}`);
  if (JSON.stringify(engine.rounds) !== JSON.stringify(oracle.rounds)) lines.push(`rounds engine ${JSON.stringify(engine.rounds)} oracle ${JSON.stringify(oracle.rounds)}`);
  if (JSON.stringify(engine.errors) !== JSON.stringify(oracle.errors)) lines.push(`errors engine ${JSON.stringify(engine.errors)} oracle ${JSON.stringify(oracle.errors)}`);
  const oracleItems = new Map((oracle.items ?? []).map((item) => [item.item, item]));
  for (const item of engine.items ?? []) {
    const other = oracleItems.get(item.item);
    if (other === undefined) {
      lines.push(`${item.item} missing from the reference`);
      continue;
    }
    if (item.partition !== other.partition || item.reason !== other.reason || item.code !== other.code) {
      lines.push(`${item.item} partition engine ${item.partition}/${item.reason ?? ''}/${item.code ?? ''} oracle ${other.partition}/${other.reason ?? ''}/${other.code ?? ''}`);
    }
    if (JSON.stringify(item.cells) !== JSON.stringify(other.cells)) lines.push(`${item.item} cells engine ${JSON.stringify(item.cells)} oracle ${JSON.stringify(other.cells)}`);
    const requirements = new Map((other.requirements ?? []).map((requirement) => [requirement.requirement, requirement]));
    for (const requirement of item.requirements ?? []) {
      const want = requirements.get(requirement.requirement);
      if (JSON.stringify(requirement) !== JSON.stringify(want)) lines.push(`${item.item}/${requirement.requirement} engine ${JSON.stringify(requirement)} oracle ${JSON.stringify(want)}`);
    }
  }
  return lines;
}

const ITEMS = [
  { id: 'i1', negative: false },
  { id: 'i2', negative: true },
  { id: 'i3', negative: false },
  { id: 'i4', negative: true },
];

interface ShownLayer {
  terminal: string;
  reason?: string;
  attribution?: string;
  tier?: string;
  code?: string;
}

function shownLayer(view: { items: { item: string; requirements: { requirement: string; status?: string; layers: ShownLayer[] }[] }[] }, itemId: string, requirement: string): { status?: string; layer?: ShownLayer } {
  const requirementResult = view.items.find((item) => item.item === itemId)?.requirements.find((entry) => entry.requirement === requirement);
  return { status: requirementResult?.status, layer: requirementResult?.layers[0] };
}

test('fresh admission refuses the legacy oracle declarations before any fixture playback',{skip},async()=>{
  const map=await harness.upload(harness.alice,mindMap(ITEMS));
  const answer=await harness.service.startRun(harness.alice,{pack:'oracle',product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},harness.call('observed-admission'));
  assert.equal(answer.call_result,'error');assert.equal(answer.run,undefined);
  assert.ok(answer.errors.some(e=>e.path==='/pack'&&e.fix?.includes('请求 rec:')));
});

test('random submissions and the revised fixed branches agree with the independent reference', { skip, timeout: 300_000 }, async () => {
  const run = await start(ITEMS);
  const judge = { session: 'sess-judge', model: 'beta@2', model_identity: { model_id: 'synthetic-oracle-beta', model_family_id: 'synthetic-oracle-family-beta' } };
  // Each randomized comparison starts from its own frozen run and explicitly zero charged counters.
  const plans = Array.from({ length: 48 }, (_, index) => randomPlan(SEED + index, 0, ITEMS, judge, null));
  for (const plan of plans) await agree(plan,await start(plan.items));

  // Independence against a predecessor whose accepted submission names the author.
  const author = { session: 'sess-author', model: 'alpha@1', model_identity: { model_id: 'synthetic-oracle-alpha', model_family_id: 'synthetic-oracle-family-alpha' } };
  const baseItems = ITEMS.map((item) => ({ ...item, handling: 'handled' as const, outcomes: Object.fromEntries(SPECS.filter((spec) => spec.check !== undefined).map((spec) => [spec.key, [{ verdict: 'support' as const }]])) }));
  // The author run is another pack. A predecessor of the same pack is pinned below: the engine does not treat it as the author.
  const predecessor = await start(ITEMS, undefined, author.session, undefined, 'oracle-draft');
  await agree({ seed: SEED + 100, roundsUsed: 0, items: baseItems, judge: author, author: null, defects: [] }, predecessor);
  const continued = await start(ITEMS, predecessor.run, judge.session);
  await agree({ seed: SEED + 101, roundsUsed: 0, items: baseItems, judge, author, defects: [] }, continued);
  const sameSession = await start(ITEMS, predecessor.run, 'sess-held');
  await agree({ seed: SEED + 102, roundsUsed: 0, items: baseItems, judge: { ...judge, session: author.session }, author, defects: [] }, sameSession);
  const sameModel = await start(ITEMS, predecessor.run, 'sess-other');
  await agree({ seed: SEED + 103, roundsUsed: 0, items: baseItems, judge: { ...judge, session: 'sess-other', model: author.model, model_identity: author.model_identity }, author, defects: [] }, sameModel);

  // A duplicate item is a schema violation: the submission is not accepted and produces no partitions (T03 R[3], V05 R[5]).
  const duplicated = await harness.service.submitResult(
    harness.alice,
    { run: run.run, model: 'beta@2', items: [{ item: 'i1', handling: 'handled', slots: {} }, { item: 'i1', handling: 'handled', slots: {} }] },
    harness.call('sess-judge'),
  );
  assert.equal(duplicated.acceptance, 'not_accepted');
  assert.ok(duplicated.result);
  for (const partition of ['delivered', 'rejected', 'quarantined', 'incomplete'] as const) assert.equal(duplicated.result.partitions[partition].length, 0);
  assert.ok(duplicated.errors.some((error) => error.code === 'SUBMISSION_SCHEMA_VIOLATION' && error.path === '/items/1/item'));

  const supportOutcomes = Object.fromEntries(SPECS.filter((spec) => spec.check !== undefined).map((spec) => [spec.key, [{ verdict: 'support' as const }]]));
  const handledItems = (outcomes: ItemPlan['outcomes']): ItemPlan[] => ITEMS.map((item) => ({ ...item, handling: 'handled', outcomes }));

  async function acceptedView(plan: Plan, target: RunSummary): Promise<{ rounds: { used: number; max: number }; errors: { code?: string; item?: string; requirement?: string; rounds_left?: number }[]; items: { item: string; requirements: { requirement: string; status?: string; layers: ShownLayer[] }[] }[] }> {
    const got = await submit(target, plan);
    assert.equal(got.acceptance, 'accepted', JSON.stringify(got.errors));
    assert.ok(got.result);
    return JSON.parse(sorted(engineView(got.result))) as { rounds: { used: number; max: number }; errors: { code?: string; item?: string; requirement?: string; rounds_left?: number }[]; items: { item: string; requirements: { requirement: string; status?: string; layers: ShownLayer[] }[] }[] };
  }

  // A04: a predecessor of the same pack is still the author. A different session and model satisfy the independent judgment.
  // Seed 20261126.
  const samePackSeed = SEED + 104;
  const sameItems = handledItems(supportOutcomes);
  const sameAuthorRun = await start(ITEMS, undefined, author.session);
  await submit(sameAuthorRun, { seed: samePackSeed, roundsUsed: 0, items: sameItems, judge: author, author: null, defects: [] });
  const sameEngine = await acceptedView({ seed: samePackSeed, roundsUsed: 0, items: sameItems, judge, author, defects: [] }, await start(ITEMS, sameAuthorRun.run, judge.session));
  const sameWant = referenceOf({ seed: samePackSeed, roundsUsed: 0, items: sameItems, judge, author, defects: [] });
  assert.equal(shownLayer(sameEngine, 'i1', 'indep').status, 'satisfied');
  assert.equal(shownLayer(sameEngine, 'i1', 'indep').layer?.terminal, 'judgment');
  assert.equal(sameWant.items.find((item) => item.item === 'i1')?.requirements.find((requirement) => requirement.requirement === 'indep')?.status, 'satisfied');

  // A later submission of the same body from the author's session. Both sides leave the independent judgment unsatisfied
  // (A04). Seed 20261127.
  const laterSeed = SEED + 105;
  const laterJudge = { ...judge, session: author.session };
  const laterPlan: Plan = { seed: laterSeed, roundsUsed: 0, items: sameItems, judge: laterJudge, author, defects: [] };
  const laterEngine = await acceptedView(laterPlan, continued);
  const laterWant = referenceOf(laterPlan);
  assert.equal(shownLayer(laterEngine, 'i1', 'indep').status, 'unsatisfied');
  assert.equal(laterWant.items.find((item) => item.item === 'i1')?.requirements.find((requirement) => requirement.requirement === 'indep')?.status, 'unsatisfied');

  // A repeated transitional body is rechecked without another charge. Subject refutations stay known violations;
  // the prior unresolved dynamic work contributes one charged round. Record-unknown handling retains the refutation.
  const roundSeed = SEED + 200;
  const roundOutcomes = { ...supportOutcomes, short: [{ verdict: 'refute' as const, code: HIT, tier: 'blocking' as const }], recorded: [{ verdict: 'refute' as const, code: HIT, tier: 'blocking' as const }] };
  const roundItems = handledItems(roundOutcomes);
  const roundRun = await start(roundItems);
  const roundPlan = (roundsUsed: number): Plan => ({ seed: roundSeed, roundsUsed,chargedRounds:{bare:roundsUsed,closed:roundsUsed,both:roundsUsed,dyn:roundsUsed}, items: roundItems, judge, author: null, defects: [] });
  await acceptedView(roundPlan(0), roundRun);
  const roundEngine = await acceptedView(roundPlan(1), roundRun);
  const roundWant = referenceOf(roundPlan(1));
  const engineShort = shownLayer(roundEngine, 'i1', 'short');
  const wantShort = roundWant.items.find((item) => item.item === 'i1')?.requirements.find((requirement) => requirement.requirement === 'short');
  assert.equal(roundEngine.rounds.used, 1);
  assert.equal(engineShort.layer?.terminal, 'violation');
  assert.equal(roundWant.rounds.used, 1);
  assert.equal(wantShort?.layers[0]?.terminal, 'violation');
  assert.equal(wantShort?.layers[0]?.attribution, 'author_input');
  const engineRecorded = shownLayer(roundEngine, 'i1', 'recorded');
  const wantRecorded = roundWant.items.find((item) => item.item === 'i1')?.requirements.find((requirement) => requirement.requirement === 'recorded');
  assert.equal(engineRecorded.layer?.terminal, 'violation');
  assert.equal(engineRecorded.layer?.attribution, 'unattributed');
  assert.equal(engineRecorded.status, 'unsatisfied');
  assert.equal(wantRecorded?.layers[0]?.terminal, 'violation');
  assert.equal(wantRecorded?.layers[0]?.attribution, 'unattributed');
  assert.equal(wantRecorded?.status, 'unsatisfied');

  // Seed 20261223 (SEED + 201): check tier is mandatory on publication; a check without one is a defect at runtime.
  // 1. Publication refusal: a pack check without declared tier is refused with checks.tier_missing; adding tier is accepted.
  const workflowDir = fileURLToPath(new URL('../../../packs/workflow', import.meta.url));
  const templateGapDir = join(workflowDir, 'template-gap');
  const stagedDir = join(scratch, 'staged-template-gap');
  await mkdir(stagedDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(templateGapDir, 'pack.json'), 'utf8')) as { files: { path: string }[] };
  for (const file of manifest.files) {
    const src = join(templateGapDir, file.path);
    const dest = join(stagedDir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
  await copyFile(join(templateGapDir, 'pack.json'), join(stagedDir, 'pack.json'));

  const validRead = await readPackDirectory(stagedDir);
  assert.ok(validRead.ok, JSON.stringify(!validRead.ok ? validRead.problems : []));
  const validValidation = await validatePack(validRead.pack);
  assert.equal(validValidation.ok, true, JSON.stringify(!validValidation.ok ? validValidation.problems : []));

  const badChecksFile = JSON.parse(await readFile(join(stagedDir, 'checks.json'), 'utf8')) as ChecksFile;
  delete (badChecksFile.checks[0] as any).tier;
  const badFiles = validRead.pack.files.map((f) =>
    f.path === 'checks.json' ? { ...f, bytes: new TextEncoder().encode(JSON.stringify(badChecksFile)) } : f,
  );
  const badValidation = await validatePack({ ...validRead.pack, files: badFiles });
  assert.equal(badValidation.ok, false);
  assert.ok(!badValidation.ok);
  const tierMissingProblem = badValidation.problems.find((p) => p.rule === 'checks.tier_missing');
  assert.ok(tierMissingProblem);
  assert.equal(tierMissingProblem.file, 'checks.json');
  assert.ok(/任务包 template-gap 的检查 coverage 没有声明 tier/.test(tierMissingProblem.message));
  assert.ok(/声明 blocking、advisory 或模型里的其他档名/.test(tierMissingProblem.fix));

  // 2. Runtime: a pack that bypasses publication with a check missing its tier is a pack defect, not a tier guess:
  // the layer is unchecked with check_error and the producer attribution, and no tier is shown.
  const legacyHit = 'oracle-legacy.hit';
  const legacyPack = pack('oracle-legacy');
  (legacyPack.files['checks.json'] as { json: ChecksFile }).json.checks = (legacyPack.files['checks.json'] as { json: ChecksFile }).json.checks.map((c) =>
    c.id === 'c_loose' ? { ...c, tier: undefined, basis: undefined } : c,
  );
  const legacyDir = await writePack(scratch, legacyPack);
  await harness.workflows.add(legacyDir);
  harness.workflows.assign(harness.alice.id, 'oracle-legacy');

  const tierSeed = SEED + 201;
  const legacyPlan: Plan = { seed: tierSeed, roundsUsed: 0, items: handledItems({ ...supportOutcomes, loose: [{ verdict: 'refute' as const, code: legacyHit, tier: 'blocking' as const }] }), judge, author: null, defects: [] };
  const legacyEngine = await acceptedView(legacyPlan, await start(legacyPlan.items, undefined, 'sess-legacy', undefined, 'oracle-legacy'));
  const missingTier = shownLayer(legacyEngine, 'i1', 'loose').layer;
  assert.equal(missingTier?.terminal, 'unchecked');
  assert.equal(missingTier?.reason, 'check_error');
  assert.equal(missingTier?.attribution, 'producer_error');
  assert.equal(missingTier?.tier, undefined, 'no tier is guessed for a check that declares none');

  // 3. Every pack in the repository passes checks.json validation (all checks declare explicit tier).
  const entries = await readdir(workflowDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const checksPath = join(workflowDir, entry.name, 'checks.json');
    try {
      const content = JSON.parse(await readFile(checksPath, 'utf8')) as ChecksFile;
      for (const check of content.checks) {
        assert.ok(check.tier === 'blocking' || check.tier === 'advisory', `pack ${entry.name} check ${check.id} lacks declared tier`);
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
  }

  // W07 R[2]: only artifact-dependent work is missing; target facts retain their independently frozen checks.
  const skipSeed = SEED + 7;
  const skipPlan: Plan = {
    seed: skipSeed,
    roundsUsed: 0,
    items: ITEMS.map((item, index) => ({ ...item, handling: index === 0 ? 'skipped' as const : 'handled' as const, outcomes: supportOutcomes })),
    judge,
    author: null,
    defects: [],
  };
  const skipEngine = await acceptedView(skipPlan, await start(ITEMS));
  const skipWant = referenceOf(skipPlan);
  const skipFact = shownLayer(skipEngine, 'i1', 'fact');
  const skipJudged = shownLayer(skipEngine, 'i1', 'judged');
  assert.equal(skipFact.layer?.terminal,'pass');
  assert.equal(skipFact.layer?.reason,undefined);
  assert.equal(skipFact.layer?.attribution,undefined);
  assert.equal(skipJudged.layer?.terminal, 'incomplete');
  assert.equal(skipJudged.layer?.reason,'repair_exhausted');
  assert.equal(skipJudged.layer?.attribution,'producer_error');
  const skipOracle = skipWant.items.find((item) => item.item === 'i1');
  const artifactKeys=new Set(SPECS.filter(spec=>!spec.runLevel&&(spec.producer!=='fact'||spec.check?.judges==='artifact_under_verification')).map(spec=>spec.key));
  for(const view of [skipOracle,skipEngine.items.find(item=>item.item==='i1')]){
    assert.ok(view);
    assert.ok(view.requirements.filter(requirement=>artifactKeys.has(requirement.requirement)).every(requirement=>requirement.layers.every(layer=>layer.terminal==='incomplete'&&layer.reason==='repair_exhausted')));
    assert.equal(view.requirements.find(requirement=>requirement.requirement==='fact')!.layers[0].terminal,'pass');
  }

  // W07 R[3]: omitted artifact work is named per requirement; target facts remain and acceptance is unchanged.
  const missingSeed = SEED + 8;
  const missingPlan: Plan = {
    seed: missingSeed,
    roundsUsed: 0,
    items: ITEMS.map((item) => ({ ...item, handling: item.id === 'i3' ? 'missing' as const : 'handled' as const, outcomes: supportOutcomes })),
    judge,
    author: null,
    defects: [],
  };
  const missingEngine = await acceptedView(missingPlan, await start(ITEMS));
  const missingWant = referenceOf(missingPlan);
  assert.ok(
    missingEngine.errors.some((error) => error.code === 'core.coverage.shortfall' && error.item === 'i3' && error.rounds_left === 0),
    JSON.stringify(missingEngine.errors),
  );
  assert.equal(shownLayer(missingEngine, 'i3', 'fact').layer?.terminal,'pass');
  assert.equal(shownLayer(missingEngine, 'i3', 'fact').layer?.reason,undefined);
  assert.equal(shownLayer(missingEngine, 'i3', 'judged').layer?.reason,'repair_exhausted');
  const missingOracle=missingWant.items.find(item=>item.item==='i3')!;
  assert.equal(missingOracle.reason,'repair_exhausted');
  for(const view of [missingOracle,missingEngine.items.find(item=>item.item==='i3')!]){
    assert.ok(view.requirements.filter(requirement=>artifactKeys.has(requirement.requirement)).every(requirement=>requirement.layers.every(layer=>layer.terminal==='incomplete'&&layer.reason==='repair_exhausted')));
    assert.equal(view.requirements.find(requirement=>requirement.requirement==='fact')!.layers[0].terminal,'pass');
  }
  assert.equal(missingWant.errors.filter(error=>error.item==='i3'&&error.code==='repair_exhausted').length,artifactKeys.size);
  assert.equal(missingWant.errors.find(error=>error.item==='i3'&&error.code==='core.coverage.shortfall')!.rounds_left,0);

});

// Integrator 2026-10-24: a known expectation miss wins over an unsettled layer; raw layers remain separate.
test('a known cross-layer expectation miss agrees without hiding the dynamic unknown',{skip},async()=>{
  const judge={session:'sess-both',model:'beta@2'};
  const supporting=Object.fromEntries(SPECS.filter(spec=>spec.check!==undefined).map(spec=>[spec.key,[{verdict:'support' as const}]]));
  const outcomes={...supporting,both:[{verdict:'refute' as const,code:HIT,tier:'blocking' as const}]};
  const plan:Plan={seed:SEED+10,roundsUsed:0,items:ITEMS.map(item=>({...item,handling:'handled',outcomes})),judge,author:null,defects:[]};
  const answer=await submit(await start(plan.items),plan);
  assert.equal(answer.acceptance,'accepted');assert.ok(answer.result);
  const actual=Object.values(answer.result.partitions).flat().find(item=>item.item==='i1')!.requirements.find(requirement=>requirement.requirement==='both')!;
  const independent=referenceOf(plan).items.find(item=>item.item==='i1')!.requirements.find(requirement=>requirement.requirement==='both')!;
  assert.equal(actual.status,'unsatisfied');assert.equal(independent.status,'unsatisfied');
  assert.equal(actual.unsatisfied_reason,'outcome_mismatch');assert.equal(independent.unsatisfied_reason,'outcome_mismatch');
  const dynamic=actual.layers.find(layer=>layer.layer==='dynamic')!;assert.equal(dynamic.terminal,'not_run');assert.ok(dynamic.missing&&dynamic.exit);
});
