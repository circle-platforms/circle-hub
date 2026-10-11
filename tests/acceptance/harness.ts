import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const taskGrants = ['tasks.read', 'tasks.submit', 'tasks.input', 'tasks.cancel', 'evidence.read', 'methods.use', 'sources.read', 'sources.write','operations.reconcile'];
const deviceGrants = ['product.version', 'product.config.read', 'product.config.write', 'docs.fetch', 'docs.convert', 'defects.search', 'defects.comment'];
export const identities = [
  { username: 'alice', principalId: 'prn_alice', tenantId: 'tnt_lab', kind: 'user', scopes: ['scp_lab', 'scp_second'],
    grants: [...taskGrants, ...deviceGrants, 'decisions.approve','rules.manage'], targets: ['LBX-LAB-01', 'bugzilla-synthetic', 'jira-synthetic', 'openkm-synthetic'], defects: ['LAB-42'] },
  { username: 'bob', principalId: 'prn_bob', tenantId: 'tnt_lab', kind: 'user', scopes: ['scp_lab'],
    grants: [...taskGrants, 'decisions.approve'], targets: [], defects: ['LAB-42'] },
  { username: 'outsider', principalId: 'prn_outsider', tenantId: 'tnt_other', kind: 'user', scopes: ['scp_lab'],
    grants: taskGrants, targets: [], defects: [] },
  { username: 'limited', principalId: 'prn_limited', tenantId: 'tnt_lab', kind: 'user', scopes: ['scp_hidden'],
    grants: taskGrants, targets: [], defects: [] },
  { username: 'admin', principalId: 'prn_admin', tenantId: 'tnt_lab', kind: 'user', scopes: ['scp_lab', 'scp_second'],
    grants: [...taskGrants, 'admin.manage', 'decisions.approve'], targets: [], defects: [] },
  { username: 'defect-bot', principalId: 'prn_defectbot', tenantId: 'tnt_lab', kind: 'service', scopes: ['scp_lab'],
    grants: [...taskGrants, 'defects.search', 'defects.comment', 'docs.fetch', 'docs.convert', 'product.version'],
    targets: ['bugzilla-synthetic', 'jira-synthetic', 'openkm-synthetic', 'LBX-LAB-01'], defects: ['LAB-42', 'SECRET-99'] },
  ...['lab-east-01', 'lab-east-02'].map(workerId => ({ username: workerId, principalId: `prn_${workerId}`,
    tenantId: 'tnt_lab', kind: 'worker', workerId, scopes: ['scp_lab', 'scp_second'], grants: ['workers.execute'],
    targets: ['LBX-LAB-01', 'bugzilla-synthetic', 'jira-synthetic', 'openkm-synthetic'], defects: ['LAB-42', 'SECRET-99'] })),
].map(identity => ({ ...identity, password: 'synthetic-only-password' }));

export async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(25); }
  throw new Error(`Acceptance condition timed out after ${timeoutMs}ms`);
}

