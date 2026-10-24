// One call of a product pack's producer function in the sandbox, with its output checked against producer-output@1. A
// failure says whether a smaller call could succeed (the function threw, its output was too large or outside the contract,
// its input too large, it hit the memory limit or ran past the time limit), so a list batch can be split to find the one
// document it fails on, and whether it ran past the time limit.
import { ProducerOutput } from '../../contracts/src/product.ts';
import type { KnownBuild, Producer, ProducerInput } from '../../contracts/src/product.ts';
import type { ProductHandle } from '../ports.ts';
import { SANDBOX_ERRORS, SandboxError, callPackFunction } from '../rules/api.ts';
import type { KnowledgeContext } from './context.ts';
import { describeError } from './errors.ts';
import type { ParsedSource } from './sources.ts';

export type ProducerSlotValue = NonNullable<ProducerInput['slots'][string]>;

export type ProducerRun = { ok: true; value: ProducerOutput } | { ok: false; reason: string; isolatable: boolean; timeout: boolean };

/** The ProducerSlot handed to the function for a parsed source. A list element carries its external id (product@1). */
export function slotOf(source: ParsedSource): ProducerSlotValue {
  return { sha256: source.sha256, media_type: source.mediaType, parser: source.parser, model: source.document.model, external: source.external };
}

export interface ProducerCall {
  build: KnownBuild | null;
  slots: ReadonlyMap<string, ParsedSource | null>;
  params: Record<string, unknown>;
  /** The batch of the list slot, when the producer has one. */
  list?: { slot: string; elements: readonly ParsedSource[]; batch: { index: number; of: number } };
}

export async function runProducer(context: KnowledgeContext, product: ProductHandle, producer: Producer, call: ProducerCall): Promise<ProducerRun> {
  const slots: ProducerInput['slots'] = {};
  for (const [slot, source] of call.slots) slots[slot] = source === null ? null : slotOf(source);
  const payload: ProducerInput = { ...(call.build === null ? {} : { build: call.build }), slots, params: call.params };
  if (call.list !== undefined) {
    payload.lists = { [call.list.slot]: call.list.elements.map(slotOf) };
    payload.batch = call.list.batch;
  }
  let output: unknown;
  try {
    const run = await callPackFunction(
      { packDir: product.directory, module: producer.function.module, export: producer.function.export },
      payload,
      context.sandbox.producer,
      { requireOsIsolation: context.sandbox.requireOsIsolation },
    );
    output = run.output;
  } catch (error) {
    if (error instanceof SandboxError) {
      const timeout = error.code === 'SANDBOX_TIMEOUT';
      const isolatable =
        timeout || error.code === 'FUNCTION_THREW' || error.code === 'SANDBOX_OUTPUT_TOO_LARGE' || (error.code === 'SANDBOX_VIOLATION' && error.detail.limit === 'memory');
      return { ok: false, reason: `生产器 ${producer.id} 运行失败：${SANDBOX_ERRORS[error.code]}`, isolatable, timeout };
    }
    // A RangeError is an input over the sandbox's size limit: a smaller batch can fit.
    return { ok: false, reason: `生产器 ${producer.id} 运行失败：${describeError(error)}`, isolatable: error instanceof RangeError, timeout: false };
  }
  const parsed = ProducerOutput.safeParse(output);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `生产器 ${producer.id} 的输出不符合 producer-output@1：${issue === undefined ? '' : `${issue.path.join('/')} ${issue.message}`}`, isolatable: true, timeout: false };
  }
  return { ok: true, value: parsed.data };
}
