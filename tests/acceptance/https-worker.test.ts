import {sandboxTest} from './harness.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { setup, root, until, type Harness } from './harness.ts';
import { loopbackTLS, checkedRequest } from '../fixtures/loopback-tls.ts';
import { moduleFixture } from '../fixtures/module.ts';
import { scriptModel } from '../fixtures/script-model.ts';
import { sha256, canonicalHash } from '../../packages/contracts/src/index.ts';
async function worker(t: any, h: Harness, extra: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, ['apps/worker/src/main.ts'], { cwd: root, env: { ...h.env, CIRCLE_HUB_URL: h.url, CIRCLE_WORKER_USERNAME: 'lab-east-01', CIRCLE_WORKER_PASSWORD: 'synthetic-only-password', NODE_EXTRA_CA_CERTS: undefined, NODE_TLS_REJECT_UNAUTHORIZED: undefined, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    h.children.add(child);
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => stdout += data);
    child.stderr!.on('data', data => stderr += data);
    return { child, output: () => ({ stdout, stderr }) };
}
async function tlsServer(t: any, san?: string) {
    const h = await setup(t), tls = await loopbackTLS(t, san);h.clientCA=tls.ca;
    await h.stop();
    h.env.CIRCLE_HUB_TLS_CONFIG = tls.configFile;
    await h.startServer();
    const raw = async (path: string, body?: unknown, token?: string) => checkedRequest(`${h.url}${path}`, { ca: tls.ca, headers: { 'x-scope-id': 'scp_lab', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const login = async (username = 'alice') => { const response = await raw('/v1/auth/dev-login', { username, password: 'synthetic-only-password' }); assert.equal(response.status, 200); return (await response.json() as any).data.token; };
    const call = async (path: string, body?: unknown, username = 'alice') => { const response = await raw(path, body, await login(username)); assert.ok(response.ok, JSON.stringify(await response.clone().json())); return (await response.json() as any).data; };
    return { h, tls, raw, login, call };
}
test('HTTPS worker: trusted loopback login claim preflight source report artifact delivery and admin requests use TLS', async (t) => {
    const { h, tls, call, login } = await tlsServer(t), running = await worker(t, h, { NODE_EXTRA_CA_CERTS: tls.caFile });
    await until(async () => { assert.equal(running.child.exitCode, null, running.output().stderr); return running.output().stdout.includes('worker-ready'); });
    const original = Buffer.from(JSON.stringify({ title: 'Synthetic TLS tree', children: [{ title: 'A secure local task' }] })), source = await call('/v1/sources', { scopeId: 'scp_lab', fileName: 'tree.json', contentBase64: original.toString('base64') }), task = await call('/v1/tasks/submit', { scopeId: 'scp_lab', capabilityPackId: 'mindmap-compile', input: { sourceRevisionId: source.sourceRevisionId }, idempotencyKey: 'https-worker-compilation' });
    const result = await until(async () => { const result = await call(`/v1/tasks/${task.taskId}/result`); assert.notEqual(result.phase, 'failed', JSON.stringify(result)); return result.phase === 'delivered' ? result : false; }, 20000);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.artifacts.length, 1);
    const artifact = await checkedRequest(`${h.url}${result.artifacts[0].downloadPath}`, { ca: tls.ca, headers: { authorization: `Bearer ${await login()}` } });
    assert.equal(artifact.status, 200);
    assert.equal(sha256(Buffer.from(await artifact.arrayBuffer())), result.artifacts[0].sha256);
    const events = await call(`/v1/tasks/${task.taskId}/events?after=0`);
    assert.ok(events.events.some((event: any) => event.kind === 'task.delivered'));
    assert.ok((await call('/v1/admin/workers', undefined, 'admin')).some((entry: any) => entry.workerId === 'lab-east-01'));
    const command = await promisify(execFile)(process.execPath, ['apps/server/src/cli.ts', 'admin', 'tasks'], { cwd: root, env: { ...h.env, CIRCLE_HUB_URL: h.url, CIRCLE_HUB_TOKEN: await login('admin'), NODE_EXTRA_CA_CERTS: tls.caFile } });
    assert.ok(JSON.parse(command.stdout).some((item: any) => item.taskId === task.taskId));
});
test('HTTPS worker: absent CA and a trusted certificate with the wrong hostname never register a worker', async (t) => {
    for (const wrongHostname of [false, true]) {
        const { h, tls } = await tlsServer(t, wrongHostname ? 'DNS:synthetic.invalid' : undefined), running = await worker(t, h, wrongHostname ? { NODE_EXTRA_CA_CERTS: tls.caFile } : {});
        const [code] = await once(running.child, 'exit');
        assert.notEqual(code, 0);
        assert.match(running.output().stderr, wrongHostname ? /ALTNAME|hostname/i : /certificate|verify|issuer/i);
        assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM workers')).rows[0].n), 0);
    }
});
test('Worker server boundary: remote URLs are rejected before login and redirects cannot forward development credentials', async (t) => {
    const h = await setup(t), denied = await worker(t, h, { CIRCLE_HUB_URL: 'https://synthetic.invalid:1' });
    const [deniedCode] = await once(denied.child, 'exit');
    assert.notEqual(deniedCode, 0);
    assert.match(denied.output().stderr, /loopback|127\.0\.0\.1/i);
    let captured = 0;
    const receiver = createServer((request, response) => { captured++; request.resume(); response.end('{}'); }), redirect = createServer((request, response) => { request.resume(); response.writeHead(307, { location: `http://127.0.0.1:${(receiver.address() as any).port}/capture` }); response.end(); });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
    t.after(async () => { receiver.closeAllConnections(); redirect.closeAllConnections(); await Promise.all([new Promise<void>(resolve => receiver.close(() => resolve())), new Promise<void>(resolve => redirect.close(() => resolve()))]); });
    const rejected = await worker(t, h, { CIRCLE_HUB_URL: `http://127.0.0.1:${(redirect.address() as any).port}` });
    const [redirectCode] = await once(rejected.child, 'exit');
    assert.notEqual(redirectCode, 0);
    assert.equal(captured, 0);
});
sandboxTest('HTTPS worker: pinned headless Circle inherits the CA and uses scoped server tools over native TLS', { skip: (!process.env.CIRCLE_BIN || !process.env.CIRCLE_COMMIT) && 'Set CIRCLE_BIN and CIRCLE_COMMIT for HTTPS RPC acceptance' }, async (t) => {
    const { h, tls, call } = await tlsServer(t), model = await scriptModel(t);
    await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"knowledge.read\",\"skillpacks.submit\",\"skillpacks.read\",\"skillpacks.run\"]'::jsonb WHERE principal_id='prn_alice'");
    await h.db.query("UPDATE policies SET grants=grants || '[\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'");
    await writeFile(`${h.scratch}/runtime.json`, JSON.stringify({ circleBin: process.env.CIRCLE_BIN, circleCommit: process.env.CIRCLE_COMMIT, circleVersion: '1.7.0', model: { kind: 'scripted', base_url: model.url, model: 'scripted-fixture', protocol: 'openai', api_key: model.key } }));
    h.env.CIRCLE_RUNTIME_CONFIG = `${h.scratch}/runtime.json`;
    await h.stop();
    await h.startServer();
    const asset = await call('/v1/assets', { scopeId: 'scp_lab', kind: 'connector-instance', name: 'Synthetic TLS knowledge', version: '1.0.0', declaration: { reads: ['registered-source'], writes: ['knowledge-candidates'], credentials: [] }, configuration: { packageId: 'knowledge' }, readers: ['prn_alice'] });
    await call(`/v1/assets/${asset.assetId}/lifecycle`, { version: asset.version, sha256: asset.sha256, state: 'approved' }, 'bob');
    await call(`/v1/assets/${asset.assetId}/lifecycle`, { version: asset.version, sha256: asset.sha256, state: 'running' });
    const fixture: any = moduleFixture();
    fixture.manifest.tools = ['knowledge.shared_fragments'];
    const manifestFile = fixture.files.find((file: any) => file.path === 'skillpack.json')!;
    manifestFile.base64 = Buffer.from(JSON.stringify(fixture.manifest)).toString('base64');
    manifestFile.sha256 = sha256(Buffer.from(manifestFile.base64, 'base64'));
    fixture.module.files = fixture.files.map(({ path, sha256 }: any) => ({ path, sha256 })).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    fixture.module.digest = sha256(fixture.module.files.map((file: any) => `${file.sha256}  ${file.path}\n`).join(''));
    fixture.trial.toolCalls = [{ name: 'knowledge.shared_fragments', argsSha256: canonicalHash({}), ok: true }];
    const pack = await call('/v1/modules/install', { module: fixture.module, files: fixture.files, trial: fixture.trial }), approval = (await call(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0];
    await call(`/v1/tasks/${pack.approvalTaskId}/approvals/${approval.approvalId}`, { inputRevisionId: approval.inputRevisionId, targetIdentity: approval.targetIdentity, actionDigest: approval.actionDigest, approve: true }, 'bob');
    model.state.sequence = [{ name: 'skill', args: { name: fixture.module.id } }, { name: 'hub_tool_knowledge_shared_fragments', args: {} }, { name: 'execute', args: { command: `node .circle/skills/${fixture.module.id}/scripts/report.ts` } }];
    const running = await worker(t, h, { NODE_EXTRA_CA_CERTS: tls.caFile });
    await until(async () => { assert.equal(running.child.exitCode, null, running.output().stderr); return running.output().stdout.includes('worker-ready'); });
    const run = await call(`/v1/skillpacks/${pack.skillPackId}/runs`, { inputs: {}, idempotencyKey: 'https-rpc-module' });
    const result = await until(async () => { const result = await call(`/v1/tasks/${run.taskId}/result`); assert.notEqual(result.phase, 'failed', JSON.stringify(result)); return result.phase === 'delivered' ? result : false; }, 20000);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.artifacts.length, 1);
    assert.ok(model.requests.length > 0);
    assert.deepEqual((await h.db.query("SELECT o.status FROM operations o JOIN tasks t USING(task_id) WHERE t.context->>'parentRunTaskId'=$1 AND o.name='tools.invoke'", [run.taskId])).rows, [{ status: 'succeeded' }]);
});
