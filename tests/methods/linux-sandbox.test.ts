import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {realpath} from 'node:fs/promises';
import {ApiError} from '../../packages/contracts/src/index.ts';
import {sandboxHost, sandboxTest} from '../acceptance/harness.ts';
import {linuxIsolatedProcess, bubblewrapInstallHint} from '../../packages/runtime/src/isolation-linux.ts';
import {isolatedProcess} from '../../packages/runtime/src/isolation.ts';

function onceExit(child: ReturnType<typeof spawn>): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => {stdout += chunk;});
    child.stderr?.on('data', chunk => {stderr += chunk;});
    child.on('exit', code => resolve({code, stdout, stderr}));
  });
}

sandboxTest('Process isolation blocks writes outside the workspace and blocks the network when no loopback endpoint is approved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hub-sandbox-boundary-'));
  const workspace = join(root, 'workspace'), secret = join(root, 'secret.txt'), locked = join(root, 'locked.txt');
  t.after(() => rm(root, {recursive: true, force: true}));
  await (await import('node:fs/promises')).mkdir(workspace);
  await writeFile(secret, 'HOST_SECRET');
  await writeFile(locked, 'LOCKED');
  const hostsBefore = await readFile('/etc/hosts');
  t.after(async () => {
    const now = await readFile('/etc/hosts');
    if (!now.equals(hostsBefore)) await writeFile('/etc/hosts', hostsBefore);
  });
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as {port: number}).port;
  let received = 0;
  server.on('connection', socket => {socket.on('data', chunk => {received += chunk.length;});});
  t.after(() => new Promise(resolve => server.close(() => resolve(undefined))));
  const source = `const fs=require('node:fs');const net=require('node:net');const secret=process.argv[1],workspace=process.argv[2],locked=process.argv[3],port=Number(process.argv[4]);(async()=>{let hosts='ok';try{fs.appendFileSync('/etc/hosts','\\n# sandbox-probe\\n');}catch(error){hosts=error.code||'ERR';}try{fs.writeFileSync(secret,'PWNED');}catch(error){/* a private mount may hide the host file */}let lockedWrite='ok';try{fs.appendFileSync(locked,'PWNED');}catch(error){lockedWrite=error.code||'ERR';}fs.writeFileSync(workspace+'/out.txt','workspace-ok');const netResult=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});const timer=setTimeout(()=>{socket.destroy();resolve('denied');},1000);socket.on('connect',()=>{clearTimeout(timer);socket.end('ping');resolve('connected');});socket.on('error',()=>{clearTimeout(timer);resolve('denied');});});process.stdout.write(JSON.stringify({hosts,lockedWrite,net:netResult}));})().catch(error=>{process.stderr.write(String(error));process.exit(1);});`;
  const spec = await isolatedProcess(process.execPath, ['-e', source, secret, workspace, locked, String(port)], {read: [workspace, locked], write: [workspace], network: []});
  const child = spawn(spec.command, spec.args, {env: {PATH: process.env.PATH}, stdio: ['ignore', 'pipe', 'pipe']});
  const result = await onceExit(child);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {hosts: string; lockedWrite: string; net: string};
  assert.equal(await readFile(secret, 'utf8'), 'HOST_SECRET');
  assert.equal(await readFile(locked, 'utf8'), 'LOCKED');
  assert.equal(await readFile(join(workspace, 'out.txt'), 'utf8'), 'workspace-ok');
  assert.notEqual(report.hosts, 'ok');
  assert.notEqual(report.lockedWrite, 'ok');
  assert.equal(report.net, 'denied');
  assert.equal(received, 0);
});

test('Linux isolation refuses to run when bubblewrap is missing', async t => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  await assert.rejects(
    () => linuxIsolatedProcess(process.execPath, ['-e', 'process.exit(0)'], {read: [], write: [], network: []}, {bwrapPath: null}),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'SANDBOX_UNAVAILABLE');
      assert.match(error.message, /apt-get install bubblewrap/);
      assert.equal(error.details.install, bubblewrapInstallHint);
      assert.ok(!error.message.includes('/usr/bin/'));
      return true;
    },
  );
});

test('Linux isolation wraps the command in bubblewrap and does not share the network by default', async t => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  if (!sandboxHost.available) return t.skip(sandboxHost.reason);
  const spec = await linuxIsolatedProcess(process.execPath, ['-e', 'process.exit(0)'], {read: [], write: [], network: []});
  assert.ok(spec.command.endsWith('bwrap'));
  assert.notEqual(spec.command, process.execPath);
  assert.ok(spec.args.includes('--unshare-net'));
  assert.ok(!spec.args.includes('--new-session'));
  const executable = await realpath(process.execPath);
  const separator = spec.args.indexOf('--');
  assert.ok(separator >= 0);
  assert.ok(spec.args.slice(separator + 1).includes(executable));
  assert.notEqual(spec.args[0], executable);
});

test('Linux landlock allows only an approved loopback port', async t => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  if (!sandboxHost.available) return t.skip(sandboxHost.reason);
  const listen = () => new Promise<{port: number; close: () => Promise<void>; received: () => number}>((resolve, reject) => {
    const server = createServer();
    let received = 0;
    server.on('connection', socket => {socket.on('data', chunk => {received += chunk.length;});});
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as {port: number};
      resolve({port: address.port, close: () => new Promise(done => server.close(() => done())), received: () => received});
    });
  });
  const allowed = await listen();
  const blocked = await listen();
  t.after(() => allowed.close());
  t.after(() => blocked.close());
  const source = `const net=require('node:net');const ports=process.argv.slice(1).map(Number);(async()=>{const results=[];for(const port of ports){results.push(await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});const timer=setTimeout(()=>{socket.destroy();resolve('denied');},1000);socket.on('connect',()=>{clearTimeout(timer);socket.end('ping');resolve('connected');});socket.on('error',()=>{clearTimeout(timer);resolve('denied');});}));}process.stdout.write(JSON.stringify(results));})().catch(error=>{process.stderr.write(String(error));process.exit(1);});`;
  const spec = await linuxIsolatedProcess(process.execPath, ['-e', source, String(allowed.port), String(blocked.port)], {read: [], write: [], network: [`http://127.0.0.1:${allowed.port}/`]});
  assert.ok(!spec.args.includes('--unshare-net'));
  const child = spawn(spec.command, spec.args, {env: {PATH: process.env.PATH}, stdio: ['ignore', 'pipe', 'pipe']});
  const result = await onceExit(child);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['connected', 'denied']);
  assert.ok(allowed.received() > 0);
  assert.equal(blocked.received(), 0);
});
