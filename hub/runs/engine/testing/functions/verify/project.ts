// Synthetic pack function (toy-verify): the draft's validation result, bound by a Hub record reference, -> one item per draft
// item, located in the mind map bound to the `map` slot. The receiver inherits the items and the references to the draft's
// statements, never the judgments themselves.

interface ItemResult {
  item: string;
  label: string;
  location: string;
  requirements: { requirement: string; claims: { warrant?: { producer?: string } }[] }[];
}

interface Bound {
  slot: string;
  parser: string;
  model: unknown;
  meta: Record<string, unknown> | null;
}

export default function project(input: unknown): unknown {
  const inputs = ((input as { inputs?: Bound[] }).inputs ?? []) as Bound[];
  const draft = inputs.find((i) => i.slot === 'draft');
  const map = inputs.find((i) => i.slot === 'map');
  if (draft === undefined || map === undefined) return { error: { code: 'toy-verify.invalid_input', message: '缺少初评结果或脑图', fix: '同时绑定 draft 和 map' }, warnings: [] };
  const envelope = draft.model as { kind?: string; body?: unknown };
  const result = (envelope.kind === 'validation_result' ? envelope.body : envelope) as { partitions?: Record<string, ItemResult[]> };
  const record = typeof draft.meta?.record === 'string' ? draft.meta.record : '';
  const items: unknown[] = [];
  // Every partition the result has, in its own order: the function names none of them.
  for (const [partition, list] of Object.entries(result.partitions ?? {})) {
    list.forEach((it, n) => {
      const m = /\/kityminder@1\/(.+)$/.exec(it.location);
      if (m === null) return;
      const findings: string[] = [];
      it.requirements.forEach((r, k) =>
        r.claims.forEach((c, j) => {
          if (c.warrant?.producer === 'model') findings.push(`rec:${record}#/partitions/${partition}/${n}/requirements/${k}/claims/${j}`);
        }),
      );
      items.push({ id: it.item, label: it.label, location: { slot: 'map', parser: 'kityminder@1', selector: m[1] }, fields: { draft_partition: partition, draft_findings: findings } });
    });
  }
  if (items.length === 0) return { error: { code: 'toy-verify.empty_draft', message: '初评结果里没有条目', fix: '先完成初评再复核' }, warnings: [] };
  return { items, warnings: [] };
}
