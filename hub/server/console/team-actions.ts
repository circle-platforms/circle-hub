// Team management ACTIONS for the command bridge (interfaces §2). Shapes stay here; manage.registerActions installs them.
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { UsageError } from '../errors.ts';
import { buildRegisteredAction } from './command-form.ts';
import { FormError, registerActions, word, type Action, type Form } from './manage.ts';

function fromRegistration(action: 'team-create' | 'team-delete' | 'team-add' | 'team-remove', form: Form) {
  try {
    return buildRegisteredAction(action, form);
  } catch (error) {
    if (error instanceof UsageError) throw new FormError(error.message);
    throw error;
  }
}

/** Result-page back link and nav highlight for team ACTIONS (interfaces §5.2). */
export const TEAMS = '/console/team';

/** `--flag=value`: the value may start with `-`, it is never read as another flag. */
function flag(name: string, value: string): string {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new FormError(`--${name} 的内容不能有控制字符`);
  return `--${name}=${value}`;
}

/** Audience choices for assigning a newly connected business system (decision 6). Packs owns system-add; copy lives here. */
export const RESOURCE_AUDIENCE = {
  all: 'all',
  team: 'team',
  none: 'none',
} as const;
export type ResourceAudience = (typeof RESOURCE_AUDIENCE)[keyof typeof RESOURCE_AUDIENCE];

export const RESOURCE_AUDIENCE_OPTIONS: readonly { value: ResourceAudience; label: string }[] = [
  { value: RESOURCE_AUDIENCE.all, label: '全体' },
  { value: RESOURCE_AUDIENCE.team, label: '某团队' },
  { value: RESOURCE_AUDIENCE.none, label: '先不分配' },
];

/** Hint for the system-add form's audience step (packs owns the form; do not edit operations.ts here). */
export const SYSTEM_ADD_AUDIENCE_HINT =
  '没有分配时对谁都不开放。可选全体、某个团队，或先不分配、接入后再分配。';

function resourceTarget(form: Form): string[] {
  const audience = form.get('audience');
  if (audience === RESOURCE_AUDIENCE.all) return ['--all'];
  if (audience === RESOURCE_AUDIENCE.none) throw new FormError('先不分配时不要提交分配');
  return [flag('team', word(form, 'team', '团队'))];
}

/** Keys for manage.ACTIONS; api registers them without editing this file's shapes. */
export const TEAM_ACTIONS: Readonly<Record<string, Action>> = {
  'team-create': {
    title: '新建团队',
    back: TEAMS,
    active: 'team',
    build: (form) => fromRegistration('team-create', form),
  },
  'team-delete': {
    title: '删除团队',
    back: TEAMS,
    active: 'team',
    build: (form) => fromRegistration('team-delete', form),
  },
  'team-add': {
    title: '加入成员',
    back: TEAMS,
    active: 'team',
    build: (form) => fromRegistration('team-add', form),
  },
  'team-remove': {
    title: '移出成员',
    back: TEAMS,
    active: 'team',
    build: (form) => fromRegistration('team-remove', form),
  },
  'pack-assign-team': {
    title: '分配工作流给团队',
    back: TEAMS,
    active: 'team',
    build: (form) => ({
      argv: ['pack', 'assign', word(form, 'pack', uiLabelOf('pack_kind', 'workflow')), flag('team', word(form, 'team', '团队'))],
    }),
  },
  'pack-unassign-team': {
    title: '撤回团队的工作流',
    back: TEAMS,
    active: 'team',
    build: (form) => ({
      argv: ['pack', 'unassign', word(form, 'pack', uiLabelOf('pack_kind', 'workflow')), flag('team', word(form, 'team', '团队'))],
    }),
  },
  'resource-assign': {
    title: '分配资源',
    back: '/console/connections',
    active: 'connections',
    build: (form) => ({
      argv: ['resource', 'assign', word(form, 'resource', '资源'), ...resourceTarget(form)],
    }),
  },
  'resource-unassign': {
    title: '撤回资源分配',
    back: '/console/connections',
    active: 'connections',
    build: (form) => ({
      argv: ['resource', 'unassign', word(form, 'resource', '资源'), ...resourceTarget(form)],
    }),
  },
};

registerActions(TEAM_ACTIONS);
