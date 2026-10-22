// Scores the review of a copy with injected defects against the gold written down at injection time (brief section 6b, review).
// The Hub's own literal check is scored apart from the model's findings: the first must see every defect it is able to see, the
// second is measured for recall on the injected defects and for noise on the untouched cases. Only node ids and codes are
// printed; the case texts stay in the run record.
import type { GoldEntry } from './inject.ts';

/** The parts of a stored validation result the scorer reads (the shape `circle-hub run show --json` gives under latest.result). */
export interface ResultLike {
  partitions: Record<string, ItemLike[]>;
}
export interface ItemLike {
  item: string;
  requirements: Array<{
    requirement: string;
    layers: Array<{ terminal: string; code?: string }>;
    claims: Array<{ statement: { code?: string; rank?: string } }>;
  }>;
}

export interface Seen {
  /** The item is in the delivered partition: the model's findings count only there. */
  reviewed: boolean;
  /** Codes of the literal requirement's violations on the item. */
  mechanical: string[];
  /** Codes of the model's findings on the item. */
  findings: string[];
}

export interface Detection {
  entry: GoldEntry;
  seen: Seen;
  detected: boolean;
}

export interface Extra {
  node: string;
  codes: string[];
  /** The baseline review of the untouched document already had a finding on this node. */
  inBaseline: boolean;
}

export interface Score {
  detections: Detection[];
  /** [found, total] per kind of seeing. */
  recall: { mechanical: [number, number]; judgment: [number, number] };
  /** Findings on cases that no defect was injected into. */
  extras: Extra[];
}

const nodeOf = (item: string): string => item.slice(item.lastIndexOf(':') + 1);

function seenOn(result: ResultLike): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const [partition, items] of Object.entries(result.partitions)) {
    for (const item of items) {
      const mechanical = item.requirements.filter((r) => r.requirement === 'literal').flatMap((r) => r.layers.flatMap((l) => (l.terminal === 'violation' ? [l.code ?? 'violation'] : [])));
      const findings = item.requirements.filter((r) => r.requirement === 'findings').flatMap((r) => r.claims.flatMap((c) => (c.statement.code === undefined ? [] : [c.statement.code])));
      out.set(nodeOf(item.item), { reviewed: partition === 'delivered', mechanical, findings });
    }
  }
  return out;
}

export function score(gold: readonly GoldEntry[], result: ResultLike, baseline?: ResultLike): Score {
  const seen = seenOn(result);
  const before = baseline === undefined ? new Map<string, Seen>() : seenOn(baseline);
  const touched = new Set(gold.flatMap((g) => [g.node, ...(g.copy === undefined ? [] : [g.copy])]));
  const detections = gold.map((entry): Detection => {
    const nodes = [entry.node, ...(entry.copy === undefined ? [] : [entry.copy])];
    const here = nodes.map((n) => seen.get(n)).filter((s): s is Seen => s !== undefined);
    const merged: Seen = { reviewed: here.some((s) => s.reviewed), mechanical: here.flatMap((s) => s.mechanical), findings: here.flatMap((s) => s.findings) };
    const detected = entry.seen_by === 'mechanical' ? merged.mechanical.length > 0 : merged.findings.length > 0;
    return { entry, seen: merged, detected };
  });
  const recallOf = (kind: GoldEntry['seen_by']): [number, number] => {
    const own = detections.filter((d) => d.entry.seen_by === kind);
    return [own.filter((d) => d.detected).length, own.length];
  };
  const extras = [...seen]
    .filter(([node, s]) => !touched.has(node) && s.findings.length > 0)
    .map(([node, s]): Extra => ({ node, codes: s.findings, inBaseline: (before.get(node)?.findings.length ?? 0) > 0 }));
  return { detections, recall: { mechanical: recallOf('mechanical'), judgment: recallOf('judgment') }, extras };
}

/** The score in plain lines for the owner. */
export function render(s: Score): string[] {
  const pct = ([found, total]: [number, number]): string => (total === 0 ? '无' : `${found}/${total}`);
  const lines = [`Hub 自己的字面检查看得见的缺陷：查出 ${pct(s.recall.mechanical)}`, `只有模型判断才看得见的缺陷：发现 ${pct(s.recall.judgment)}`, ''];
  for (const d of s.detections) {
    const where = d.entry.copy === undefined ? d.entry.node : `${d.entry.node}（副本 ${d.entry.copy}）`;
    const how = d.entry.seen_by === 'mechanical' ? `字面检查 ${d.seen.mechanical.length > 0 ? d.seen.mechanical.join('、') : '没有'}` : `模型发现 ${d.seen.findings.length > 0 ? d.seen.findings.join('、') : '没有'}`;
    lines.push(`- ${d.detected ? '查出' : '漏掉'}：${d.entry.label}（${where}）；${how}${d.seen.reviewed ? '' : '；这个条目没有被评审到'}`);
  }
  const fresh = s.extras.filter((e) => !e.inBaseline);
  lines.push('', `没有注入缺陷的用例上也有发现：${s.extras.length} 个条目，其中 ${fresh.length} 个在没改过的评审里没有出现（要人工判断是不是误报）`);
  for (const e of fresh) lines.push(`- ${e.node}：${e.codes.join('、')}`);
  return lines;
}
