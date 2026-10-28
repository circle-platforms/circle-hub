// Explicit opt-in: run only in a dedicated synthetic Linux VM with passwordless sudo and no installed Hub sandbox policy.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { callPackFunction, osIsolationAvailable } from '../../api.ts';
import { BOOTSTRAP, isolatedCommand } from '../isolation.ts';
import { LAUNCH_PROFILE, linuxAppArmorPolicy, WORKER_PROFILE } from '../linux.ts';

test('each actual child rejects reloaded weak policies before loading its pack', { timeout: 60_000 }, async t => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.CIRCLE_HUB_SYNTHETIC_APPARMOR_TEST, '1', 'run only in a dedicated synthetic VM');
  const listed = spawnSync('sudo', ['-n', 'cat', '/sys/kernel/security/apparmor/profiles'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, 'cannot check whether a live deployment policy is installed');
  const existing = listed.stdout;
  assert.ok(!existing.split('\n').some(line => line.startsWith(`${LAUNCH_PROFILE} `) || line.startsWith(`${WORKER_PROFILE} `)), 'never replace a running deployment policy');
  const work = mkdtempSync(join(tmpdir(), 'circle-policy-ab-'));
  const priorTmp = process.env.TMPDIR;
  const policy = linuxAppArmorPolicy(realpathSync(process.execPath));
  const strong = join(work, 'strong'); writeFileSync(strong, policy);
  const weakWrite = join(work, 'weak-write'); writeFileSync(weakWrite, policy.replace('  deny /** w,\n', ''));
  const weakExec = join(work, 'weak-exec'); writeFileSync(weakExec, policy.replace('  deny /** x,\n', '  /** ix,\n'));
  const base = realpathSync(work);
  assert.match(base, /^\/[A-Za-z0-9_./+ -]+$/);
  const weakUnix = join(work, 'weak-unix');
  writeFileSync(weakUnix, policy.replace('  deny /** w,\n', `  deny "${base}/circle-hub-sandbox-probe-*/sync" w,\n  deny "${base}/circle-hub-sandbox-probe-*/async" w,\n`));
  const pack = join(work, 'pack');
  const { mkdirSync } = await import('node:fs'); mkdirSync(pack);
  writeFileSync(join(pack, 'fn.ts'), "export default () => ({child:process.permission.has('child'),write:process.permission.has('fs.write')});");
  function load(file: string): void { const result = spawnSync('sudo', ['-n', 'apparmor_parser', '-r', file], { stdio: 'pipe' }); assert.equal(result.status, 0, 'cannot install synthetic AppArmor policy'); }
  try {
    process.env.TMPDIR = work;
    load(strong); assert.equal(await osIsolationAvailable(), true);
    await t.test('strong policy runs only after temporary permissions are dropped', async () => {
      const strongResult = await callPackFunction({ packDir: pack, module: 'fn.ts' }, null);
      assert.deepEqual(strongResult.output, { child: false, write: false }, 'temporary Node grants are dropped before pack code');
    });
    for (const [label, file] of [['write', weakWrite], ['exec', weakExec], ['Unix socket', weakUnix]] as const) {
      await t.test(`same-name policy weakens ${label} after a cached probe`, async () => {
        load(file);
        try {
          await assert.rejects(callPackFunction({ packDir: pack, module: 'fn.ts' }, null), (error: unknown) => {
            const e = error as { code?: string; detail?: { reason?: string } };
            return e.code === 'SANDBOX_UNAVAILABLE' && e.detail?.reason === 'linux_isolation_attestation';
          }, 'a cached successful probe must not let a later weak profile execute a pack');
          assert.ok(!readdirSync(work).some(name => name.startsWith('circle-hub-sandbox-probe-')), 'synthetic probe resources are removed');
        } finally { load(strong); }
      });
    }
    await t.test('removing a profile after a cached probe reports isolation unavailable', async () => {
      const removed = spawnSync('sudo', ['-n', 'apparmor_parser', '-R', strong], { stdio: 'pipe' });
      assert.equal(removed.status, 0);
      try {
        await assert.rejects(callPackFunction({ packDir: pack, module: 'fn.ts' }, null), (error: unknown) => {
          const e = error as { code?: string; detail?: { reason?: string } };
          return e.code === 'SANDBOX_UNAVAILABLE' && e.detail?.reason === 'linux_isolation_attestation';
        });
      } finally { load(strong); }
    });

    // Simulate an older Node or a failed grant without loading pack code. The preload is trusted synthetic test code.
    await t.test('missing permission.drop refuses before pack loading', async () => {
      const preload = join(work, 'preload.mjs'); writeFileSync(preload, 'process.permission.drop = undefined;');
      const probeDir = join(work, 'probe'); mkdirSync(probeDir);
      const command = isolatedCommand({ entry: BOOTSTRAP, reads: [preload], heapMb: 256, cpuSeconds: 10, os: true, probeDir });
      const permissionIndex = command.args.indexOf('--permission'); assert.ok(permissionIndex >= 0);
      command.args.splice(permissionIndex, 0, '--import', pathToFileURL(preload).href);
      const child = spawn(command.command, command.args, { cwd: work, env: { TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ nonce: 'synthetic', linuxOsIsolation: true, linuxProbeDir: probeDir }));
      const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(exit, 72, 'missing permission.drop must refuse before pack loading');
    });
  } finally {
    spawnSync('sudo', ['-n', 'apparmor_parser', '-R', strong], { stdio: 'ignore' });
    if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp;
    rmSync(work, { recursive: true, force: true });
  }
});
