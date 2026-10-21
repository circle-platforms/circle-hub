// Synthetic pack check function (toy-review, findings): a finding whose every cited source is a hint (a historical list) has
// no ground for a claim about behaviour (A03 R[6]). Reads the roles the Hub resolved for the item's evidence.

interface Finding {
  grounds?: string[];
  quotes?: { reference: string }[];
}

interface Subject {
  slots?: { findings?: Finding[] } | null;
  evidence?: { reference: string; role: string | null }[];
}

export default function grounds(input: unknown): unknown {
  const subject = ((input as { subject?: Subject }).subject ?? {}) as Subject;
  const roles = new Map((subject.evidence ?? []).map((e) => [e.reference, e.role]));
  const out: unknown[] = [];
  (subject.slots?.findings ?? []).forEach((f, i) => {
    const cited = [...(f.grounds ?? []), ...(f.quotes ?? []).map((q) => q.reference)];
    if (cited.length > 0 && cited.every((r) => roles.get(r) === 'hint')) {
      out.push({ verdict: 'refute', code: 'toy-review.hint_only', statement: '这条发现只引用了线索来源，不能作为产品行为的根据', grounds: cited, tier: 'blocking', pointer: `/slots/findings/${i}` });
    }
  });
  if (out.length === 0) out.push({ verdict: 'support', statement: '每条发现都有线索以外的根据', grounds: [], tier: 'blocking' });
  return out;
}
