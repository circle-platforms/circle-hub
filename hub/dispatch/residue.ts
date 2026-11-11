import type { ExecutorDefinition } from './definition.ts';

export type ResidueProbe = NonNullable<NonNullable<ExecutorDefinition['probes']>['seats'][number]['residue']>[number];
export type UnreadReason = 'refused' | 'unavailable' | 'not_text' | 'device_failure' | 'not_closed';
export type ResidueReading =
  | { state: 'clean' }
  | { state: 'residue'; lines: string[] }
  | { state: 'unread'; why: UnreadReason };
export type ResidueFinding = Exclude<ResidueReading, { state: 'clean' }>;

const whole = (pattern: string): RegExp => new RegExp(`^(?:${pattern})$`);

export function judgeResidue(text: unknown, probe: ResidueProbe): ResidueReading {
  if (typeof text !== 'string') return { state: 'unread', why: 'not_text' };
  const lines = text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(line => line !== '');
  const closing = whole(probe.closing);
  const headers = (probe.header_patterns ?? []).map(whole);
  const failures = (probe.failure_patterns ?? []).map(whole);
  if (lines.some(line => failures.some(pattern => pattern.test(line)))) return { state: 'unread', why: 'device_failure' };
  const entries = lines.filter(line => !closing.test(line) && !headers.some(pattern => pattern.test(line)));
  if (entries.length) return { state: 'residue', lines: entries };
  return lines.some(line => closing.test(line)) ? { state: 'clean' } : { state: 'unread', why: 'not_closed' };
}

const RESIDUE_FACT = '发现残留，设备上留有前一次使用后没清掉的状态';
const UNREAD_FACT: Record<UnreadReason, string> = {
  refused: '设备拒绝读取或设备输出无法保存，不能判断设备上有没有残留',
  unavailable: '只读应答连续三次不可用，不能判断设备上有没有残留',
  not_text: '工具回答里没有文字回答，不能判断设备上有没有残留',
  device_failure: '设备输出说明读取失败，不能判断设备上有没有残留',
  not_closed: '回答里没有声明的收尾行，分不清是空结果还是没读完整，不能判断设备上有没有残留',
};

export function residueFact(seat: string, command: string, finding: ResidueFinding): string {
  return `设备 ${seat} 读取 ${command} 后${finding.state === 'residue' ? RESIDUE_FACT : UNREAD_FACT[finding.why]}`;
}

export function residueNext(finding: ResidueFinding): string {
  return finding.state === 'residue'
    ? '管理员核对设备输出并清掉残留，再核对测试环境后重新上机验证。若只是设备固定显示的文字，管理员修正读取规则后重新核对'
    : '管理员读取设备输出，恢复读取或修正读取规则后重新核对测试环境';
}
