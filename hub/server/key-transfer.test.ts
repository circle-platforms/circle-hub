import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FileKeyProvider, FileVault } from '../records/vault.ts';
import type { AssemblyModule } from './api.ts';
import { adminCommands } from './cli-admin.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { openCliHarness, type CliHarness } from './assemble/test-cli.ts';

const harness: CliHarness = await openCliHarness();
after(() => harness.close());

test('records verify decrypts every vault entry and prints only the count', async () => {
  const admin = await harness.deployment();
  const created = await admin.run(['user', 'create', '根管理员', '--role', 'admin']);
  assert.equal(created.code, 0);
  const secret = `synthetic-${randomBytes(8).toString('hex')}`;
  const vault = new FileVault(join(admin.dataDir, 'vault'), admin.key);
  await vault.put('agile.token', secret);
  const assembly = async (): Promise<AssemblyModule> => ({
    assemble: () => { throw new Error('records verify does not assemble a server'); },
    registerCommands(register) {
      for (const command of adminCommands({ tokens: () => memoryOperatorTokens(null, '测试的空钥匙串') })) register(command);
    },
  });
  const verified = await admin.run(['records', 'verify'], { assembly });
  assert.match(verified.text, /密库条目 1 个，全部能用当前主密钥解开/);
  assert.equal(verified.text.includes(secret), false);
  const wrong = new FileKeyProvider(join(harness.scratch, 'wrong.key'));
  await wrong.initKey();
  const failed = await admin.run(['records', 'verify'], { assembly, keyProvider: () => wrong });
  assert.equal(failed.code, 1);
  assert.equal(failed.text.includes(secret), false);
  assert.match(failed.text, /密钥与密钥库不符|无法解开/);
});
