// The restricted slots the model fills and the deterministic generator (compile design section 2, P05): a plan is a
// pure function of the slots — the same case compiles to the same bytes twice. The generator emits the JSON form of
// the execution plan (exec-plan@1; the workbook format waits for the owner). The Hub re-generates from the submitted
// slots and compares byte for byte; a plan that is not exactly what the slots generate is not accepted.
import { isRecord } from './text.ts';
import { lookupMethod, orderedParams, type Contract } from './contract.ts';

/** The finite block set of the restricted structure (model W05): preparation and teardown blocks, nothing else. */
export const BLOCKS = ['setup', 'teardown'] as const;

export interface PlanStep {
  object: string;
  method: string;
  params: Record<string, unknown>;
}

export interface PlanExpect {
  text: string;
  quote: { reference: string; text: string };
}

/** The slots of one case's plan: bucket (the bed), blocks, the steps (object, method, params), the expected results. */
export interface PlanSlots {
  bucket: string;
  blocks: string[];
  steps: PlanStep[];
  expects: PlanExpect[];
  /** The canonical JSON text of the generated plan, as submitted. */
  planJson: string;
}

export interface SlotProblem {
  pointer: string;
  message: string;
}

/** Reads the submitted claim data into the restricted slots; problems are listed whole, never thrown. */
export function readSlots(data: unknown): { ok: true; slots: PlanSlots } | { ok: false; problems: SlotProblem[] } {
  const problems: SlotProblem[] = [];
  const problem = (pointer: string, message: string): void => {
    problems.push({ pointer, message });
  };
  const raw = isRecord(data) ? data : {};
  if (!isRecord(data)) problem('', '槽位数据不是对象');
  const bucket = typeof raw.bucket === 'string' && raw.bucket !== '' ? raw.bucket : null;
  if (bucket === null) problem('/bucket', '桶（台架名）不是非空字符串');
  const blocks: string[] = [];
  if (!Array.isArray(raw.blocks)) problem('/blocks', '块不是数组（没有块写 []）');
  else {
    for (const [i, block] of raw.blocks.entries()) {
      if (typeof block !== 'string' || !(BLOCKS as readonly string[]).includes(block)) problem(`/blocks/${i}`, `块 ${String(block)} 不在有限集 ${BLOCKS.join('、')} 里`);
      else if (!blocks.includes(block)) blocks.push(block);
    }
  }
  const steps: PlanStep[] = [];
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) problem('/steps', '步骤列表是空的：一份执行计划至少要有一步');
  else {
    for (const [i, step] of raw.steps.entries()) {
      const at = `/steps/${i}`;
      if (!isRecord(step)) {
        problem(at, '步骤不是对象');
        continue;
      }
      if (typeof step.object !== 'string' || step.object === '') problem(`${at}/object`, '步骤没有对象');
      if (typeof step.method !== 'string' || step.method === '') problem(`${at}/method`, '步骤没有方法');
      if (!isRecord(step.params)) problem(`${at}/params`, '步骤的参数不是对象（没有参数写 {}）');
      if (typeof step.object === 'string' && step.object !== '' && typeof step.method === 'string' && step.method !== '' && isRecord(step.params)) {
        steps.push({ object: step.object, method: step.method, params: step.params });
      }
    }
  }
  const expects: PlanExpect[] = [];
  if (!Array.isArray(raw.expects)) problem('/expects', '期望结果不是数组（没有期望结果写 []，由期望来源检查判定）');
  else {
    for (const [i, expect] of raw.expects.entries()) {
      const at = `/expects/${i}`;
      if (!isRecord(expect) || typeof expect.text !== 'string' || expect.text === '') {
        problem(at, '期望结果没有文字');
        continue;
      }
      const quote = isRecord(expect.quote) && typeof expect.quote.reference === 'string' && expect.quote.reference !== '' && typeof expect.quote.text === 'string' && expect.quote.text !== '' ? { reference: expect.quote.reference, text: expect.quote.text } : null;
      expects.push({ text: expect.text, quote: quote ?? { reference: '', text: '' } });
    }
  }
  const planJson = typeof raw.plan_json === 'string' ? raw.plan_json : null;
  if (planJson === null) problem('/plan_json', '执行计划的 JSON 文本不是字符串');
  return problems.length > 0 ? { ok: false, problems } : { ok: true, slots: { bucket: bucket as string, blocks, steps, expects, planJson: planJson as string } };
}

/** Canonical JSON: object members sorted by code unit, arrays in order, no whitespace (the plan's byte-exact form). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as { [key: string]: unknown };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export interface ExecPlan {
  schema: 'exec-plan@1';
  case: string;
  bed: string;
  blocks: string[];
  steps: Array<{ n: number; object: string; method: string; params: Record<string, unknown> }>;
  expects: Array<{ text: string; source: string }>;
}

/**
 * The plan the slots generate (deterministic): blocks sorted, steps numbered from 1 in slot order with their
 * parameters in the contract's declaration order (defaults filled), expected results citing their quote reference.
 * Null when a step's required parameters are missing — a shape problem the contract check names instead.
 */
export function generatePlan(caseId: string, slots: PlanSlots, contract: Contract): ExecPlan | null {
  const steps: ExecPlan['steps'] = [];
  for (const [i, step] of slots.steps.entries()) {
    const method = lookupMethod(contract, step.object, step.method);
    if (method === null) return null;
    const params = orderedParams(method, step.params);
    if (params === null) return null;
    steps.push({ n: i + 1, object: step.object, method: step.method, params });
  }
  return {
    schema: 'exec-plan@1',
    case: caseId,
    bed: slots.bucket,
    blocks: [...slots.blocks].sort(),
    steps,
    expects: slots.expects.map((expect) => ({ text: expect.text, source: expect.quote.reference })),
  };
}

/** The canonical bytes of the plan the slots generate; null when the plan cannot be generated from them. */
export function generatePlanJson(caseId: string, slots: PlanSlots, contract: Contract): string | null {
  const plan = generatePlan(caseId, slots, contract);
  return plan === null ? null : canonicalJson(plan);
}
