import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm,readFile } from 'node:fs/promises';
import {checkedRequest} from '../fixtures/loopback-tls.ts';
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
    grants: [...taskGrants, ...deviceGrants, 'decisions.approve','rules.manage'], targets: ['RESOURCE-LAB-01', 'record-feed-a', 'record-feed-b', 'document-store'], defects: ['LAB-42'] },
  { username: 'bob', principalId: 'prn_bob', tenantId: 'tnt_lab', kind: 'user', scopes: ['scp_lab'],
    grants: [...taskGrants, 'decisions.approve'], targets: [], defects: ['LAB-42'] },
  { username: 'outsider', principalId: 'prn_outsider', tenantId: 'tnt_other', kind: 'user', scopes: ['scp_lab'],
    grants: taskGrants, targets: [], defects: [] },
  { username: 'limited', principalId: 'prn_limited', tenantId: 'tnt_lab', kind: 'user', scopes: ['scp_hidden'],
    grants: taskGrants, targets: [], defects: [] },
  { username: 'admin', principalId: 'prn_admin', tenantId: 'tnt_lab', kind: 'user', scopes: ['scp_lab', 'scp_second'],
    grants: [...taskGrants, 'admin.manage', 'admin.restart', 'decisions.approve'], targets: [], defects: [] },
  { username: 'defect-bot', principalId: 'prn_defectbot', tenantId: 'tnt_lab', kind: 'service', scopes: ['scp_lab'],
    grants: [...taskGrants, 'defects.search', 'defects.comment', 'docs.fetch', 'docs.convert', 'product.version'],
    targets: ['record-feed-a', 'record-feed-b', 'document-store', 'RESOURCE-LAB-01'], defects: ['LAB-42', 'SECRET-99'] },
  ...['lab-east-01', 'lab-east-02'].map(workerId => ({ username: workerId, principalId: `prn_${workerId}`,
    tenantId: 'tnt_lab', kind: 'worker', workerId, scopes: ['scp_lab', 'scp_second'], grants: ['workers.execute'],
    targets: ['RESOURCE-LAB-01', 'record-feed-a', 'record-feed-b', 'document-store'], defects: ['LAB-42', 'SECRET-99'] })),
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
  clientCA?:Buffer;
  autoRuntimeProfiles=true;
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
    if(this.autoRuntimeProfiles)await this.approveRuntimeProfiles();
  }
  // Synthetic fixtures explicitly submit and independently decide their runtime
  // settings. The production server never approves runtime configuration.
  async approveRuntimeProfiles(scope='scp_lab',reviewer='bob',owner='admin'){
    if(![this.env.CIRCLE_SERVER_CONNECTOR_PROFILES,this.env.CIRCLE_SERVER_EXECUTION_GATEWAYS,this.env.CIRCLE_RUNTIME_CONFIG].some(Boolean))return;
    const references=await this.request('/v1/runtime-profiles',undefined,owner);
    for(const ref of references){const existing=(await this.db.query("SELECT a.asset_id,v.* FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version WHERE a.scope_id=$3 AND a.kind='runtime-profile' AND v.configuration->>'profileType'=$1 AND v.configuration->>'profileRef'=$2",[ref.profileType,ref.profileRef,scope])).rows[0];if(existing?.configuration.profileSha256===ref.profileSha256&&['approved','running'].includes(existing.lifecycle))continue;
      const ordinal=existing?Number((await this.db.query('SELECT count(*) AS n FROM asset_versions WHERE asset_id=$1',[existing.asset_id])).rows[0].n)+1:1;
      const asset=await this.request('/v1/assets',{...(existing?{assetId:existing.asset_id}:{}),scopeId:scope,kind:'runtime-profile',name:'Synthetic runtime profile',version:`${ordinal}.0.0`,declaration:{reads:[],writes:[],credentials:[]},configuration:{profileType:ref.profileType,profileRef:ref.profileRef,profileSha256:ref.profileSha256},readers:['*']},owner);
      await this.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},reviewer);
    }
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
    if(this.url.startsWith('https:')){const ca=this.clientCA??await readFile(this.env.NODE_EXTRA_CA_CERTS!),response=await checkedRequest(`${this.url}${path}`,{ca,headers:{...(options.body===undefined?{}:{'content-type':'application/json'}),...(options.token?{authorization:`Bearer ${options.token}`}:{})},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});return {status:response.status,body:await response.json()};}
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
    return this.request('/v1/tasks/submit', { scopeId, title: 'Inspect synthetic SYNTH health checks', input, idempotencyKey: key });
  }
  async status(taskId: string): Promise<any> { return this.request(`/v1/tasks/${taskId}/status`); }
  async setRole(principalId:string,role:'admin'|'member'|'viewer'|null,scopeId='scp_lab'):Promise<void>{const changed=await this.db.query("UPDATE principal_scope_roles SET role=$2,revision=revision+1,verification='{\"ruleId\":\"synthetic-role-fixture\",\"ruleVersion\":\"1.0.0\",\"result\":\"passed\"}'::jsonb WHERE principal_id=$1 AND scope_id=$3",[principalId,role,scopeId]);assert.equal(changed.rowCount,1,'The synthetic role assignment must exist');}
  async phase(taskId: string, phase: string,timeoutMs=10_000): Promise<any> {
    return until(async () => { const task = await this.status(taskId); return task.phase === phase ? task : false; },timeoutMs);
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

export async function setup(t: TestContext, overrides: Record<string, string> = {}, identityInput:unknown[]=identities): Promise<Harness> {
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
    await writeFile(`${scratch}/identities.json`, JSON.stringify({ identities:identityInput }), { mode: 0o600 });
    const env = { ...process.env, CIRCLE_SERVER_DATABASE_CONFIG: JSON.stringify(databaseConfig),
      CIRCLE_SERVER_DATA_DIR: `${scratch}/objects`, CIRCLE_SERVER_DEV_IDENTITIES: `${scratch}/identities.json`,
      CIRCLE_SERVER_DEV_AUTH: '1', CIRCLE_SERVER_PORT: '0', CIRCLE_SERVER_POLL_MS: '30',
      CIRCLE_SYNTHETIC_RESOURCE_DIR: `${scratch}/resources`, ...overrides };
    const harness = new Harness(scratch, postgres, new pg.Pool(databaseConfig), env);
    t.after(() => harness.close()); await harness.startServer(); return harness;
  } catch (error) { if (!started) await rm(scratch, { recursive: true, force: true }); throw error; }
}
