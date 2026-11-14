/**
 * D3 fact/next rewriting for call errors (Boss 13:05). Category words come from
 * error-reasons.callErrorCategoryOf (D1 table). These helpers turn legacy protocol
 * messages into owner wording for SOURCE_NOT_PERMITTED / LEASE_UNAVAILABLE /
 * SOURCE_INTEGRITY_UNPROVEN, and choose member vs admin next steps.
 */
import type { ProtocolError } from '../../contracts/src/common.ts';
import { callErrorCategoryOf, type CallErrorCategory } from './error-reasons.ts';

export { callErrorCategoryOf as callErrorCategory } from './error-reasons.ts';
export type { CallErrorCategory };

/** Closed five (hub-terms); mirrored here for tests that assert the set without importing D1 internals. */
export const CALL_ERROR_CATEGORIES = ['参数无效', '无权限', '不存在', '已被占用', '暂时不可用'] as const satisfies readonly CallErrorCategory[];

/**
 * Fact clause for the category sentence: no category prefix, no 任务包, no 「你」 as subject.
 * Keeps the first ；-segment of the protocol message (later segments are often next-step leftovers).
 */
export function callErrorFact(code: string, message: string): string {
  let fact = message.split('；')[0]!.trim();
  fact = fact.replace(/^无权限：|^已被占用：|^暂时不可用：|^参数无效：|^不存在：/, '');

  const packDenied = /^任务包 (.+) 存在，没有分配给你$/.exec(fact);
  if (packDenied) return `当前账户未获授权使用工作流「${packDenied[1]}」`;

  const workflowDenied = /^工作流 (.+) 存在，没有分配给(?:你|当前账户)$/.exec(fact);
  if (workflowDenied) return `当前账户未获授权使用工作流「${workflowDenied[1]}」`;

  const noRead = /^(.+?)存在，你没有读取权限(?::|：)?(.*)$/.exec(fact);
  if (noRead) {
    const object = noRead[1]!.trimEnd().replaceAll('任务包', '工作流');
    const detail = noRead[2]!.trim();
    return detail.length > 0
      ? `当前账户未获授权读取${object}（${detail}）`
      : `当前账户未获授权读取${object}`;
  }

  if (code === 'SOURCE_INTEGRITY_UNPROVEN') {
    if (/缺少经摘要核验的知识原件/.test(fact)) return '缺少经摘要核验的知识原件';
  }

  if (code === 'LEASE_UNAVAILABLE') {
    fact = fact.replace(/已被预订|已占用/, '正被占用');
  }

  return fact
    .replaceAll('任务包', '工作流')
    .replace(/没有分配给你/g, '未获授权给当前账户')
    .replace(/对你不可用/g, '对当前账户不可用');
}

/** Strip a trailing 。 so the renderer can add exactly one. */
export function stripSentenceEnd(text: string): string {
  return text.replace(/[。．]\s*$/u, '').trim();
}

/**
 * Next-step clause for the category sentence (no leading「下一步」). Member lines prefer the
 * owner’s 请… form; admin lines keep registry-backed wording from fixByRole.
 */
export function callErrorNext(code: string, role: 'admin' | 'user', fix: string | undefined): string {
  const raw = fix === undefined ? '' : stripSentenceEnd(fix);
  if (role === 'admin') {
    if (raw.length > 0) {
      return raw
        .replaceAll('任务包', '工作流')
        .replace(/把它分配给该成员/g, '为该账户或所在团队分配此工作流')
        .replace(/分配给你/g, '分配给该账户');
    }
    switch (code) {
      case 'SOURCE_NOT_PERMITTED':
        return '为该账户或所在团队分配此工作流，或分享读取权限';
      case 'LEASE_UNAVAILABLE':
        return '等待释放后重试，改订其他键，或按既有带理由规则强制释放';
      case 'SOURCE_INTEGRITY_UNPROVEN':
        return '从备份恢复原件并重验摘要，恢复后按原引用重读';
      default:
        return '核对后重试';
    }
  }

  if (code === 'SOURCE_NOT_PERMITTED') {
    if (/分配/.test(raw) || raw.length === 0) {
      return '请联系管理员为该账户或所在团队分配此工作流';
    }
    if (/分享|读取权限/.test(raw)) {
      return '请联系管理员分享读取权限，或为该账户分配相应工作流与技能';
    }
  }
  if (code === 'LEASE_UNAVAILABLE') {
    if (raw.length === 0 || /释放|等候|重试|别的键|其他/.test(raw)) {
      return '请等待释放后重试，或改订其他键；无期限预订可请主人按既有带理由规则处理';
    }
  }
  if (code === 'SOURCE_INTEGRITY_UNPROVEN') {
    return '请联系管理员从备份恢复原件并重验摘要，恢复后按原引用重读';
  }

  let next = raw
    .replaceAll('任务包', '工作流')
    .replace(/请管理员把它分配给你/g, '请联系管理员为该账户或所在团队分配此工作流')
    .replace(/请管理员给你分配/g, '请联系管理员为该账户分配')
    .replace(/请管理员分配/g, '请联系管理员分配')
    .replace(/分配给你/g, '分配给该账户')
    .replace(/看你能用的/g, '看当前账户能用的')
    .replace(/换一个你能读的/g, '换一个当前账户能读的');
  if (next.length === 0) return '请联系管理员处理';
  if (!/^请/.test(next)) next = `请${next}`;
  return next;
}

/** Full reader line when the code is a mapped call refusal; otherwise null. */
export function renderCallError(error: ProtocolError, role: 'admin' | 'user', fix: string | undefined): string | null {
  const category = callErrorCategoryOf(error.code);
  if (category === null) return null;
  const fact = callErrorFact(error.code, error.message);
  const next = callErrorNext(error.code, role, fix);
  return `${category}：${fact}。${next}。`;
}
