// Audience descriptions are derived from current enabled accounts and the union of inherited grants.
import { uiLabelOf, type KnowledgeGrantee } from '../../../contracts/generated/vocabulary.ts';
import type { User } from '../../records/api.ts';
export interface AudienceGrant { path?: string; audience: KnowledgeGrantee; member: string | null }
export function directoryName(path: string): string { return path.split('/').filter(Boolean).join(' › ') || '整个个人空间'; }
export const containsDirectory = (parent: string, path: string) => parent === '/' || parent === path || path.startsWith(parent + '/');
export function describeAudience(input: { owner: string; viewer: string; ownerName: string; path?: string; product?: boolean; grants?: readonly AudienceGrant[]; users?: readonly User[] }): { text: string; inherited: string[]; members: string[] } {
  const { owner, viewer, ownerName, path = '/', users = [] } = input;
  if (owner === 'team') return {text: uiLabelOf('audience_scope', input.product ? 'product' : 'team'), inherited: [], members: []};
  if (owner !== viewer) return {text: uiLabelOf('audience_scope', 'received').replace('{name}', ownerName), inherited: [], members: []};
  const grants = (input.grants ?? []).filter(g => containsDirectory(g.path ?? '/', path));
  const admins = users.filter(u => !u.disabled && u.role === 'admin' && u.id !== owner);
  const allAdmins = grants.some(g => g.audience === 'administrators');
  const members = users.filter(u => !u.disabled && u.id !== owner && grants.some(g => g.audience === 'member' && g.member === u.id) && !(allAdmins && u.role === 'admin'));
  const text = uiLabelOf('audience_scope', allAdmins ? members.length ? 'combined' : 'administrators' : members.length ? 'members' : 'owner')
    .replace('{n}', String(allAdmins ? admins.length : members.length)).replace('{m}', String(members.length));
  return {text, members: [...members, ...(allAdmins ? admins : [])].map(u => u.name), inherited: [...new Set(grants.filter(g => g.path && g.path !== path).map(g => g.path!))]};
}
