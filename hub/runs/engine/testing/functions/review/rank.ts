// Synthetic pack check function (toy-review, findings): a finding coded self_contradiction may not be ranked minor.

interface Finding {
  code?: string;
  rank?: string;
}

export default function rank(input: unknown): unknown {
  const subject = (input as { subject?: { slots?: { findings?: Finding[] } | null } }).subject;
  const findings = subject?.slots?.findings ?? [];
  const out: unknown[] = [];
  findings.forEach((f, i) => {
    if (f.code === 'self_contradiction' && f.rank === 'minor') {
      out.push({ verdict: 'refute', code: 'toy-review.rank_too_low', statement: '自相矛盾的发现不能定为轻微', grounds: [], tier: 'blocking', pointer: `/slots/findings/${i}/rank` });
    }
  });
  if (out.length === 0) out.push({ verdict: 'support', statement: '发现的等级与码一致', grounds: [], tier: 'blocking', data: { checked: findings.length } });
  return out;
}
