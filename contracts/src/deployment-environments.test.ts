import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DeploymentDefinition, DEPLOYMENT_SCHEMA, SCHEMA_REGISTRY } from '../api.ts';
import { DeploymentTestEnvironment, DeploymentEnvironmentAssignment } from './deployment.ts';

const at = '2026-11-14T16:30:00.000Z';
const environment = () => ({
  name: '合成测试环境', target: 'synthetic-target',
  prefixes: [{ prefix: 'synthetic/a/', owner: '甲责任人' }, { prefix: 'synthetic/b/', owner: '乙责任人' }],
  resources: [{ key: 'synthetic/device/a', owner: '丙责任人' }],
  executors: ['合成执行器一', '合成执行器二'], enabled: false,
});

test('the public definition is version three only with no legacy registration decoder', () => {
  assert.equal(DEPLOYMENT_SCHEMA, 'deployment@3');
  assert.equal(SCHEMA_REGISTRY['deployment@3'], DeploymentDefinition);
  assert.equal(SCHEMA_REGISTRY['deployment@2'], undefined);
  for (const schema of ['deployment@1', 'deployment@2', 'deployment@4']) assert.equal(DeploymentDefinition.safeParse({ schema }).success, false);
  assert.equal(DeploymentDefinition.safeParse({ schema: DEPLOYMENT_SCHEMA, leaseRegistrations: [] }).success, false);
  const parsed = DeploymentDefinition.parse({ schema: DEPLOYMENT_SCHEMA });
  assert.deepEqual(parsed.testEnvironments, []);
  assert.deepEqual(parsed.environmentAssignments, []);
  assert.equal('leaseRegistrations' in parsed, false);
});

test('portable environments preserve every prefix owner, exact key owner and executor name without importing registration events', () => {
  const source = environment();
  assert.deepEqual(DeploymentTestEnvironment.parse(source), source);
  const definition = DeploymentDefinition.parse({ schema: DEPLOYMENT_SCHEMA, testEnvironments: [source] });
  assert.deepEqual(definition.testEnvironments, [source]);
  assert.deepEqual(DeploymentDefinition.parse(JSON.parse(JSON.stringify(definition))), definition, 'serialization does not collapse distinct registration owners');
  assert.equal(DeploymentTestEnvironment.safeParse({ ...source, resources: [] }).success, true);
  assert.equal(DeploymentTestEnvironment.safeParse({ ...source, prefixes: [] }).success, true);
  assert.equal(DeploymentTestEnvironment.safeParse({ ...source, prefixes: [{ ...source.prefixes[0], registered_at: at }] }).success, false, 'new registration timestamps are owned by the importing transaction');
});

test('unknown canonical registrations and internal identities cannot masquerade as portable names', () => {
  const source = environment();
  for (const bad of [
    { ...source, target: null }, { ...source, name: null }, { ...source, id: 'env_0' + 'a'.repeat(25) },
    { ...source, prefixes: [{ ...source.prefixes[0], owner: null }] },
    { ...source, resources: [{ ...source.resources[0], registered_at: null }] },
    { ...source, executors: ['exe_0' + 'a'.repeat(25)] },
    { ...source, prefixes: [{ ...source.prefixes[0], owner: 'usr_0' + 'a'.repeat(25) }] },
    { ...source, name: 'env_0' + 'a'.repeat(25) }, { ...source, owner: '单一责任人' },
  ]) assert.equal(DeploymentTestEnvironment.safeParse(bad).success, false);
});

test('assignments preserve each subject kind and exact expiry without expanding memberships', () => {
  const assignments = [
    { environment: '合成测试环境', user: '甲成员', expiresAt: '2026-12-01T00:00:00.000Z' },
    { environment: '合成测试环境', team: '合成团队', expiresAt: null },
    { environment: '合成测试环境', all: true, expiresAt: '2020-01-01T00:00:00.000Z' },
  ];
  const definition = DeploymentDefinition.parse({ schema: DEPLOYMENT_SCHEMA, testEnvironments: [environment()], environmentAssignments: assignments });
  assert.deepEqual(definition.environmentAssignments, assignments, 'past/finite expiry is retained rather than renewed or made permanent');
  assert.equal(DeploymentEnvironmentAssignment.parse({ environment: '合成测试环境', all: true }).expiresAt, null);
  for (const bad of [
    { environment: '合成测试环境', user: '甲成员', team: '合成团队' },
    { environment: '合成测试环境', all: false }, { environment: 'env_0' + 'a'.repeat(25), all: true },
    { environment: '合成测试环境', user: '甲成员', expiresAt: 'not-a-time' },
  ]) assert.equal(DeploymentEnvironmentAssignment.safeParse(bad).success, false);
});

test('duplicate environment identity or recipient and duplicate registration declarations are rejected', () => {
  const source = environment();
  for (const other of [{ ...source }, { ...source, name: '另一个名字' }]) assert.equal(DeploymentDefinition.safeParse({ schema: DEPLOYMENT_SCHEMA, testEnvironments: [source, other] }).success, false);
  const assignment = { environment: source.name, user: '甲成员', expiresAt: null };
  assert.equal(DeploymentDefinition.safeParse({ schema: DEPLOYMENT_SCHEMA, environmentAssignments: [assignment, { ...assignment, expiresAt: at }] }).success, false);
  for (const bad of [{ ...source, prefixes: [...source.prefixes, source.prefixes[0]] }, { ...source, resources: [...source.resources, source.resources[0]] }, { ...source, executors: ['同名', '同名'] }, { ...source, prefixes: [], resources: [] }]) assert.equal(DeploymentTestEnvironment.safeParse(bad).success, false);
});

test('model revision 83 records the deployment decision without replacing historical reset approval', () => {
  const model = JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8'));
  assert.ok(model.version >= 83);
  const byId = (id: string) => model.elements.find((element: { id: string }) => element.id === id);
  assert.ok(byId('B04').changes83.some((text: string) => text.includes('16:56') && text.includes('deployment@3')));
  assert.ok(byId('D04').changes79.some((text: string) => text.includes('17:15') && text.includes('18:50')));
});
