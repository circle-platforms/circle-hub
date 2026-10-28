import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NODE, osIsolationAvailable, osIsolationFailure } from './isolation.ts';
import { AA_EXEC, BWRAP, LAUNCH_PROFILE, linuxAppArmorPolicy, linuxBubblewrapArgs } from './linux.ts';
import { LINUX_LABEL } from './policy.ts';

test('AppArmor policy requires a stacked worker with no execution or network', () => {
  const policy = linuxAppArmorPolicy(NODE);
  assert.match(policy, /change_profile .* -> &circle-hub-sandbox-worker-v1/);
  assert.match(policy, /deny network inet,/);
  assert.match(policy, /deny network inet6,/);
  assert.match(policy, /deny \/\*\* w,/);
  assert.match(policy, /deny \/\*\* x,/);
  const ordinary = linuxAppArmorPolicy('/synthetic/install dir/node', '/synthetic/shell');
  assert.ok(ordinary.includes('"/synthetic/install dir/node" ix,'));
  for (const unsafe of ['/synthetic/@{HOME}/node', '/synthetic/*/node', '/synthetic/"\nprofile bad {}', 'relative/node']) {
    assert.throws(() => linuxAppArmorPolicy(unsafe, '/synthetic/shell'), /invalid executable path/);
  }
});

test('Linux OS isolation confines all Node threads and denies network, writes, unbound reads and bound executables', { timeout: 30_000 }, async t => {
  if (process.platform !== 'linux') return t.skip('Linux-only operating-system isolation');
  if (!(await osIsolationAvailable())) return t.skip(`Linux operating-system isolation unavailable: ${osIsolationFailure()}`);
  const root = mkdtempSync(join(tmpdir(), 'circle-linux-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = join(root, 'pack');
  const { mkdirSync } = await import('node:fs'); mkdirSync(pack);
  const secret = join(root, 'outside.txt'); writeFileSync(secret, 'synthetic outside');
  const copied = join(pack, 'synthetic-node'); copyFileSync(NODE, copied);
  const server = createServer(); let connections = 0;
  server.on('connection', socket => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const source = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
  (async()=>{const out={};out.label=fs.readFileSync(3,'utf8').trim();fs.closeSync(3);
  await Promise.all(Array.from({length:16},()=>fs.promises.readFile('/proc/thread-self/attr/apparmor/current','utf8')));
  out.labels=[...new Set(fs.readdirSync('/proc/self/task').map(t=>fs.readFileSync('/proc/self/task/'+t+'/attr/apparmor/current','utf8').trim()))];
  const capture=(f)=>{try{f();return 'SUCCESS'}catch(e){return e.code}};
  out.read=capture(()=>fs.readFileSync(${JSON.stringify(secret)}));
  out.syncWrite=capture(()=>fs.writeFileSync(${JSON.stringify(join(pack, 'sync'))},'x'));
  try{await fs.promises.writeFile(${JSON.stringify(join(pack, 'async'))},'x');out.asyncWrite='SUCCESS'}catch(e){out.asyncWrite=e.code}
  out.nodeSpawn=cp.spawnSync(process.execPath,['-e','process.exit(0)']).error?.code??'SUCCESS';
  out.elfSpawn=cp.spawnSync(${JSON.stringify(copied)},['-e','process.exit(0)']).error?.code??'SUCCESS';
  out.network=await new Promise(resolve=>{try{const s=net.connect(${address.port},'127.0.0.1');s.on('connect',()=>{s.destroy();resolve('SUCCESS')});s.on('error',e=>resolve(e.code));}catch(e){resolve(e.code)}});
  console.log(JSON.stringify(out));})().catch(e=>{console.error(e);process.exitCode=1});`;
  const run = (program: string[], writable = false, profile = LAUNCH_PROFILE) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const args = linuxBubblewrapArgs(NODE, program, [pack]);
    if (writable) {
      const index = args.findIndex((value, i) => value === '--ro-bind' && args[i + 1] === pack && args[i + 2] === pack);
      assert.ok(index >= 0); args[index] = '--bind'; // Synthetic negative control; production uses read-only mounts.
    }
    const child = spawn(AA_EXEC, ['-p', profile, '--', BWRAP, ...args], { cwd: pack, env: { TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', value => out += value); child.stderr.on('data', value => err += value);
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  });
  const result = await run(['--no-warnings', '-e', source]);
  assert.equal(result.code, 0, result.err);
  const value = JSON.parse(result.out) as Record<string, unknown>;
  assert.equal(value.label, LINUX_LABEL); assert.deepEqual(value.labels, [LINUX_LABEL]);
  assert.ok(['ENOENT', 'EACCES'].includes(String(value.read)));
  assert.ok(['EACCES', 'EROFS'].includes(String(value.syncWrite))); assert.ok(['EACCES', 'EROFS'].includes(String(value.asyncWrite)));
  assert.equal(value.nodeSpawn, 'EACCES'); assert.equal(value.elfSpawn, 'EACCES');
  assert.ok(['EACCES', 'EPERM', 'ECONNREFUSED', 'ENETUNREACH'].includes(String(value.network)));
  assert.equal(connections, 0);
  const writable = await run(['--no-warnings', '-e', source], true);
  assert.equal(writable.code, 0, writable.err);
  const denied = JSON.parse(writable.out) as Record<string, unknown>;
  assert.equal(denied.syncWrite, 'EACCES'); assert.equal(denied.asyncWrite, 'EACCES');
  const replacement = await run(['--no-warnings', '-e', "process.execve(process.execPath,[process.execPath,'-e','console.log(\"UNEXPECTED\")'],{})"]);
  assert.notEqual(replacement.code, 0); assert.match(replacement.err, /EACCES/); assert.doesNotMatch(replacement.out, /UNEXPECTED/);
  const missing = await run(['--no-warnings', '-e', "console.log('UNEXPECTED')"], false, `${LAUNCH_PROFILE}-missing`);
  assert.notEqual(missing.code, 0); assert.doesNotMatch(missing.out, /UNEXPECTED/);
});
