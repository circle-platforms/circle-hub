import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENVIRONMENT } from '../../../contracts/generated/vocabulary.ts';
import {
  REGISTERED_ACTIONS,
  buildRegistered,
  buildRegisteredAction,
  commandFields,
  registeredActionForm,
  valuesFromForm,
} from './command-form.ts';

const formOf = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? '' });

test('registered actions cover the onboarding commands that map 1:1', () => {
  assert.ok(Object.keys(REGISTERED_ACTIONS).length >= 18);
  assert.equal(REGISTERED_ACTIONS['knowledge-sync'], 'knowledge.sync');
  assert.equal(REGISTERED_ACTIONS['secret-set'], 'secret.set');
  assert.equal(REGISTERED_ACTIONS['team-create'], 'team.create');
});

test('commandFields render labels and keep secret values out of the argument shape', () => {
  const text = String(commandFields('secret.set'));
  assert.match(text, /密钥名/);
  assert.match(text, /理由/);
  assert.match(text, /type="password"/);
  assert.match(text, /name="value"/);
  assert.doesNotMatch(text, /MustNotAppear/);
});

test('registeredActionForm posts to the matching admin action', () => {
  const text = String(registeredActionForm('team-create', 'csrf-token', '新建'));
  assert.match(text, /action="\/console\/admin\/do\/team-create"/);
  assert.match(text, /name="csrf" value="csrf-token"/);
  assert.match(text, /团队名/);
});

test('valuesFromForm and buildRegistered produce argv without secrets', () => {
  assert.deepEqual(
    buildRegisteredAction('knowledge-sync', formOf({ product: 'synthetic-product', 'dry-run': '1' })),
    { argv: ['knowledge', 'sync', '--product=synthetic-product', '--dry-run'] },
  );
  assert.deepEqual(
    buildRegistered('pack.assign', formOf({ user: '合成成员', pack: 'synthetic-flow' })),
    { argv: ['pack', 'assign', '合成成员', 'synthetic-flow'] },
  );
  const secret = buildRegisteredAction('secret-set', formOf({ name: 'API_SECRET', reason: '合成设置', value: 'MustNotEnterArguments42' }));
  assert.deepEqual(secret.argv, ['secret', 'set', '--name=API_SECRET', '--reason=合成设置']);
  assert.deepEqual(secret.secrets, { API_SECRET: 'MustNotEnterArguments42' });
  assert.ok(!JSON.stringify(secret.argv).includes('MustNotEnterArguments42'));
});

test('environment choices for resource.add stay on the generated vocabulary', () => {
  const values = valuesFromForm('resource.add', formOf({
    'system-pack': 'synthetic-system@1.0.0',
    name: '合成资源',
    environment: ENVIRONMENT[0],
    origin: 'api=http://192.0.2.1',
  }));
  assert.equal(values.environment, ENVIRONMENT[0]);
  assert.deepEqual(values.origin, ['api=http://192.0.2.1']);
});
