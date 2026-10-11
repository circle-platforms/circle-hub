import {
  condition,
  defineSignal,
  patched,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities.js";

const { applyEffect } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 10, initialInterval: "1 second", maximumInterval: "5 seconds" },
});

export const decisionSignal = defineSignal<[Record<string, unknown>]>("decision");

/**
 * Canonical evaluation flow, v2 semantics: adds a marker effect C
 * after B — but only for flows whose recorded input pins semantics
 * version >= 2. The version travels in the workflow input (recorded
 * in history at start, so replay-stable), mirroring the PG route's
 * per-flow version pin.
 *
 * Why the input pin is needed: patched() alone does NOT freeze an
 * in-flight flow. During this evaluation, a v2 workflow gated only
 * by patched("marker-stage-c") gave an in-flight v1 flow the new
 * stage C — patched() only protects determinism of steps already
 * recorded; steps not yet executed adopt the new code. Strict
 * pinning requires either this input discipline or Temporal worker
 * deployment versioning with old workers kept alive.
 */
export async function evalFlow(flowId: string, semanticsVersion = 1): Promise<string> {
  let decision: Record<string, unknown> | undefined;
  setHandler(decisionSignal, (payload) => {
    if (decision === undefined) decision = payload;
  });
  await applyEffect(flowId, "A");
  await condition(() => decision !== undefined);
  await applyEffect(flowId, "B");
  if (semanticsVersion >= 2 && patched("marker-stage-c")) {
    await applyEffect(flowId, "C");
  }
  return semanticsVersion >= 2 ? "done-v2" : "done-v1";
}
