import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENVIRONMENT, PERMISSION_ROLE } from '../../contracts/generated/vocabulary.ts';
import { COMMAND_PARAMETERS, buildCommandArgv, commandParameterHelp, commandParameterShape, commandParseOptions, parseCommandParameters } from './command-parameters.ts';
import { UsageError } from './errors.ts';

const team = 'tm_0123456789abcdefghjkmnpqrs';

test('parameter shapes are JSON data and vocabulary options come from generated axes', () => {
  for (const id of Object.keys(COMMAND_PARAMETERS) as Array<keyof typeof COMMAND_PARAMETERS>) {
    const shape = commandParameterShape(id);
    assert.deepEqual(JSON.parse(JSON.stringify(shape)), shape);
    assert.ok(shape.fields.every(field => field.description.length > 0));
  }
  assert.deepEqual(commandParameterShape('user.create').argumentSchema.properties.role.enum, [...PERMISSION_ROLE]);
  assert.deepEqual(commandParameterShape('resource.add').argumentSchema.properties.environment.enum, [...ENVIRONMENT]);
});

test('pack target forms generate the existing distinct argv layouts and reject mixed targets', () => {
  assert.deepEqual(buildCommandArgv('pack.assign', { user: '合成成员', pack: 'synthetic-flow' }), ['pack', 'assign', '合成成员', 'synthetic-flow']);
  assert.deepEqual(buildCommandArgv('pack.assign', { pack: 'synthetic-flow', team }), ['pack', 'assign', 'synthetic-flow', '--team=' + team]);
  assert.throws(() => buildCommandArgv('pack.assign', { user: '合成成员', pack: 'synthetic-flow', team }), UsageError);
  assert.throws(() => buildCommandArgv('pack.assign', { pack: 'synthetic-flow' }), UsageError);
  assert.match(commandParameterHelp('pack.assign'), /\(<账户> <工作流> \| <工作流> --team=<团队>\)/);
});

test('resource target forms retain explicit all/team selection and repeated configuration flags', () => {
  assert.deepEqual(buildCommandArgv('resource.assign', { resource: 'synthetic-resource', all: true }), ['resource', 'assign', 'synthetic-resource', '--all']);
  assert.deepEqual(buildCommandArgv('resource.assign', { resource: 'synthetic-resource', team, all: false }), ['resource', 'assign', 'synthetic-resource', '--team=' + team]);
  for (const values of [{ resource: 'synthetic-resource' }, { resource: 'synthetic-resource', team, all: true }]) assert.throws(() => buildCommandArgv('resource.assign', values), UsageError);
  const argv = buildCommandArgv('resource.add', { 'system-pack': 'synthetic-system@1.0.0', name: '合成资源', environment: ENVIRONMENT[0], origin: ['first=http://192.0.2.1', 'second=https://192.0.2.2'], credential: ['password=API_SECRET'] });
  assert.equal(argv.filter(argument => argument.startsWith('--origin=')).length, 2);
  assert.ok(argv.includes('--credential=password=API_SECRET'));
  assert.deepEqual((parseCommandParameters('resource.add', argv.slice(2)).values as { origin?: string[] }).origin, ['first=http://192.0.2.1', 'second=https://192.0.2.2']);
});

test('secret values stay out of argument forms and argv; stdin bindings use the actual secret reader keys', () => {
  const shape = commandParameterShape('secret.set');
  assert.deepEqual(shape.stdin, [{ keysFromOption: 'name', sensitive: true, description: '每个命名密钥对应一个 readSecret(name) 输入；绝不进入 argv 或公开形状' }]);
  assert.deepEqual(buildCommandArgv('secret.set', { name: ['API_SECRET'], reason: '合成设置' }), ['secret', 'set', '--name=API_SECRET', '--reason=合成设置']);
  assert.throws(() => buildCommandArgv('secret.set', { name: ['API_SECRET'], reason: '合成设置', value: 'MustNotEnterArguments42' }), error => error instanceof UsageError && !error.message.includes('MustNotEnterArguments42'));
  assert.throws(() => buildCommandArgv('secret.unset', { name: ['FIRST_SECRET', 'SECOND_SECRET'], reason: '合成撤回' }), UsageError);
  assert.equal(commandParameterShape('init-admin').stdin[0].key, '管理员密码');
});

test('dynamic choices are supplied as data and cannot replace generated role or environment sets', () => {
  const shapes = commandParameterShape('team.add', { team: [{ value: team, label: '合成团队' }], user: [{ value: '合成成员', label: '合成成员' }] });
  assert.deepEqual(shapes.argumentSchema.properties.team.enum, [team]);
  assert.deepEqual(commandParameterShape('user.create', { role: [{ value: 'invented', label: '无效' }] }).argumentSchema.properties.role.enum, [...PERMISSION_ROLE]);
});

test('CLI adapters retain lexical option kinds, multiplicity and positional arity without business side effects', () => {
  assert.deepEqual(commandParseOptions('pack.publish'), { stage: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'answer-request': { type: 'string', multiple: true } });
  const parsed = parseCommandParameters('pack.publish', ['synthetic-directory', '--dry-run', '--answer-request=first', '--answer-request=second']);
  assert.equal(parsed.values['dry-run'], true);
  assert.deepEqual(parsed.values['answer-request'], ['first', 'second']);
  assert.throws(() => parseCommandParameters('team.add', [team]), UsageError);
  assert.throws(() => parseCommandParameters('team.list', ['extra']), UsageError);
  assert.throws(() => parseCommandParameters('token.issue', ['合成成员', '--misspelled']), UsageError);
  assert.ok(commandParameterHelp('knowledge.sync').includes('--max-age'));
  assert.equal(commandParameterShape('executor.add').fields.some(field => field.name === 'secret'), false);
});
