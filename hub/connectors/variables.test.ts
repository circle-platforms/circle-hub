import {ENVIRONMENT} from '../../contracts/generated/vocabulary.ts';
// Synthetic deployment references, migration and live credential binding.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openConnectorKit } from './testing/kit.ts';
import { SecretReference } from '../../contracts/src/variables.ts';
let pg: TemporaryPostgres;
before(async () => { pg = await startPostgres(); });
after(() => pg?.stop());
const input = { system_pack: 'agile-test', name: 'DEMO_RESOURCE', environment: 'test' as const, origins: { 'agile-api': 'http://192.0.2.10', 'agile-oauth': 'http://192.0.2.10' }, allow_plaintext: ['http://192.0.2.10'] };
test('resource credentials require explicit names and references preserve their exact grammar', async (t) => {
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    assert.equal(SecretReference.safeParse('${secret:DEMO_PASSWORD}').success, true);
    await assert.rejects(k.connectors.admin.addResource(k.admin, input), /凭据项/);
    const r = await k.connectors.admin.addResource(k.admin, { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } });
    assert.deepEqual(r.credentials, { username: '${secret:DEMO_USER}', password: '${secret:DEMO_PASSWORD}' });
    const d = await k.connectors.admin.describe(k.admin, r.id);
    assert.equal(d?.credentials[0].set, false);
});
test('resource variable references are required, settings merge by key, and credentials never resolve in settings', async (t) => {
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const named = { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } };
    await assert.rejects(k.connectors.admin.addResource(k.admin, { ...named, settings: { root: '${var:DEMO_ROOT}' } }), /var set/);
    await k.records.variables.setVariable(k.admin, 'DEMO_ROOT', 'demo-root', 'DEMO_REASON');
    const r = await k.connectors.admin.addResource(k.admin, { ...named, settings: { root: '${var:DEMO_ROOT}', keep: 'demo' } });
    const changed = await k.connectors.admin.updateResource(k.admin, r.id, { settings: { other: 'value' } });
    assert.deepEqual(changed.settings, { root: '${var:DEMO_ROOT}', keep: 'demo', other: 'value' });
    await assert.rejects(k.connectors.admin.updateResource(k.admin, r.id, { settings: { bad: '${secret:DEMO_PASSWORD}' } }), /普通变量/);
});
test('two resources share credential versions: rotation refreshes sessions and one refused version stops both processes', async (t) => {
    const { startAgileStub, agileFixture } = await import('./testing/agile.ts');
    const { resourceConsumer } = await import('./resources.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const stub = await startAgileStub(agileFixture('demo-document', { password: 'DEMO!Password42' }));
    t.after(() => stub.close());
    const common = { ...input, origins: { 'agile-api': stub.origin, 'agile-oauth': stub.origin }, allow_plaintext: [stub.origin], credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' }, settings: { 'root#': '${var:DEMO_ROOT}' } };
    await k.records.variables.setVariable(k.admin, 'DEMO_ROOT', 'demo-root', 'DEMO_REASON');
    const first = await k.connectors.admin.addResource(k.admin, common), second = await k.connectors.admin.addResource(k.admin, { ...common, name: 'DEMO_SECOND',environment:'production' });
    const set = async (password: string) => k.records.variables.setSecrets(k.admin, [{ name: 'DEMO_USER', value: 'reader', short: true, consumers: [first, second].map(r => resourceConsumer(r, 'username')) }, { name: 'DEMO_PASSWORD', value: password, consumers: [first, second].map(r => resourceConsumer(r, 'password')) }], 'DEMO_ROTATION');
    await set('DEMO!Password42');
    const other = k.make();
    const read = (r: typeof first, c = k.connectors) => c.executeRead(r.id, 'tree', { id: '7714' }, { principal: k.user, purpose: 'DEMO' });
    for (const [r, c] of [[first, k.connectors], [second, other]] as const) {
        const answer = await read(r, c);
        assert.equal(answer.ok, true, answer.ok ? '' : answer.reason);
    }
    assert.equal(stub.logins, 2);
    stub.setPassword('DEMO!Password43');
    stub.expireTokens();
    await set('DEMO!Password43');
    for (const [r, c] of [[first, k.connectors], [second, other]] as const)
        assert.equal((await read(r, c)).ok, true);
    assert.equal(stub.logins, 4);
    const outcome = await read(first);
    assert.equal(outcome.ok, true);
    if (outcome.ok) {
        const row = await k.records.store.get<any>(outcome.manifest);
        assert.equal(row?.body.variables[0].name, 'DEMO_ROOT');
        assert.equal(row?.body.variables[0].at, first.id + '#/settings/root#');
        assert.ok(row?.body.inputs.length >= 4);
    }
    await set('DEMO!Incorrect44');
    const before = stub.logins;
    const answers = await Promise.all([read(first), read(second, other)]);
    assert.ok(answers.every(a => !a.ok));
    assert.equal(stub.logins, before + 1);
    const sent = stub.requests.length;
    await read(second, other);
    assert.equal(stub.requests.length, sent);
    await k.connectors.admin.resetLogin(k.admin, first.id);
    await read(second, other);
    assert.equal(stub.logins, before + 2);
});
test('legacy migration commits both decisions, rejects a destination change, and removes the old entry last', async (t) => {
    const { canonicalBytes } = await import('../records/api.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const r = await k.connectors.admin.addResource(k.admin, { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } });
    const old = { ...r, credentials: { username: `connector.${r.id}.username`, password: `connector.${r.id}.password` } };
    const object = await k.records.objects.put(canonicalBytes(old), 'application/json');
    await k.records.authorizations.configureResource(k.admin, r.id, object.sha256, 'DEMO_LEGACY');
    await k.records.vault.put(old.credentials.username, 'demo-reader');
    await assert.rejects(k.connectors.admin.updateResource(k.admin, r.id, { credentials: { username: 'DEMO_USER' }, allow_plaintext: ['http://192.0.2.11'], origins: { 'agile-api': 'http://192.0.2.11', 'agile-oauth': 'http://192.0.2.11' } }), /分开做/);
    const changed = await k.connectors.admin.updateResource(k.admin, r.id, { credentials: { username: 'DEMO_USER' } });
    assert.equal(changed.credentials.username, '${secret:DEMO_USER}');
    assert.equal(await k.records.vault.has(old.credentials.username), false);
    assert.equal((await k.records.variables.list(k.admin)).find(v => v.name === 'DEMO_USER')?.version, 1);
    const again = await k.connectors.admin.updateResource(k.admin, r.id, { credentials: { password: 'DEMO_PASSWORD' } });
    assert.equal(again.credentials.password, '${secret:DEMO_PASSWORD}');
});
test('migrations retain only the current and previous named secret entries', async (t) => {
    const { canonicalBytes } = await import('../records/api.ts');
    const { resourceConsumer } = await import('./resources.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const named = { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } };
    const first = await k.connectors.admin.addResource(k.admin, named);
    await k.records.variables.setSecrets(k.admin, [{ name: 'DEMO_USER', value: 'demo-reader', consumers: [resourceConsumer(first, 'username')] }], 'DEMO_INITIAL');
    for (let index = 0; index < 2; index++) {
        const r = await k.connectors.admin.addResource(k.admin, { ...named, name: 'DEMO_MIGRATION_' + index,environment:ENVIRONMENT.filter(value=>value!=='test')[index] });
        const legacy = { ...r, credentials: { ...r.credentials, username: `connector.${r.id}.username` } };
        const object = await k.records.objects.put(canonicalBytes(legacy), 'application/json');
        await k.records.authorizations.configureResource(k.admin, r.id, object.sha256, 'DEMO_LEGACY');
        await k.records.vault.put(legacy.credentials.username, 'demo-reader');
        await k.connectors.admin.updateResource(k.admin, r.id, { credentials: { username: 'DEMO_USER' } });
    }
    assert.equal((await k.records.vault.list()).filter(entry => entry.startsWith('secret.demo_user.')).length, 2);
    const current = (await k.records.variables.list(k.admin)).find(v => v.name === 'DEMO_USER');
    assert.equal(current?.version, 3);
    assert.equal(current?.definition?.schema === 'secret@1' ? current.definition.consumers.length : 0, 3);
});
test('a post-commit legacy deletion failure is explicitly recoverable by repeating the same update', async (t) => {
    const { canonicalBytes } = await import('../records/api.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const r = await k.connectors.admin.addResource(k.admin, { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } });
    const entry = `connector.${r.id}.username`, legacy = { ...r, credentials: { ...r.credentials, username: entry } };
    const object = await k.records.objects.put(canonicalBytes(legacy), 'application/json');
    await k.records.authorizations.configureResource(k.admin, r.id, object.sha256, 'DEMO_LEGACY');
    await k.records.vault.put(entry, 'demo-reader');
    let fail = true;
    const vault = new Proxy(k.records.vault, { get(target, key) { if (key === 'remove')
            return async (name: string) => { if (fail && name === entry) {
                fail = false;
                throw new Error('DEMO_DENIED');
            } return target.remove(name); }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
    const connector = k.make({ records: { ...k.records, vault } });
    await assert.rejects(connector.admin.updateResource(k.admin, r.id, { credentials: { username: 'DEMO_USER' } }), /已提交.*重跑同一 resource update/);
    assert.equal(await k.records.vault.has(entry), true);
    await connector.admin.updateResource(k.admin, r.id, { credentials: { username: 'DEMO_USER' } });
    assert.equal(await k.records.vault.has(entry), false);
    assert.equal((await k.records.variables.list(k.admin)).find(v => v.name === 'DEMO_USER')?.version, 1);
});
test('legacy digest migration compares under the credential rule and preserves an existing plain named value', async (t) => {
    const { createHash } = await import('node:crypto');
    const { canonicalBytes } = await import('../records/api.ts');
    const { resourceConsumer } = await import('./resources.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const value = 'DEMO!Password42';
    const r = await k.connectors.admin.addResource(k.admin, { ...input, credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } });
    await k.records.variables.setSecrets(k.admin, [{ name: 'DEMO_PASSWORD', value, consumers: [resourceConsumer(r, 'password')] }], 'DEMO_INITIAL');
    const entry = `connector.${r.id}.password`, legacy = { ...r, credentials: { ...r.credentials, password: entry } };
    const bytes = await k.records.objects.put(canonicalBytes(legacy), 'application/json');
    await k.records.authorizations.configureResource(k.admin, r.id, bytes.sha256, 'DEMO_LEGACY');
    await k.records.vault.put(entry, createHash('sha512').update(value).digest('base64'));
    await k.connectors.admin.updateResource(k.admin, r.id, { credentials: { password: 'DEMO_PASSWORD' } });
    const version = (await k.records.variables.list(k.admin)).find(v => v.name === 'DEMO_PASSWORD');
    assert.equal(version?.definition?.schema === 'secret@1' ? version.definition.digest_rule : null, 'plain');
    assert.equal(version?.version, 2);
    assert.equal(await k.records.vault.has(entry), false);
});
test('an actual second process sees new variable and credential decisions without restarting', { timeout: 30000 }, async (t) => {
    const { spawn } = await import('node:child_process');
    const { createInterface } = await import('node:readline');
    const { startAgileStub, agileFixture } = await import('./testing/agile.ts');
    const { addSyntheticResource, setSyntheticCredentials, setSyntheticCredential } = await import('./testing/credentials.ts');
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const password = 'Demo!ProcessPassword42', changed = 'Demo!ProcessPassword43';
    const server = await startAgileStub(agileFixture('demo-document', { password }));
    t.after(() => server.close());
    const first = await k.records.variables.setVariable(k.admin, 'DEMO_ROOTS', ['7714'], 'DEMO_INITIAL');
    const r = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, { ...input, origins: { 'agile-api': server.origin, 'agile-oauth': server.origin }, allow_plaintext: [server.origin], settings: { roots: '${var:DEMO_ROOTS}' } });
    await setSyntheticCredentials(k.records, k.connectors, k.admin, r.id, { username: 'reader', password });
    const worker = String.raw `import {createInterface} from 'node:readline';
 let kit,connectors,init;
 for await(const line of createInterface({input:process.stdin})) {
  try {const message=JSON.parse(line);
   if(!kit){init=message;const records=await import(init.modules.records);const api=await import(init.modules.connectors);kit=await records.openRecords(init.config,{migrate:false,keyProvider:new records.FileKeyProvider(init.config.dataDir+'/test-vault.key')});connectors=api.createConnectors({records:kit,packs:{pack:async ref=>init.handles.find(h=>h.id===ref||h.id+'@'+h.version===ref)??null},resourceCacheMs:0,sandbox:{requireOsIsolation:false}});process.stdout.write(JSON.stringify({ready:true})+'\n');continue;}
   const result=await connectors.executeRead(init.resource,'tree',{id:'7714'},{principal:init.user,purpose:'DEMO_PROCESS'});let uses=[];if(result.manifest)uses=(await kit.store.get(result.manifest))?.body.variables??[];process.stdout.write(JSON.stringify({ok:result.ok,uses})+'\n');
  }catch{process.stdout.write(JSON.stringify({error:true})+'\n');}
 }if(kit)await kit.close();`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    const messages: any[] = [], waiters: Array<(v: any) => void> = [];
    let stderr = '';
    child.stderr.on('data', b => { stderr += String(b); });
    createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); const take = waiters.shift(); if (take)
        take(message);
    else
        messages.push(message); });
    const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise<any>(resolve => waiters.push(resolve));
    child.stdin.write(JSON.stringify({ config: { ...k.records.config, database: k.records.database }, modules: { records: new URL('../records/index.ts', import.meta.url).href, connectors: new URL('./api.ts', import.meta.url).href }, handles: Object.values(k.handles), resource: r.id, user: k.user }) + '\n');
    assert.equal((await next()).ready, true);
    const read = async () => { child.stdin.write('{}\n'); return next(); };
    const a = await read();
    assert.equal(a.ok, true);
    assert.equal(a.uses.find((u: any) => u.name === 'DEMO_ROOTS').decision, first.value.decision.digest);
    const second = await k.records.variables.setVariable(k.admin, 'DEMO_ROOTS', ['7714', '7001'], 'DEMO_CHANGED');
    server.setPassword(changed);
    server.expireTokens();
    await setSyntheticCredential(k.records, k.connectors, k.admin, r.id, 'password', changed);
    const before = server.logins, b = await read();
    assert.equal(b.ok, true);
    assert.equal(b.uses.find((u: any) => u.name === 'DEMO_ROOTS').decision, second.value.decision.digest);
    assert.equal(server.logins, before + 1);
    await setSyntheticCredential(k.records, k.connectors, k.admin, r.id, 'password', 'Demo!Incorrect44');
    const attempts = server.logins;
    child.stdin.write('{}\n');
    const parent = k.connectors.executeRead(r.id, 'tree', { id: '7714' }, { principal: k.user, purpose: 'DEMO_PROCESS' });
    assert.equal((await next()).ok, false);
    assert.equal((await parent).ok, false);
    assert.equal(server.logins, attempts + 1);
    for (const value of [password, changed, 'Demo!Incorrect44'])
        assert.ok(!stderr.includes(value));
});

test('credential descriptions distinguish wire rules, actual named storage rules and withdrawal metadata',async t=>{
 const {resourceConsumer}=await import('./resources.ts');const k=await openConnectorKit(pg);t.after(()=>k.close());
 const r=await k.connectors.admin.addResource(k.admin,{...input,credentials:{username:'DEMO_USER',password:'DEMO_PASSWORD'}});
 await k.records.variables.setSecrets(k.admin,[{name:'DEMO_PASSWORD',value:'Demo!Metadata42',consumers:[resourceConsumer(r,'password')]}],'DEMO_METADATA');
 const active=(await k.connectors.admin.describe(k.admin,r.id))!.credentials.find(c=>c.name==='password')!;assert.equal(active.digest,'sha512_base64');assert.equal(active.stored_digest,'plain');assert.equal(active.version,1);assert.equal(active.length,15);
 await k.records.variables.unset(k.admin,'secret','DEMO_PASSWORD','DEMO_WITHDRAW');const withdrawn=(await k.connectors.admin.describe(k.admin,r.id))!.credentials.find(c=>c.name==='password')!;assert.equal(withdrawn.set,false);assert.equal(withdrawn.version,1);assert.equal(withdrawn.revoked,true);
});

test('a new definition read never joins an older load after explicit invalidation',async t=>{
 const {ResourceRegistry}=await import('./resources.ts');const {ProfileCache}=await import('./profiles.ts');const {canonicalBytes}=await import('../records/api.ts');
 const k=await openConnectorKit(pg);t.after(()=>k.close());const r=await k.connectors.admin.addResource(k.admin,{...input,credentials:{username:'DEMO_USER',password:'DEMO_PASSWORD'}});
 const registry=new ResourceRegistry({objects:k.records.objects,store:k.records.store,variables:k.records.variables,authorizations:k.records.authorizations,principals:k.records.principals,vault:k.records.vault,profiles:new ProfileCache(k.packs),redactor:k.connectors.redactor,now:k.clock.now});
 let release!:()=>void,arrived!:()=>void;const paused=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>arrived=r);let first=true;
 const history=k.records.authorizations.history.bind(k.records.authorizations);k.records.authorizations.history=async query=>{const rows=await history(query);if(first&&query.permission==='resource_config'){first=false;arrived();await paused;}return rows;};
 const old=registry.states();await ready;const fresh=await k.records.objects.put(canonicalBytes({...r,name:'DEMO_FRESH'}),'application/json');await k.records.authorizations.configureResource(k.admin,r.id,fresh.sha256,'DEMO_UPDATE');
 registry.invalidate();const current=registry.states();release();assert.equal((await old)[0].resource.name,r.name);assert.equal((await current)[0].resource.name,'DEMO_FRESH');
});
