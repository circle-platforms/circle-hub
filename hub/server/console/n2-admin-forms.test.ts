import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REGISTERED_ACTIONS,
  UPLOAD_REFERENCE_ACTIONS,
  buildRegisteredAction,
  commandFields,
  registeredActionForm,
} from './command-form.ts';
import { ACTIONS } from './manage.ts';
import { TEAM_ACTIONS } from './team-actions.ts';

const formOf = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? '' });

test('N2 registered actions cover member, pack install, and environment registration commands', () => {
  for (const action of [
    'user-invite', 'token-issue', 'password-reset', 'user-disable', 'user-enable',
    'pack-install', 'pack-uninstall', 'pack-activate', 'pack-deactivate', 'pack-retire',
    'executor-add', 'executor-assign', 'doc-put',
  ] as const) {
    assert.equal(typeof REGISTERED_ACTIONS[action], 'string');
    assert.ok(Object.hasOwn(ACTIONS, action), action);
  }
  assert.ok(UPLOAD_REFERENCE_ACTIONS.has('executor-add'));
  assert.ok(UPLOAD_REFERENCE_ACTIONS.has('doc-put'));
});

test('pack install and executor assign build argv from the command registry', () => {
  assert.deepEqual(
    buildRegisteredAction('pack-install', formOf({ pack: 'synth-skill@1.0.0' })),
    { argv: ['pack', 'install', 'synth-skill@1.0.0'] },
  );
  assert.deepEqual(
    buildRegisteredAction('executor-assign', formOf({ executor: 'exe_synthetic', team: 'tm_0123456789abcdefghjkmnpqrs' })),
    { argv: ['executor', 'assign', 'exe_synthetic', '--team=tm_0123456789abcdefghjkmnpqrs'] },
  );
  assert.deepEqual(
    buildRegisteredAction('doc-put', formOf({ name: 'bed-topology', reference: 'src:' + 'a'.repeat(64) })),
    { argv: ['doc', 'put', 'bed-topology', '--reference=src:' + 'a'.repeat(64)] },
  );
});

test('member invite and team batch assign forms post to admin actions', () => {
  const invite = String(registeredActionForm('user-invite', 'csrf', '签发', { values: { user: 'usr_synthetic' } }));
  assert.match(invite, /action="\/console\/admin\/do\/user-invite"/);
  assert.match(invite, /name="user" value="usr_synthetic"/);
  assert.match(String(commandFields('pack.install', {}, { pack: 'x@1' })), /通用技能版本/);
  const batch = TEAM_ACTIONS['pack-assign-team'].build(formOf({
    team: 'tm_0123456789abcdefghjkmnpqrs',
    packs: 'flow-a\nflow-b',
  }));
  assert.ok(Array.isArray(batch));
  assert.deepEqual(batch, [
    { argv: ['pack', 'assign', 'flow-a', '--team=tm_0123456789abcdefghjkmnpqrs'] },
    { argv: ['pack', 'assign', 'flow-b', '--team=tm_0123456789abcdefghjkmnpqrs'] },
  ]);
});

test('operations page wording no longer claims only four actions', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('./operations.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /只执行这四种管理操作/);
  assert.match(source, /经同一命令通道写入/);
});
