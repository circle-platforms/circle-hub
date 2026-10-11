import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = process.env.INFOSEC_LAB_ROOT;
if (!root) throw new Error('Set INFOSEC_LAB_ROOT to an isolated lab directory');
const require = createRequire(path.join(root, 'runtime/package.json'));
const { Client } = require('ssh2');
const { chromium } = require('playwright');
const here = path.dirname(new URL(import.meta.url).pathname);
const owned: any[] = []; const clients: any[] = []; const cases: any[] = [];
let browserServer: any; let browser: any;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const startedAt = new Date().toISOString();
const runId = `network-${startedAt}`;
for (const dir of ['private', 'evidence']) fs.mkdirSync(path.join(root, dir), { recursive: true });
const secret = randomBytes(24).toString('hex');
fs.writeFileSync(path.join(root, 'private/runtime.json'), JSON.stringify({ secret, runId }), { mode: 0o600 });
for (const name of ['device-hostkey', 'jump-hostkey']) if (!fs.existsSync(path.join(root, 'private', name))) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(root, 'private', name)]);
fs.writeFileSync(path.join(root, 'evidence/events.jsonl'), '');
fs.rmSync(path.join(root, 'private/device-state.json'), { force: true });
function fingerprint(name: string) { const key = fs.readFileSync(path.join(root, 'private', name + '.pub'), 'utf8').split(' ')[1]; return hash(Buffer.from(key, 'base64')); }
async function start(role: string, extra: string[] = []) {
  const child = spawn(process.execPath, [path.join(here, 'lab-node.ts'), role, ...extra], { env: { PATH: process.env.PATH!, INFOSEC_LAB_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] }); owned.push(child);
  const stderr: Buffer[] = []; child.stderr.on('data', (data: Buffer) => stderr.push(data));
  return await new Promise<any>((resolve, reject) => { let text = ''; const timer = setTimeout(() => reject(new Error(`node ${role} startup timed out`)), 8000); child.once('exit', (code: number) => { if (code) reject(new Error(`node ${role} exited ${code}: ${Buffer.concat(stderr).toString()}`)); }); child.stdout.on('data', (data: Buffer) => { text += data.toString(); const line = text.split('\n')[0]; if (text.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(line)); } }); });
}
async function connect(port: number, key: string, sock?: any) {
  const client = new Client(); clients.push(client);
  await new Promise<void>((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); client.connect({ host: '127.0.0.1', port, username: 'lab', password: secret, readyTimeout: 3000, hostHash: 'sha256', hostVerifier: (value: string) => value === fingerprint(key), ...(sock ? { sock } : {}) }); });
  return client;
}
async function forward(client: any, port: number) { return await new Promise<any>((resolve, reject) => client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error: any, channel: any) => error ? reject(error) : resolve(channel))); }
async function exec(client: any, command: string, timeout = 3000) {
  return await new Promise<Buffer>((resolve, reject) => { const output: Buffer[] = []; const errors: Buffer[] = []; const timer = setTimeout(() => reject(new Error('command-timeout')), timeout); client.exec(command, (error: any, stream: any) => { if (error) { clearTimeout(timer); reject(error); return; } stream.on('data', (data: Buffer) => output.push(Buffer.from(data))); stream.stderr.on('data', (data: Buffer) => errors.push(Buffer.from(data))); stream.on('error', reject); stream.on('close', (code: number) => { clearTimeout(timer); if (code && code !== 0) reject(new Error(Buffer.concat(errors).toString())); else resolve(Buffer.concat(output)); }); }); });
}
async function json(url: string, input?: any) { const r = await fetch(url, input ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) } : undefined); return { status: r.status, data: await r.json() }; }
async function runCase(name: string, operation: () => Promise<any>) { const before = new Date().toISOString(); try { const evidence = await operation(); cases.push({ name, outcome: 'pass', startedAt: before, endedAt: new Date().toISOString(), evidence }); console.log(JSON.stringify({ case: name, outcome: 'pass', evidence })); } catch (error: any) { cases.push({ name, outcome: 'fail', startedAt: before, endedAt: new Date().toISOString(), error: error.message }); console.log(JSON.stringify({ case: name, outcome: 'fail', error: error.message })); throw error; } }
try {
  const backend = await start('backend'); const device = await start('device'); const jump2 = await start('jump', [String(device.sshPort)]); const jump1 = await start('jump', [String(jump2.port)]);
  const management = `http://127.0.0.1:${device.managementPort}`; const business = `http://127.0.0.1:${device.businessPort}`;
  fs.writeFileSync(path.join(root, 'private/topology.json'), JSON.stringify({ backend, device, jump1, jump2 }, null, 2));
  const c1 = await connect(jump1.port, 'jump-hostkey'); const c2 = await connect(jump2.port, 'jump-hostkey', await forward(c1, jump2.port)); const target = await connect(device.sshPort, 'device-hostkey', await forward(c2, device.sshPort));
  await runCase('two-hop-ssh-real-protocol', async () => { const bytes = await exec(target, 'show identity'); const identity = JSON.parse(bytes.toString()); assert.equal(identity.identity, 'lab-device-01'); fs.writeFileSync(path.join(root, 'evidence/ssh-identity.bin'), bytes); return { hops: 2, identity: identity.identity, bytes: bytes.length, sha256: hash(bytes) }; });
  await runCase('management-reachable-business-unconfigured', async () => { const m = await json(management + '/state'); const b = await json(business + '/probe'); assert.equal(m.status, 200); assert.equal(b.status, 502); const direct = await json(`http://127.0.0.1:${backend.port}/probe`); assert.equal(direct.status, 200); return { managementStatus: m.status, frontendStatus: b.status, directBackendStatus: direct.status, explanation: 'Management availability did not prove the business forwarding path worked' }; });
  await runCase('ssh-configure-independent-business-verification', async () => { const bytes = await exec(target, `configure ${backend.port} lab-change-01`); const receipt = JSON.parse(bytes.toString()); const b = await json(business + '/probe'); assert.equal(b.status, 200); assert.equal(b.data.role, 'lab-business-backend'); fs.writeFileSync(path.join(root, 'evidence/ssh-change.bin'), bytes); return { mutations: receipt.mutations, businessStatus: b.status, receivedRole: b.data.role }; });
  await runCase('receipt-loss-reconcile-and-no-duplicate-effect', async () => { let receiptLost = false; try { await fetch(management + '/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: backend.port, operationId: 'lab-change-02', dropReceipt: true }) }); } catch { receiptLost = true; } assert.equal(receiptLost, true); const actual = await json(management + '/state'); assert.ok(actual.data.operations['lab-change-02']); const repeat = await json(management + '/configure', { port: backend.port, operationId: 'lab-change-02' }); assert.equal(repeat.data.duplicate, true); assert.equal(repeat.data.mutations, actual.data.mutations); return { responseLost: receiptLost, reconciledRevision: actual.data.revision, effectsBeforeRepeat: actual.data.mutations, effectsAfterRepeat: repeat.data.mutations }; });
  await runCase('ssh-long-output-original-bytes', async () => { const bytes = await exec(target, 'show long-output'); const text = bytes.toString(); assert.equal(text.split('\r\n').filter(Boolean).length, 2001); assert.ok(text.startsWith('line-0000')); assert.ok(text.includes('line-1999')); assert.ok(text.endsWith('lab-device#\r\n')); fs.writeFileSync(path.join(root, 'evidence/ssh-long-output.bin'), bytes); return { lines: 2001, bytes: bytes.length, sha256: hash(bytes), crlfPreserved: true }; });
  await runCase('local-call-disconnect-remote-job-still-running', async () => { const disposable = await connect(device.sshPort, 'device-hostkey'); let remotePid = 0; await new Promise<void>((resolve, reject) => disposable.exec('run delayed disconnect-job', (error: any, stream: any) => { if (error) return reject(error); stream.once('data', (bytes: Buffer) => { remotePid = JSON.parse(bytes.toString()).childPid; stream.destroy(); disposable.end(); resolve(); }); })); assert.equal(alive(remotePid), true); await new Promise(resolve => setTimeout(resolve, 4000)); const effectFile = path.join(root, 'evidence/disconnect-job-effect.json'); assert.equal(fs.existsSync(effectFile), true); return { remotePid, aliveAfterLocalDisconnect: true, remoteEffectObservedAfterDisconnect: true, effectSha256: hash(fs.readFileSync(effectFile)) }; });
  await runCase('identity-drift-observation', async () => { await json(management + '/identity-drift', { identity: 'lab-device-02' }); const bytes = await exec(target, 'show identity'); const observed = JSON.parse(bytes.toString()); assert.notEqual(observed.identity, 'lab-device-01'); return { expectedIdentity: 'lab-device-01', observedIdentity: observed.identity, requiresRebindingBeforeFurtherWrites: true, detectionOnly: true }; });
  await runCase('real-browser-configure-and-re-read', async () => { browserServer = await chromium.launchServer({ headless: !process.argv.includes('--headed'), host: '127.0.0.1', args: ['--disable-background-networking'], }); browser = await chromium.connect(browserServer.wsEndpoint()); const context = await browser.newContext(); await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()); await context.tracing.start({ screenshots: true, snapshots: true, sources: false }); const page = await context.newPage(); await page.goto(management); await page.locator('#state').filter({ hasText: 'lab-device-02' }).waitFor(); await page.screenshot({ path: path.join(root, 'evidence/browser-before.png') }); await page.locator('#port').fill(String(backend.port)); await page.locator('#apply').click(); await page.getByText('Configuration accepted').waitFor(); const visible = JSON.parse(await page.locator('#state').innerText()); const actual = await json(management + '/state'); assert.equal(visible.revision, actual.data.revision); await page.screenshot({ path: path.join(root, 'evidence/browser-after.png') }); await context.tracing.stop({ path: path.join(root, 'evidence/browser-trace.zip') }); await context.close(); return { realBrowser: await browser.version(), sameVisibleAndActualRevision: visible.revision, screenshotBeforeSha256: hash(fs.readFileSync(path.join(root, 'evidence/browser-before.png'))), screenshotAfterSha256: hash(fs.readFileSync(path.join(root, 'evidence/browser-after.png'))), scope: 'Synthetic local site; no model and no real product' }; });
  await runCase('browser-client-disconnect-does-not-stop-browser-server', async () => { const pid = browserServer.process().pid; await browser.close(); assert.equal(alive(pid), true); await browserServer.close(); assert.equal(alive(pid), false); browserServer = undefined; return { browserPid: pid, aliveAfterClientDisconnect: true, stoppedAfterServerClose: true }; });
} finally {
  for (const client of clients) client.end();
  if (browserServer) await browserServer.close();
  const cleanup = [];
  for (const child of owned.reverse()) { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => { const timer = setTimeout(() => { if (alive(child.pid)) child.kill('SIGKILL'); resolve(); }, 2500); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); } cleanup.push({ pid: child.pid, exited: !alive(child.pid), exitCode: child.exitCode }); }
  assert.ok(cleanup.every(row => row.exited));
  const eventBytes = fs.readFileSync(path.join(root, 'evidence/events.jsonl'));
  const sources = Object.fromEntries(['run-network-lab.ts', 'lab-node.ts', 'remote-job.ts'].map(name => [name, hash(fs.readFileSync(path.join(here, name)))]));
  const manifest = { runId, sources, dependencyLockSha256: hash(fs.readFileSync(path.join(root, 'runtime/package-lock.json'))), startedAt, endedAt: new Date().toISOString(), isolation: 'Owned local processes and loopback sockets; not VM/network-namespace isolation', cases, cleanup, events: { sha256: hash(eventBytes), lines: eventBytes.toString().trim().split('\n').length }, productionClaims: false };
  fs.writeFileSync(path.join(root, 'evidence/network-lab-receipt.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ passed: cases.filter(c => c.outcome === 'pass').length, failed: cases.filter(c => c.outcome === 'fail').length, ownedProcessesStopped: cleanup.every(c => c.exited), receipt: 'network-lab-receipt.json' }));
}
