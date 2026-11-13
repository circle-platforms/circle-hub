import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VaultReadinessError } from '../records/api.ts';
import { secretUseLabels, type SecretUseLabelReaders } from './secret-use-labels.ts';

const by = { id: 'usr_0123456789abcdefghjkmnpqrs', name: '合成管理员', role: 'admin' as const };

test('secret use labels query only the exact vault name, version and ciphertext identity without reading containers or record decisions', async () => {
  const queried: string[] = [];
  const forbidden = () => { throw new Error('must not read values or record decisions'); };
  const readers = {
    variables: { history: async () => forbidden() },
    vault: { secretIdentity: async (name: string) => { queried.push(name); return { name, version: 3, sealed_sha256: 'a'.repeat(64) }; }, getText: forbidden, readSecret: forbidden },
  };
  const labels = await secretUseLabels(readers, by, [{ kind: 'secret', name: 'API_SECRET', version: 3, sealed_sha256: 'a'.repeat(64), at: 'synthetic-executor#/credential' }]);
  assert.deepEqual(queried, ['API_SECRET']);
  assert.deepEqual(labels, ['API_SECRET 第 3 版']);
  assert.ok(!labels.join('').includes('rec:'));
});

test('missing secret metadata preserves the recorded version and discloses unknown instead of substituting a current version', async () => {
  const readers: SecretUseLabelReaders = { variables: { history: async () => [] }, vault: { secretIdentity: async name => ({ name, version: 8, sealed_sha256: 'a'.repeat(64) }) } };
  assert.deepEqual(await secretUseLabels(readers, by, [{ kind: 'secret', name: 'API_SECRET', version: 3, sealed_sha256: 'a'.repeat(64), at: 'synthetic-executor#/credential' }]), ['API_SECRET 第 3 版（密钥库元数据未知）']);
});

test('ordinary variable labels still resolve actual record decisions and never synthesize version zero', async () => {
  const digest = 'a'.repeat(64), names: string[] = [];
  const readers: SecretUseLabelReaders = { variables: { history: async (_by, _kind, name) => { names.push(name); return name === 'KNOWN_VALUE' ? [{ version: 2, decision: { digest } }] : []; } }, vault: { secretIdentity: async () => { throw new Error('ordinary variables do not query the vault'); } } };
  const labels = await secretUseLabels(readers, by, [{ kind: 'var', name: 'KNOWN_VALUE', decision: digest, at: 'synthetic-executor#/setting' }, { kind: 'var', name: 'MISSING_VALUE', decision: digest, at: 'synthetic-executor#/setting' }]);
  assert.deepEqual(names, ['KNOWN_VALUE', 'MISSING_VALUE']);
  assert.deepEqual(labels, ['KNOWN_VALUE 第 2 版', 'MISSING_VALUE 版本未知']);
});

test('a replacement with the same name and ordinal cannot supply the prior ciphertext metadata label', async () => {
  const readers: SecretUseLabelReaders = { variables: { history: async () => [] }, vault: { secretIdentity: async name => ({ name, version: 1, sealed_sha256: 'b'.repeat(64) }) } };
  assert.deepEqual(await secretUseLabels(readers, by, [{ kind: 'secret', name: 'API_SECRET', version: 1, sealed_sha256: 'a'.repeat(64), at: 'synthetic-executor#/credential' }]), ['API_SECRET 第 1 版（密钥库元数据未知）']);
});

test('unavailable authenticated metadata stays unknown while unexpected reader failures propagate', async () => {
  const uses = [{ kind: 'secret' as const, name: 'API_SECRET', version: 1, sealed_sha256: 'a'.repeat(64), at: 'synthetic-executor#/credential' }];
  const readers: SecretUseLabelReaders = { variables: { history: async () => [] }, vault: { secretIdentity: async () => { throw new VaultReadinessError([{ name: 'API_SECRET', entry: null, missing: ['metadata'], reason: '合成缺失', next_action: '合成恢复' }]); } } };
  assert.deepEqual(await secretUseLabels(readers, by, uses), ['API_SECRET 第 1 版（密钥库元数据未知）']);
  const sentinel = new Error('synthetic implementation failure');
  readers.vault.secretIdentity = async () => { throw sentinel; };
  await assert.rejects(secretUseLabels(readers, by, uses), error => error === sentinel);
});
