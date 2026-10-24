// A valid vocabulary reason owned by an item declaration, not a check outcome.
export default function nonCheckReason(): unknown {
  return [{ verdict: 'unknown', missing: '合成检查的判定结果', reason: 'declared_skip', statement: '错误地由检查声明跳过', grounds: [], tier: 'advisory' }];
}
