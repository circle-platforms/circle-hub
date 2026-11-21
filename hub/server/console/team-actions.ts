import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { UsageError } from '../errors.ts';
import { COMMAND_PARAMETERS } from '../command-parameters.ts';
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

export const TEAMS = '/console/team';

function flag(name: string, value: string): string {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new FormError(`--${name} 的内容不能有控制字符`);
  return `--${name}=${value}`;
}

const resourceAssignOptions = COMMAND_PARAMETERS['resource.assign'].options;
type ResourceAssignOption = keyof typeof resourceAssignOptions;
const assignOption = <K extends ResourceAssignOption>(name: K): K => name;

export const RESOURCE_AUDIENCE = {
  all: assignOption('all'),
  team: assignOption('team'),
  none: 'none',
} as const;
export type ResourceAudience = (typeof RESOURCE_AUDIENCE)[keyof typeof RESOURCE_AUDIENCE];

export const RESOURCE_AUDIENCE_OPTIONS: readonly { value: ResourceAudience; label: string }[] = [
  { value: RESOURCE_AUDIENCE.all, label: '全体' },
  { value: RESOURCE_AUDIENCE.team, label: '某团队' },
  { value: RESOURCE_AUDIENCE.none, label: '先不分配' },
];

export const SYSTEM_ADD_AUDIENCE_HINT =
  '没有分配时对谁都不开放。可选全体、某个团队，或先不分配、接入后再分配。';

function resourceTarget(form: Form): string[] {
  const audience = form.get('audience');
  if (audience === RESOURCE_AUDIENCE.all) return ['--all'];
  if (audience === RESOURCE_AUDIENCE.none) throw new FormError('先不分配时不要提交分配');
  return [flag('team', word(form, 'team', '团队'))];
}

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
    build: (form) => {
      const team = flag('team', word(form, 'team', '团队'));
      const packs = form.get('packs').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const list = packs.length > 0 ? packs : [word(form, 'pack', uiLabelOf('pack_kind', 'workflow'))];
      return list.map((pack) => ({ argv: ['pack', 'assign', pack, team] }));
    },
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
    title: '分配业务系统',
    back: TEAMS,
    active: 'team',
    build: (form) => {
      const listed = form.get('resources').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const list = listed.length > 0 ? listed : [word(form, 'resource', '业务系统')];
      const target = resourceTarget(form);
      return list.map((resource) => ({ argv: ['resource', 'assign', resource, ...target] }));
    },
  },
  'resource-unassign': {
    title: '撤回业务系统分配',
    back: TEAMS,
    active: 'team',
    build: (form) => ({
      argv: ['resource', 'unassign', word(form, 'resource', '业务系统'), ...resourceTarget(form)],
    }),
  },
};

registerActions(TEAM_ACTIONS);
