// Workbook verification entry point. Missing input automatically routes the client to its generation phase.
import { isRecord, type Outcome } from './text.ts';
export default function check(input: unknown): Outcome[] {
  const subject = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  return [{ verdict: 'unknown', reason: subject.workbook ? 'integrity_unproven' : 'missing_input', statement: subject.workbook ? '工作簿尚待独立读取与字节重算核验，不得派发；客户端须读取核验结果并继续修复。' : '缺少客户端生成的工作簿。先将计划要求项修到满足，再自动运行本包脚本、上传并以计划为前驱开新运行绑定 workbook 和 plan_run；不证明在真实设备上跑得通。', grounds: [], tier: 'blocking', ...(typeof subject.item === 'string' ? { item: subject.item } : {}) }];
}
