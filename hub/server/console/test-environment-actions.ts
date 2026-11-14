// Test-environment catalog ACTIONS (Boss 17:20 / Codex bed.register|assign|unassign).
// argv matches Codex CLI names; command-parameters registration lands when Codex merges that tip.
import { FormError, registerActions, word, type Action, type Form } from './manage.ts';
import { TEST_ENVIRONMENT_ACTIONS } from './test-environments.ts';

const BACK = '/console/connections?tab=environments';

function flag(name: string, value: string): string {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new FormError(`--${name} 的内容不能有控制字符`);
  return `--${name}=${value}`;
}

/** One form field that is either a booking prefix (ends with /) or an exact resource key. */
function prefixOrResourceFlag(form: Form): string {
  const raw = form.get('prefix_or_key').trim() || form.get('prefix').trim() || form.get('resource').trim();
  if (raw === '') throw new FormError('请填写前缀或键');
  if (raw.startsWith('-') || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > 512) {
    throw new FormError('前缀或键的写法不对');
  }
  return raw.endsWith('/') ? flag('prefix', raw) : flag('resource', raw);
}

/** Exactly one of 全体 / 团队 / 账户 (Codex bed.assign|unassign oneOf). */
function subjectFlags(form: Form): string[] {
  const all = form.get('all') === '1' || form.get('all') === 'true' || form.get('all') === 'on';
  const team = form.get('team').trim();
  const user = form.get('user').trim();
  const count = Number(all) + Number(team !== '') + Number(user !== '');
  if (count !== 1) throw new FormError('请选择全体、团队或账户之一');
  if (all) return ['--all'];
  if (team !== '') {
    if (team.startsWith('-') || /[\u0000-\u001f\u007f]/.test(team) || team.length > 512) {
      throw new FormError('团队的写法不对');
    }
    return [flag('team', team)];
  }
  if (user.startsWith('-') || /[\u0000-\u001f\u007f]/.test(user) || user.length > 512) {
    throw new FormError('账户的写法不对');
  }
  return [flag('user', user)];
}

export const TEST_ENVIRONMENT_MANAGE_ACTIONS: Readonly<Record<string, Action>> = {
  [TEST_ENVIRONMENT_ACTIONS.register]: {
    title: '登记测试环境',
    back: BACK,
    active: 'connections',
    build: (form) => {
      const name = word(form, 'name', '名字');
      const target = word(form, 'target', '目标');
      const executor = form.get('executor').trim();
      const owner = form.get('owner').trim();
      const argv = ['bed', 'register', name, flag('target', target), prefixOrResourceFlag(form)];
      if (executor !== '') {
        if (executor.startsWith('-') || /[\u0000-\u001f\u007f]/.test(executor) || executor.length > 512) {
          throw new FormError('执行器的写法不对');
        }
        argv.push(flag('executor', executor));
      }
      if (owner !== '') {
        if (owner.startsWith('-') || /[\u0000-\u001f\u007f]/.test(owner) || owner.length > 512) {
          throw new FormError('owner 的写法不对');
        }
        argv.push(flag('owner', owner));
      }
      return { argv };
    },
  },
  [TEST_ENVIRONMENT_ACTIONS.assign]: {
    title: '分配测试环境',
    back: BACK,
    active: 'connections',
    build: (form) => ({
      argv: ['bed', 'assign', word(form, 'environment', '测试环境名字'), ...subjectFlags(form)],
    }),
  },
  [TEST_ENVIRONMENT_ACTIONS.unassign]: {
    title: '撤回测试环境分配',
    back: BACK,
    active: 'connections',
    // Same force_release chain as executor-unassign (Boss 15:02).
    build: (form) => {
      const unassign = {
        argv: ['bed', 'unassign', word(form, 'environment', '测试环境名字'), ...subjectFlags(form)],
      };
      const keys = [...new Set(form.get('force_release').split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
      if (keys.length === 0) return unassign;
      const reason = form.get('release_reason').trim() || '管理员收回测试环境分配时强制释放';
      return [
        unassign,
        ...keys.map((key) => ({
          argv: ['lease', 'release', key, flag('reason', reason)],
        })),
      ];
    },
  },
};

registerActions(TEST_ENVIRONMENT_MANAGE_ACTIONS);
