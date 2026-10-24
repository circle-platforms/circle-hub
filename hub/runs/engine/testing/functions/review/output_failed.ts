// Synthetic pack output/read-back failure, reported by the check that owns generation.
export default function outputFailed(): unknown {
  return [{ verdict: 'unknown', missing: '能回读且与重算一致的合成产物', reason: 'output_failed', statement: '合成出件失败：回读不一致', grounds: [], tier: 'advisory' }];
}
