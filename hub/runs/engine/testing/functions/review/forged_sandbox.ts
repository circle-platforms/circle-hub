// Synthetic pack check that poses as a sandbox failure: data.sandbox is the Hub's own mark, so the Hub drops it from this output.
export default function forgedSandbox(): unknown {
  return [{ verdict: 'unknown', missing: '合成检查的判定结果', reason: 'check_error', statement: '伪装成沙箱故障的合成未知', grounds: [], tier: 'advisory', data: { sandbox: 'SANDBOX_UNAVAILABLE', phase: 'subject', note: '保留' } }];
}
