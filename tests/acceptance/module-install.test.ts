import {sandboxTest} from './harness.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../../packages/contracts/src/index.ts';
import { setup, root, until } from './harness.ts';
import { moduleFixture } from '../fixtures/module.ts';
import { scriptModel } from '../fixtures/script-model.ts';
async function environment(t: any) { const h = await setup(t); await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"knowledge.read\",\"skillpacks.read\",\"skillpacks.submit\",\"skillpacks.run\"]'::jsonb WHERE principal_id='prn_alice'"); await h.db.query("UPDATE policies SET grants=grants || '[\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'"); const post = async (value: any, scope = 'scp_lab') => { const { manifest, ...input } = value; const response = await fetch(`${h.url}/v1/modules/install`, { method: 'POST', headers: { authorization: `Bearer ${await h.login()}`, 'content-type': 'application/json', 'x-scope-id': scope }, body: JSON.stringify(input) }); return { status: response.status, body: await response.json() as any }; }; return { h, post }; }
test('Module install: frozen skills use ordinary trial registration and independent approval with the module digest bound', async (t) => {
    const { h, post } = await environment(t), fixture = moduleFixture(), response = await post(fixture);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const installed = response.body.data;
    assert.equal(installed.digest, fixture.module.digest);
    assert.equal(installed.lifecycle, 'draft');
    assert.equal(installed.status, 'candidate');
    assert.ok(installed.approvalTaskId);
    assert.equal((await h.request('/v1/skillpacks'))[0].skillPackId, installed.skillPackId);
    const definition = await h.request(`/v1/assets/${installed.assetId}`);
    assert.deepEqual(definition.configuration.module, fixture.module);
    await h.reject(`/v1/skillpacks/${installed.skillPackId}/runs`, { inputs: {}, idempotencyKey: 'module-before-approval' }, 'APPROVAL_REQUIRED');
    const replay = (await post(fixture)).body.data;
    assert.equal(replay.skillPackId, installed.skillPackId);
    assert.equal(replay.assetId, installed.assetId);
    const approval = (await h.request(`/v1/tasks/${installed.approvalTaskId}/approvals`))[0];
    await h.request(`/v1/tasks/${installed.approvalTaskId}/approvals/${approval.approvalId}`, { inputRevisionId: approval.inputRevisionId, targetIdentity: approval.targetIdentity, actionDigest: approval.actionDigest, approve: true }, 'bob');
    assert.equal((await h.request('/v1/skillpacks'))[0].status, 'registered');
    const files = (await h.db.query('SELECT files FROM skill_packages WHERE skill_pack_id=$1', [installed.skillPackId])).rows[0].files;
    assert.deepEqual(files.map((file: any) => ({ path: file.path, sha256: file.sha256 })), fixture.module.files);
    assert.equal((await post(fixture)).body.data.lifecycle, 'approved');
    await h.request(`/v1/assets/${installed.assetId}/lifecycle`, { version: definition.version, sha256: definition.sha256, state: 'disabled' });
    assert.equal((await post(fixture)).body.data.lifecycle, 'disabled');
    await h.reject(`/v1/skillpacks/${installed.skillPackId}/runs`, { inputs: {}, idempotencyKey: 'module-disabled-replay' }, 'APPROVAL_STALE');
});
test('Module install: corrupt bytes or manifest bindings and missing trials fail before creating assets or approval tasks', async (t) => {
    const { h, post } = await environment(t), fixture = moduleFixture(), before = Number((await h.db.query('SELECT count(*) AS n FROM assets')).rows[0].n);
    for (const input of [{ ...fixture, files: fixture.files.slice(1) }, { ...fixture, module: { ...fixture.module, digest: '0'.repeat(64) } }, { ...fixture, module: { ...fixture.module, manifestPath: 'skills/other/skillpack.json' } }, { ...fixture, trial: undefined }])
        assert.ok((await post(input)).status >= 400);
    assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM assets')).rows[0].n), before);
    assert.equal(Number((await h.db.query('SELECT count(*) AS n FROM skill_packages')).rows[0].n), 0);
    assert.equal((await post(fixture, 'scp_hidden')).body.error.code, 'FORBIDDEN_SCOPE');
    await h.setRole('prn_outsider','viewer');const hidden = (await h.raw('/v1/modules/install', { token: await h.login('outsider'), body: { module: fixture.module, files: fixture.files, trial: fixture.trial } }));
    assert.equal(hidden.status, 403);
});
test('Module install: product-line bytes become an ordinary draft source asset and cannot auto-enable executable code', async (t) => {
    const { h, post } = await environment(t), fixture = moduleFixture('product-line');
    fixture.files.push({ path: 'empty.txt', base64: '', sha256: sha256(Buffer.alloc(0)) });
    fixture.module.files = fixture.files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    fixture.module.digest = sha256(fixture.module.files.map(file => `${file.sha256}  ${file.path}\n`).join(''));
    const response = await post(fixture);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const installed = response.body.data;
    assert.equal(installed.kind, 'product-line');
    assert.equal(installed.lifecycle, 'draft');
    assert.equal(installed.skillPackId, undefined);
    const asset = await h.request(`/v1/assets/${installed.assetId}`);
    assert.equal(asset.kind, 'knowledge-source');
    assert.equal(asset.configuration.metadata.module.digest, fixture.module.digest);
    assert.equal(asset.configuration.files.length, 5);
    assert.equal(asset.configuration.files.find((file: any) => file.path === 'empty.txt').size, 0);
    await h.request(`/v1/assets/${installed.assetId}/lifecycle`, { version: asset.version, sha256: asset.sha256, state: 'approved' }, 'bob');
    for (const file of asset.configuration.files) {
        const read = await fetch(`${h.url}/v1/sources/${file.sourceRevisionId}/content`, { headers: { authorization: `Bearer ${await h.login()}` } });
        assert.equal(read.status, 200);
        assert.equal(sha256(Buffer.from(await read.arrayBuffer())), file.sha256);
    }
    assert.equal((await h.request('/v1/tools')).length, 0);
    await h.reject('/v1/sources', { scopeId: 'scp_lab', fileName: 'empty.txt', contentBase64: '' }, 'INVALID_PAYLOAD');
});
test('Module install: CLI freezes a local catalog and submits its complete module without putting runtime paths in the receipt', async (t) => {
    const { h } = await environment(t), fixture = moduleFixture(), directory = `${h.scratch}/external`, folder = `${directory}/${fixture.module.root}`;
    await mkdir(`${folder}/tests`, { recursive: true });
    await mkdir(`${folder}/scripts`, { recursive: true });
    for (const file of fixture.files)
        await writeFile(`${folder}/${file.path}`, Buffer.from(file.base64, 'base64'));
    await writeFile(`${directory}/modules.json`, JSON.stringify({ schema: 'circle-packs/modules/1', modules: [fixture.module] }));
    await writeFile(`${h.scratch}/trial.json`, JSON.stringify(fixture.trial));
    const { stdout } = await promisify(execFile)(process.execPath, ['apps/server/src/cli.ts', 'modules', 'install', '--catalog', `${directory}/modules.json`, '--module', fixture.module.id, '--trial', `${h.scratch}/trial.json`, '--scope', 'scp_lab'], { cwd: root, env: { ...h.env, CIRCLE_HUB_URL: h.url, CIRCLE_HUB_TOKEN: await h.login() } }), receipt = JSON.parse(stdout);
    assert.equal(receipt.digest, fixture.module.digest);
    assert.equal(receipt.status, 'candidate');
    assert.ok(!stdout.includes(h.scratch));
});
sandboxTest('Module install: approved frozen bytes run through real pinned Circle even after the external source changes', { skip: (!process.env.CIRCLE_BIN || !process.env.CIRCLE_COMMIT) && 'Set CIRCLE_BIN and CIRCLE_COMMIT for module RPC acceptance' }, async (t) => {
    const { h, post } = await environment(t), model = await scriptModel(t), fixture = moduleFixture();
    await writeFile(`${h.scratch}/runtime.json`, JSON.stringify({ circleBin: process.env.CIRCLE_BIN, circleCommit: process.env.CIRCLE_COMMIT, circleVersion: '1.1.1', model: { kind: 'scripted', base_url: model.url, model: 'scripted-fixture', protocol: 'openai', api_key: model.key } }));
    h.env.CIRCLE_RUNTIME_CONFIG = `${h.scratch}/runtime.json`;
    await h.stop();
    await h.startServer();
    const response = await post(fixture);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const installed = response.body.data, approval = (await h.request(`/v1/tasks/${installed.approvalTaskId}/approvals`))[0];
    await h.request(`/v1/tasks/${installed.approvalTaskId}/approvals/${approval.approvalId}`, { inputRevisionId: approval.inputRevisionId, targetIdentity: approval.targetIdentity, actionDigest: approval.actionDigest, approve: true }, 'bob');
    fixture.files.find(file => file.path === 'scripts/report.ts')!.base64 = Buffer.from('throw new Error("Changed external file")').toString('base64');
    model.state.sequence = [{ name: 'skill', args: { name: fixture.module.id } }, { name: 'execute', args: { command: `node .circle/skills/${fixture.module.id}/scripts/report.ts` } }];
    await h.startWorker();
    const run = await h.request(`/v1/skillpacks/${installed.skillPackId}/runs`, { inputs: {}, idempotencyKey: 'module-frozen-rpc' });
    await until(async () => { const status = await h.status(run.taskId); assert.notEqual(status.phase, 'failed', JSON.stringify(await h.request(`/v1/tasks/${run.taskId}/result`))); return status.phase === 'delivered'; }, 20000);
    const result = await h.request(`/v1/tasks/${run.taskId}/result`);
    assert.equal(result.artifacts.length, 1);
    const downloaded = await fetch(`${h.url}${result.artifacts[0].downloadPath}`, { headers: { authorization: `Bearer ${await h.login()}` } }), bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(sha256(bytes), result.artifacts[0].sha256);
    assert.deepEqual(JSON.parse(bytes.toString()), { source: 'frozen synthetic module' });
});
