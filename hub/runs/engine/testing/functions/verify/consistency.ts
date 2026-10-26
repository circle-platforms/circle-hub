// Synthetic pack check function (toy-verify): a PASS verdict is inconsistent with an item the verification refutes or adds a
// new finding to. Reads the default run subject: the items with their slot records and the submitted cross_item entries.

interface Item {
  id: string;
  location: string;
  slots: { verification?: { code?: string }[] } | null;
}

export default function consistency(input: unknown): unknown {
  const subject = (input as { subject?: { items?: Item[]; cross_item?: { code?: string; rank?: string }[] } }).subject ?? {};
  const verdict = (subject.cross_item ?? []).find((c) => c.code === 'verdict')?.rank ?? null;
  const out: unknown[] = [];
  for (const item of subject.items ?? []) {
    const list = item.slots?.verification ?? [];
    const contradicts = list.some((c) => c.code === 'refuted' || c.code === 'new_finding');
    if (verdict === 'PASS' && contradicts) {
      out.push({ verdict: 'refute', code: 'toy-verify.inconsistent', statement: '结论为 PASS，却列出了被反驳的发现或新发现', grounds: [item.location], tier: 'blocking', item: item.id });
    } else {
      out.push({ verdict: 'support', statement: '逐条处置与结论一致', grounds: [item.location], tier: 'blocking', item: item.id, data: { verdict } });
    }
  }
  if (out.length === 0) out.push({ verdict: 'support', statement: '没有条目要核对', grounds: [], tier: 'blocking' });
  return out;
}
