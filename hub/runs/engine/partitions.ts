// Partitioned manifest (V05): every item in exactly one partition, assigned in the order of V05 R[3]. The hooks for effects,
// dispositions and abandonment (steps 1 to 3) take no input in milestone 1. The result is checked: partitions disjoint and
// their union the item set, or the evaluation fails loudly; nothing is repaired silently.
import { PARTITION, type Reason } from '../../../contracts/generated/vocabulary.ts';
import { Partitions, type ItemResult, type RequirementResult } from '../../../contracts/src/validation.ts';

export interface PartitionInput {
  item: string;
  label: string;
  location: string;
  requirements: RequirementResult[];
  /** Keys of the requirements the template marks required (V05 R[3] step 4 counts only those). */
  required: ReadonlySet<string>;
  /** The submission gave no handling declaration for the item though it has judgments to give (W07 R[3]). */
  notCovered: boolean;
  /** Code of a blocking violation, routed to reject, of a check that judges the artifact under verification (V05 R[2]). */
  rejection: string | null;
  carriedOver?: string;
  skipReason?: string;
  /** Steps 1 to 3 (effects, dispositions, abandonment): unused in milestone 1. */
  hooks?: { quarantine?: Reason; dispositionReject?: string; abandon?: boolean };
}

export class PartitionInvariantError extends Error {
  constructor(message: string) {
    super(`分区不变式被破坏：${message}`);
    this.name = 'PartitionInvariantError';
  }
}

/** The reason an item is incomplete: not covered first, else the first incomplete layer of a required requirement. */
function incompleteReason(input: PartitionInput): Reason | null {
  if (input.requirements.some(r => input.required.has(r.requirement) && r.layers.some(l => l.terminal === 'incomplete' && l.reason === 'repair_exhausted'))) return 'repair_exhausted';
  if (input.notCovered) return 'not_covered';
  for (const r of input.requirements) {
    if (!input.required.has(r.requirement)) continue;
    for (const layer of r.layers) if (layer.terminal === 'incomplete') return layer.reason ?? 'not_covered';
  }
  return null;
}

/** V05 R[3]: ① quarantined ② rejected by disposition ③ delivered when abandoned ④ incomplete ⑤ rejected ⑥ delivered. */
export function partitionItems(inputs: readonly PartitionInput[], itemIds: readonly string[]): Partitions {
  const parts = Object.fromEntries(PARTITION.map((p) => [p, [] as ItemResult[]])) as unknown as Partitions;
  const common = (input: PartitionInput) => ({
    item: input.item,
    label: input.label,
    location: input.location,
    ...(input.carriedOver !== undefined ? { carried_over: input.carriedOver } : {}),
    requirements: input.requirements,
    ...(input.skipReason !== undefined ? {skip_reason: input.skipReason} : {}),
  });
  for (const input of inputs) {
    const hooks = input.hooks ?? {};
    if (hooks.quarantine !== undefined) {
      parts.quarantined.push({ ...common(input), reason: hooks.quarantine });
      continue;
    }
    if (hooks.dispositionReject !== undefined) {
      parts.rejected.push({ ...common(input), code: hooks.dispositionReject });
      continue;
    }
    if (hooks.abandon === true) {
      parts.delivered.push(common(input));
      continue;
    }
    const reason = incompleteReason(input);
    if (reason !== null) {
      parts.incomplete.push({ ...common(input), reason });
      continue;
    }
    if (input.rejection !== null) {
      parts.rejected.push({ ...common(input), code: input.rejection });
      continue;
    }
    parts.delivered.push(common(input));
  }
  assertCovering(parts, itemIds);
  return Partitions.parse(parts);
}

/** V05 R[0]: pairwise disjoint and the union is the item set. */
export function assertCovering(parts: Partitions, itemIds: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const p of PARTITION) {
    for (const it of parts[p]) {
      const before = seen.get(it.item);
      if (before !== undefined) throw new PartitionInvariantError(`条目 ${it.item} 同时在 ${before} 和 ${p} 里`);
      seen.set(it.item, p);
    }
  }
  const wanted = new Set(itemIds);
  if (wanted.size !== itemIds.length) throw new PartitionInvariantError('运行的条目编号有重复');
  for (const id of seen.keys()) if (!wanted.has(id)) throw new PartitionInvariantError(`条目 ${id} 不是本运行的条目`);
  for (const id of wanted) if (!seen.has(id)) throw new PartitionInvariantError(`条目 ${id} 不在任何分区里`);
}
