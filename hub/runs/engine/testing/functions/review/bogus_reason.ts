// A valid vocabulary reason owned by an item declaration, not a check outcome.
export default function nonCheckReason(): unknown {
  return [{ verdict: 'unknown', reason: 'declared_skip', missing: '合成的检查结果', statement: '错误地由检查声明跳过', grounds: [], tier: 'advisory' }];
}
