import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { VaultReadinessError } from '../../records/api.ts';
import { openTestRecords } from '../../testing/records.ts';
import type { HubConfig } from '../../config/index.ts';
import { assembleHub } from './hub.ts';

const configOf = (kit: Awaited<ReturnType<typeof openTestRecords>>): HubConfig => ({
  dataDir: kit.dataDir, logDir: join(kit.dataDir, 'logs'), host: '127.0.0.1', port: 0,
  database: kit.database, limits: { ...kit.config.limits },
});

test('an unindexed scratch ciphertext permits management assembly but never primes a partial redactor', async () => {
  const kit = await openTestRecords();
  try {
    const value = randomBytes(24).toString('base64url');
    await kit.vault.put('secret.demo_unindexed.' + 'a'.repeat(24), value);
    const by = (await kit.principals.bootstrapAdmin('合成启动管理员')).user;
    let fetches = 0;
    const logs: string[] = [];
    const hub = await assembleHub(configOf(kit), kit, { requireOsIsolation: false, leases: null, log: line => logs.push(line), fetch: async () => { fetches++; throw new Error('unexpected synthetic fetch'); } });
    assert.equal(hub.notices.length, 1);
    assert.match(hub.notices[0], /脱敏材料/);
    assert.match(logs.join('\n'), /DEMO_UNINDEXED/);
    assert.match(logs.join('\n'), /version/);
    assert.match(logs.join('\n'), /下一步/);
    assert.equal(hub.deps.startupSecretIssues?.()[0]?.name, 'DEMO_UNINDEXED');
    assert.ok(![...hub.notices, ...logs].join('').includes(value));
    assert.deepEqual(await hub.registry.listPacks(), []);
    assert.deepEqual(await hub.resources.list(by), []);
    await assert.rejects(hub.connectors.primeSecrets(), VaultReadinessError);
    assert.equal(fetches, 0);
  } finally { await kit.close(); }
});

test('an unexpected priming failure still refuses assembly instead of becoming a readiness notice', async () => {
  const kit = await openTestRecords();
  try {
    const sentinel = new Error('synthetic implementation failure');
    kit.variables.recentSecrets = async () => { throw sentinel; };
    await assert.rejects(assembleHub(configOf(kit), kit, { requireOsIsolation: false, leases: null, log: () => {} }), error => error === sentinel);
  } finally { await kit.close(); }
});
