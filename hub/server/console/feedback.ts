// Success messages after a console action: what was done, written as a fact (shared design system, 文字), never a
// generic "done". They are set only after the action returned; a refused action shows its own error page instead.
import { emptyAction } from './html.ts';
import { KnowledgeGranteeSchema, isKnowledgeGrantAction, uiLabelOf, type KnowledgeShareStatus, type KnowledgeView } from '../../../contracts/generated/vocabulary.ts';

/** The empty list of shares to the team, the same wherever it appears. */
export const NO_TEAM_SHARES = { title: '还没有分享到团队的内容', text: '我的已验证条目分享到团队后，每次检查的结果列在这里。', action: emptyAction('/console/knowledge', '打开我的知识', { scope: 'personal' }) };

type Values = { get(key: string): string | null | undefined };

/** Shares are receipts: merged ones are on the team, rejected ones are not; both are counted. */
export function shareFeedback(receipts: readonly { status: KnowledgeShareStatus }[]): string {
  const merged = receipts.filter((receipt) => receipt.status === 'merged').length, rejected = receipts.length - merged;
  const refused = `${uiLabelOf('knowledge_share_status', 'rejected')} ${rejected} 条`;
  if (rejected === 0) return `已分享到团队 · ${merged} 条`;
  return merged === 0 ? `未分享到团队 · ${refused}` : `已分享到团队 · ${merged} 条；${refused}`;
}

const lastName = (path: string | null | undefined): string => (path ?? '').split('/').filter(Boolean).at(-1) ?? '';

function grantNotice(action: string, values: Values): string {
  if (action === 'revoke') return '已收回分享';
  if (values.get('audience') === KnowledgeGranteeSchema.enum.administrators) return '已分享给' + uiLabelOf('knowledge_grantee', 'administrators');
  const member = values.get('member');
  // A space only before Latin letters or digits, as the wording rules ask.
  return member ? '已分享给' + (/^[A-Za-z0-9]/.test(member) ? ' ' : '') + member : '已分享给' + uiLabelOf('knowledge_grantee', 'member');
}

/** The message for a knowledge, memory or personal-pack action that returned; null when the action names none. */
export function actionNotice(area: KnowledgeView | 'packs', action: string, values: Values, upload?: { name: string }): string | null {
  if (isKnowledgeGrantAction(action)) return grantNotice(action, values);
  if (area === 'memory') {
    if (action !== 'write') return null;
    const enabled = values.get('enabled');
    if (enabled === 'false') return '已停用记忆';
    if (enabled === 'true') return '已启用记忆';
    return values.get('document') ? '已保存记忆' : '已新建记忆';
  }
  if (area === 'packs') {
    const done: Record<string, string> = { stage: '已暂存发布内容', discard: '已丢弃暂存内容', publish: '已发布', promote: '已发布到团队', retire: '已退役这个版本' };
    return done[action] ?? null;
  }
  switch (action) {
    case 'entry': return values.get('replaces') ? '已更新条目' : '已保存条目';
    case 'directory': return lastName(values.get('path')) ? `已新建文件夹 · ${lastName(values.get('path'))}` : '已新建文件夹';
    case 'withdraw': return '已撤回条目';
    case 'import': case 'import-source': return upload?.name ? `已导入原文 · ${upload.name}` : '已导入原文';
    case 'save-source': return '已保存到我的原文';
    case 'attribute-source': return '已确认为团队来源';
    case 'quota': return '已调整容量';
    default: return null;
  }
}
