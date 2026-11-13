import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VaultReadinessError, VariableError, VaultError } from '../../records/api.ts';
import { primeStartupSecrets } from './secret-readiness.ts';

test('startup catches only declared readiness errors and retains every administrator issue separately', async () => {
  const issues = Array.from({ length: 18 }, (_, i) => ({ name: `DEMO_KEY_${i}`, entry: `secret.demo_key_${i}`, missing: ['metadata', 'version'], reason: '认证元数据缺失', next_action: '由管理员恢复认证元数据或显式设置密钥' }));
  const notices: string[] = [], logs: string[] = [];
  const observed = await primeStartupSecrets({ primeSecrets: async () => { throw new VaultReadinessError(issues); } }, notices, line => logs.push(line));
  assert.deepEqual(observed, issues);
  assert.equal(notices.length, 1);
  assert.equal(logs.length, 18);
  for (const issue of issues) assert.ok(logs.some(line => line.includes(issue.name) && line.includes(issue.next_action)));
  assert.ok(!notices[0].includes('DEMO_KEY_'));
});

test('unrelated errors remain fatal and are not logged as secret availability', async () => {
  for (const error of [new Error('program sentinel'), new TypeError('program sentinel'), new VariableError('other variable failure'), new VaultError('other vault failure')]) {
    const notices: string[] = [], logs: string[] = [];
    await assert.rejects(primeStartupSecrets({ primeSecrets: async () => { throw error; } }, notices, line => logs.push(line)), value => value === error);
    assert.deepEqual(notices, []); assert.deepEqual(logs, []);
  }
});
