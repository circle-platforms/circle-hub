import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyInstall, operationGenerated } from '../pack-files.ts';
import { scratch, execute } from './operation-support.ts';
import { scanForCredentials as hubScan } from '../../../../hub/records/scan.ts';
import { scanForCredentials as skillScan, CREDENTIAL_SCANNER } from '../tools/operation-capture/lib/credentials.ts';
import { sanitizeText } from '../tools/operation-capture/lib/redact.ts';
import { fileURLToPath } from 'node:url';

const skillRoot = new URL('../tools/operation-capture/', import.meta.url);

test('the standalone operation skill matches its signed installation and rejects extras changes missing files and links', async t => {
  const local = await scratch(t);
  assert.deepEqual(await verifyInstall(local.skill, 'tools/operation-capture/'), []);
  const verifier = fileURLToPath(new URL('../pack-files.ts', import.meta.url));
  const official = await execute(process.execPath, [verifier, '--verify-install', local.skill, '--skill', 'operation-capture'], local.env);
  assert.equal(official.code, 0, official.err);
  await writeFile(join(local.skill, 'extra.txt'), 'synthetic');
  assert.ok((await verifyInstall(local.skill, 'tools/operation-capture/')).includes('extra.txt'));
  await rm(join(local.skill, 'extra.txt'));
  const target = join(local.skill, 'egress.json');
  const bytes = await readFile(target);
  await writeFile(target, 'changed');
  assert.ok((await verifyInstall(local.skill, 'tools/operation-capture/')).includes('egress.json'));
  await rm(target);
  assert.ok((await verifyInstall(local.skill, 'tools/operation-capture/')).includes('egress.json'));
  const outside = join(local.home, 'outside');
  await writeFile(outside, bytes);
  await symlink(outside, target);
  assert.ok((await verifyInstall(local.skill, 'tools/operation-capture/')).includes('egress.json'));
});

test('every runtime import stays inside the installed skill and the generated identity has no pack digest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../pack.json', import.meta.url), 'utf8'));
  const generated = JSON.parse(await readFile(new URL('generated.json', skillRoot), 'utf8')) as Record<string, unknown>;
  assert.equal(generated.id, manifest.id);
  assert.equal(generated.version, manifest.version);
  assert.deepEqual(generated, operationGenerated());
  assert.equal(Object.hasOwn(generated, 'pack_digest'), false);
  assert.equal(generated.assertion, 'assertion');
  assert.equal(generated.provenance_type, 'client_captured');
  const walk = async (url: URL): Promise<void> => {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith('.ts')) {
        const text = await readFile(file, 'utf8');
        for (const match of text.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) {
          const path = match[2]!;
          assert.ok(path.startsWith('node:') || path.startsWith('./') || path.startsWith('../'), path);
          if (path.startsWith('.')) assert.ok(new URL(path, file).href.startsWith(skillRoot.href), path);
        }
      }
    }
  };
  await walk(skillRoot);
  const hooks = JSON.parse(await readFile(new URL('hooks.json', skillRoot), 'utf8'));
  assert.ok(hooks.hooks.after_tool[0].command.length <= 4000);
  assert.ok(!hooks.hooks.after_tool[0].command.includes('/Users/'));
  const skillText = await readFile(new URL('SKILL.md', skillRoot), 'utf8');
  assert.match(skillText, /^---\nname: operation-capture\n/);
  assert.ok((/^description: (.+)$/m.exec(skillText)?.[1]?.length ?? 2000) <= 1024);
});

test('the standalone credential scanner is byte-for-byte compatible with the Hub scanner on synthetic fixtures', () => {
  const token = `Ab3${'x'.repeat(35)}9a`;
  const secret = ['a1b2', 'c3d4', 'e5f6'].join('');
  const fence = '-'.repeat(5);
  const material = 'QUJDREVGR0hJSktMTU5P' + 'UFFSU1RVVldYWVowMTIzNDU2Nzg5';
  const cases = [
    'ORBIT synthetic status: ready\n',
    'password: ********\n',
    `Authorization: Bearer ${token}\n`,
    'password = "Synth3tic!"\n',
    `{"client_secret":"${secret}"}`,
    ["https://", "user", ":", "Synth3tic-value", "@", "192.0.2.20/synthetic"].join(''),
    `sk-Ab3${'Q'.repeat(37)}`,
    `${fence}BEGIN PRIVATE KEY${fence}\n${material}\n${fence}END PRIVATE KEY${fence}\n`,
  ];
  for (const value of cases) {
    const bytes = Buffer.from(value);
    assert.deepEqual(skillScan(bytes), hubScan(bytes), value);
  }
  assert.equal(CREDENTIAL_SCANNER, 'credential-scan@2');
  const redacted = sanitizeText('ORBIT ready\npassword = "Synth3tic!"\n');
  assert.equal(redacted.text, 'ORBIT ready\npassword = ***\n');
  assert.equal(redacted.changed, true);
  assert.deepEqual(sanitizeText('ORBIT synthetic status: ready\n').text, 'ORBIT synthetic status: ready\n');
});
