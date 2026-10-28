// Explicit VM-only integration check; never imported by production or by the ordinary unit suite.
// Run with `node --test hub/server/linux-listen-vm.ts` in a disposable Linux VM with passwordless sudo for ip.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { hostname } from 'node:os';
import { test } from 'node:test';
import { checkHealth, portAnswers, portOccupied } from '../platform/health.ts';
import { createApp } from './app.ts';
import type { ServerDeps } from './api.ts';

const ADDRESS = '192.0.2.77';
const networkEnv = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' };

function ip(...args: string[]): string {
  return execFileSync('ip', args, { env: networkEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function privileged(...args: string[]): void {
  const child = spawnSync('sudo', ['-n', 'ip', ...args], { env: networkEnv, stdio: 'ignore' });
  if (child.status !== 0) throw new Error('虚拟机无法执行接口准备或清理；检查 ip 和免交互 sudo 权限');
}
function send(port: number, host: string, origin?: string, method = 'GET', path = '/healthz'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: ADDRESS, port, path, method, headers: { host, ...(origin ? { origin } : {}), ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, timeout: 3000 }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('timeout', () => req.destroy(new Error('synthetic request timed out')));
    req.once('error', reject);
    req.end();
  });
}

test('an explicit internal listener enforces its authority and origin on a real synthetic VM interface', { timeout: 30000 }, async () => {
  if (process.platform !== 'linux' || hostname() !== 'lima-synthetic-hub' || process.env.SYNTHETIC_VM_NETWORK_TEST !== '1') throw new Error('此检查只在 lima-synthetic-hub 合成虚拟机执行；必须显式设置 SYNTHETIC_VM_NETWORK_TEST=1');
  const addresses = JSON.parse(ip('-j', 'address', 'show')) as Array<{ addr_info?: Array<{ local?: string }> }>;
  if (addresses.some(device => device.addr_info?.some(address => address.local === ADDRESS))) throw new Error('合成地址已在虚拟机中使用，拒绝改动已有接口');
  const name = `chd${randomBytes(5).toString('hex')}`;
  let created = false;
  let app: ReturnType<typeof createApp> | undefined;
  const remove = () => {
    if (!created) return;
    privileged('link', 'delete', 'dev', name);
    created = false;
  };
  const interrupted = () => { try { remove(); } finally { process.exit(1); } };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    privileged('link', 'add', 'name', name, 'type', 'dummy'); created = true;
    console.log(`SYNTHETIC_VM_INTERFACE=${name}`);
    privileged('address', 'add', `${ADDRESS}/32`, 'dev', name);
    privileged('link', 'set', 'dev', name, 'up');
    const assigned = JSON.parse(ip('-j', '-4', 'address', 'show', 'dev', name)) as Array<{ addr_info?: Array<{ local?: string; prefixlen?: number }> }>;
    assert.ok(assigned.length === 1 && assigned[0]?.addr_info?.some(address => address.local === ADDRESS && address.prefixlen === 32));
    const route = JSON.parse(ip('-j', 'route', 'get', ADDRESS)) as Array<{ type?: string }>;
    assert.equal(route[0]?.type, 'local', 'synthetic destination must route locally before any TCP request');
    const deps = {
      config: { host: ADDRESS, port: 0, allowedHosts: ['hub.example', 'other.example'], limits: { maxRequestBytes: 1024 } },
      records: { principals: { authenticate: async (authorization: string | null) => authorization === 'Bearer synthetic-token' ? { id: 'synthetic-user', name: 'synthetic', role: 'user' } : null }, callLog: { append: async () => {} } },
    } as unknown as ServerDeps;
    app = createApp(deps, { log: () => {} });
    const { host, port } = await app.listen();
    assert.equal(host, ADDRESS);
    assert.equal(await send(port, `hub.example:${port}`, `http://hub.example:${port}`), 200);
    assert.equal(await send(port, `hub.example:${port}`, `http://hub.example:${port}`, 'POST', '/mcp'), 401);
    const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '0' } } });
    const initialized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: ADDRESS, port, path: '/mcp', method: 'POST', headers: { host: `hub.example:${port}`, origin: `http://hub.example:${port}`, authorization: 'Bearer synthetic-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, timeout: 3000 }, res => {
        const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.once('timeout', () => req.destroy(new Error('synthetic initialize timed out'))); req.once('error', reject); req.end(initialize);
    });
    assert.equal(initialized.status, 200);
    assert.equal(JSON.parse(initialized.body).result?.serverInfo?.name, 'circle-hub');
    assert.equal(await send(port, `attacker.example:${port}`), 403, 'DNS rebinding Host');
    assert.equal(await send(port, `hub.example:${port}`, 'http://attacker.example:1234'), 403, 'foreign Origin');
    assert.equal(await send(port, `hub.example:${port}`, `http://other.example:${port}`, 'POST', '/console/login'), 403, 'cross-authority form');
    assert.equal((await checkHealth(port, { host: ADDRESS, authority: 'hub.example' })).ok, true);
    assert.equal(await portAnswers(port, 1000, ADDRESS), true);
    assert.equal(await portOccupied(port), true);
  } finally {
    try { await app?.close(); } finally { remove(); process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted); }
  }
});
