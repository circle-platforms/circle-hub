import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "./activities.js";

const { applyEffect } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 10, initialInterval: "1 second", maximumInterval: "5 seconds" },
});

export const decisionSignal = defineSignal<[Record<string, unknown>]>("decision");

/**
 * Canonical evaluation flow, v1 semantics:
 * effect A -> wait for a human decision signal -> effect B -> done.
 */
export async function evalFlow(flowId: string): Promise<string> {
  let decision: Record<string, unknown> | undefined;
  setHandler(decisionSignal, (payload) => {
    if (decision === undefined) decision = payload;
  });
  await applyEffect(flowId, "A");
  await condition(() => decision !== undefined);
  await applyEffect(flowId, "B");
  return "done-v1";
}