export class Harness {
  scratch: string;
  db: pg.Pool;
  postgres: EmbeddedPostgres;
  env: NodeJS.ProcessEnv;
  url = '';
  server?: ChildProcess;
  children = new Set<ChildProcess>();
  constructor(scratch: string, postgres: EmbeddedPostgres, db: pg.Pool, env: NodeJS.ProcessEnv) {
    this.scratch = scratch; this.postgres = postgres; this.db = db; this.env = env;
  }
  async startServer(): Promise<void> {
    const child = spawn(process.execPath, ['apps/server/src/main.ts'], { cwd: root, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.server = child; this.children.add(child);
    let output = ''; let errors = '';
    child.stdout!.on('data', data => { output += data.toString(); });
    child.stderr!.on('data', data => { errors += data.toString(); });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
      for (const line of output.split('\n')) {
        try { const item = JSON.parse(line); if (item.type === 'ready') { this.url = item.url; return true; } } catch { /* partial line */ }
      }
      return false;
    });
  }
  async stop(child: ChildProcess | undefined = this.server, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(signal); await exited; this.children.delete(child);
  }
  async close(): Promise<void> {
    for (const child of this.children) await this.stop(child);
    await this.db.end(); await this.postgres.stop(); await rm(this.scratch, { recursive: true, force: true });
  }
  async raw(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`${this.url}${path}`, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    return { status: response.status, body: await response.json() };
  }
  async login(username = 'alice', expiresInMs?: number): Promise<string> {
    const response = await this.raw('/v1/auth/token', { body: { username, password: 'synthetic-only-password', expiresInMs } });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data.token;
  }
  async request(path: string, body?: unknown, username = 'alice', method?: string): Promise<any> {
    const result = await this.raw(path, { body, method, token: await this.login(username) });
    assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result.body)); return result.body.data;
  }
  async reject(path: string, body: unknown, code: string, username = 'alice'): Promise<any> {
    const result = await this.raw(path, { body, token: await this.login(username) });
    assert.ok(result.status >= 400, JSON.stringify(result.body)); assert.equal(result.body.error.code, code); return result.body.error;
  }
  async submit(input: Record<string, unknown> = {}, scopeId = 'scp_lab', key = randomBytes(12).toString('hex')): Promise<any> {
    return this.request('/v1/tasks/submit', { scopeId, title: 'Inspect synthetic LBX health checks', input, idempotencyKey: key });
  }
  async status(taskId: string): Promise<any> { return this.request(`/v1/tasks/${taskId}/status`); }
  async phase(taskId: string, phase: string): Promise<any> {
    return until(async () => { const task = await this.status(taskId); return task.phase === phase ? task : false; });
  }
  async startWorker(workerId = 'lab-east-01', extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['apps/worker/src/main.ts'], { cwd: root, env: { ...this.env,
      CIRCLE_SERVER_URL: this.url, CIRCLE_WORKER_USERNAME: workerId,
      CIRCLE_WORKER_PASSWORD: 'synthetic-only-password', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.children.add(child);
    let errors = ''; child.stderr!.on('data', data => { errors += data.toString(); });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Worker exited: ${errors}`);
      const workers = await this.request('/v1/admin/workers', undefined, 'admin');
      return workers.some((worker: any) => worker.workerId === workerId) ? child : false;
    });
    return child;
  }
}

export async function setup(t: TestContext, overrides: Record<string, string> = {}): Promise<Harness> {
  const scratch = await mkdtemp(`${tmpdir()}/circle-server-acceptance-`);
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const password = randomBytes(24).toString('hex');
  const databaseConfig = { host: '127.0.0.1', port, user: 'circle_synthetic', password, database: 'postgres' };
  const postgres = new EmbeddedPostgres({ databaseDir: `${scratch}/pg`, user: databaseConfig.user, password, port,
    persistent: false, createPostgresUser: false, authMethod: 'scram-sha-256', postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {}, onError: () => {} });
  let started = false;
  try {
    await postgres.initialise(); await postgres.start(); started = true;
    await mkdir(`${scratch}/objects`);
    await writeFile(`${scratch}/identities.json`, JSON.stringify({ identities }), { mode: 0o600 });
    const env = { ...process.env, CIRCLE_SERVER_DATABASE_CONFIG: JSON.stringify(databaseConfig),
      CIRCLE_SERVER_DATA_DIR: `${scratch}/objects`, CIRCLE_SERVER_DEV_IDENTITIES: `${scratch}/identities.json`,
      CIRCLE_SERVER_DEV_AUTH: '1', CIRCLE_SERVER_PORT: '0', CIRCLE_SERVER_POLL_MS: '30',
      CIRCLE_SYNTHETIC_RESOURCE_DIR: `${scratch}/resources`, ...overrides };
    const harness = new Harness(scratch, postgres, new pg.Pool(databaseConfig), env);
    t.after(() => harness.close()); await harness.startServer(); return harness;
  } catch (error) { if (!started) await rm(scratch, { recursive: true, force: true }); throw error; }
}
