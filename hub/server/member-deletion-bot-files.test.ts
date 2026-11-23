import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemberDeletionBody } from '../../contracts/src/spaces.ts';
import { FileKeyProvider } from '../records/index.ts';
import { startPostgres } from '../testing/postgres.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { main } from './cli.ts';
import type { PageContext } from './console/context.ts';
import { memberDeletionDialog } from './console/member-deletion.ts';
import { teamPage } from './console/team.ts';
import { wordingProblems } from './console/testing-wording.ts';
import { createTestServer } from './testing.ts';

test('R2: memberDeletions counts and removes bot-runtime files + channel-staging and CLI/console previews show count, size, and removal effect', async (t) => {
  const postgres = await startPostgres({ socket: true, passwordless: true });
  t.after(() => postgres.stop());
  const hub = await createTestServer({ postgres });
  t.after(() => hub.close());

  const alice = await hub.createUser('附件清理甲');
  const bob = await hub.createUser('附件保留乙');
  const memberDir = (scope: 'files' | 'channel-staging', userId: string) =>
    join(hub.deps.config.dataDir, 'bot-runtime', scope, createHash('sha256').update(userId).digest('hex'));

  const aliceFilesDir = memberDir('files', alice.principal.id);
  const aliceStagingDir = memberDir('channel-staging', alice.principal.id);
  const bobFilesDir = memberDir('files', bob.principal.id);
  const bobStagingDir = memberDir('channel-staging', bob.principal.id);
  await mkdir(aliceFilesDir, { recursive: true, mode: 0o700 });
  await mkdir(aliceStagingDir, { recursive: true, mode: 0o700 });
  await mkdir(bobFilesDir, { recursive: true, mode: 0o700 });
  await mkdir(bobStagingDir, { recursive: true, mode: 0o700 });

  const a1 = Buffer.from('synthetic-bot-file-one'); // 22 bytes
  const a2 = Buffer.from('second-file-bytes'); // 17 bytes
  const a3 = Buffer.from('staged-bytes'); // 12 bytes
  const totalBytes = a1.length + a2.length + a3.length; // 51 bytes
  const digest1 = createHash('sha256').update(a1).digest('hex');
  const digest2 = createHash('sha256').update(a2).digest('hex');
  const digest3 = createHash('sha256').update(a3).digest('hex');
  await writeFile(join(aliceFilesDir, digest1), a1);
  await writeFile(join(aliceFilesDir, digest2), a2);
  await writeFile(join(aliceStagingDir, digest3), a3);
  await writeFile(join(bobFilesDir, digest1), a1);
  await writeFile(join(bobStagingDir, digest3), a3);

  const preview = await hub.records.memberDeletions!.preview(hub.admin.principal, alice.principal.id);
  assert.deepEqual(preview.bot_files, {
    count: 3,
    bytes: totalBytes,
  });
  // Existing 6-field technical counts & schema remain unchanged and backward-compatible with release/2026-11-23.
  assert.deepEqual(Object.keys(preview.counts).sort(), [
    'archives',
    'attributions',
    'objects',
    'payloads',
    'private_versions',
    'records',
  ]);

  const cliOut: string[] = [];
  const cliErr: string[] = [];
  const cliStatus = await main(['user', 'delete', alice.principal.id], {
    io: {
      stdout: (line) => cliOut.push(line),
      stderr: (line) => cliErr.push(line),
      env: {
        CIRCLE_HUB_DATA_DIR: hub.deps.config.dataDir,
        CIRCLE_HUB_PORT: '0',
        CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
        CIRCLE_HUB_DATABASE_PORT: String(hub.records.database.port),
        CIRCLE_HUB_DATABASE_NAME: hub.records.database.database,
        CIRCLE_HUB_DATABASE_USER: hub.records.database.user,
      },
      cwd: hub.deps.config.dataDir,
    },
    keyProvider: () => new FileKeyProvider(join(hub.deps.config.dataDir, 'test-vault.key')),
    operatorTokens: () => memoryOperatorTokens(hub.admin.token, 'test-token-store'),
  });
  assert.equal(cliStatus, 0, cliErr.join('\n'));
  const cliText = cliOut.join('\n');
  assert.ok(cliText.includes(`机器人私聊附件 3 份（${totalBytes} 字节）`), cliText);
  assert.ok(cliText.includes('机器人私聊附件（含已存和暂存）'), cliText);

  const dialog = await memberDeletionDialog(
    {
      deps: hub.deps,
      principal: hub.admin.principal,
      userName: async (id) => (id ? (await hub.records.principals.get(id))?.name ?? '' : ''),
    } as PageContext,
    alice.principal.id,
  );
  assert.deepEqual(wordingProblems(dialog.text), []);
  assert.ok(dialog.text.includes(`<dt>机器人私聊附件</dt><dd>3 份（${totalBytes} B）</dd>`), dialog.text);
  assert.ok(dialog.text.includes('机器人私聊附件（含已存和暂存），数量见下方'), dialog.text);

  const intent = await hub.records.memberDeletions!.prepare(hub.admin.principal, {
    ...preview,
    operation_id: randomUUID(),
  });
  MemberDeletionBody.parse(intent);
  const receipt = await hub.records.memberDeletions!.finish(
    hub.admin.principal,
    alice.principal.id,
    intent.operation_id,
  );
  const { record: receiptDigest, ...receiptBody } = receipt;
  assert.match(receiptDigest, /^[0-9a-f]{64}$/);
  MemberDeletionBody.parse(receiptBody);

  await assert.rejects(access(aliceFilesDir), 'deleted member bot-runtime/files folder must be removed');
  await assert.rejects(access(aliceStagingDir), 'deleted member bot-runtime/channel-staging folder must be removed');
  await access(join(bobFilesDir, digest1));
  await access(join(bobStagingDir, digest3));
});

test('S8: console team admin member inspector renders member-external-identity@1 audit records using formal vocabulary labels', async (t) => {
  const hub = await createTestServer();
  t.after(() => hub.close());

  const alice = await hub.createUser('身份审计成员');
  const issuer = 'https://work.example.invalid/console-s8';
  const subject = 'raw-subject-console-s8';
  await hub.records.principals.bindExternalIdentity(alice.principal, issuer, subject);
  await hub.records.principals.unbindExternalIdentity(hub.admin.principal, alice.principal.id, issuer);

  const pageResult = await teamPage(
    {
      deps: hub.deps,
      principal: hub.admin.principal,
      admin: true,
      url: new URL(`${hub.url}/console/team/${alice.principal.id}`),
      chrome: (title, extra) => ({
        title,
        active: 'team',
        user: { name: hub.admin.principal.name, role: '管理员', admin: true },
        csrf: 'synthetic-csrf',
        ...extra,
      }),
      userName: async (id) => (id ? (await hub.records.principals.get(id))?.name ?? '' : ''),
    } as PageContext,
    alice.principal.id,
  );
  assert.equal(pageResult.status, 200);
  const markup = pageResult.body.text;
  assert.deepEqual(wordingProblems(markup), []);
  assert.ok(markup.includes('外部身份变更记录'), markup);
  assert.ok(markup.includes('绑定'), markup);
  assert.ok(markup.includes('解除绑定'), markup);
  assert.ok(markup.includes('人工解除'), markup);
  assert.ok(!markup.includes(issuer));
  assert.ok(!markup.includes(subject));
});
