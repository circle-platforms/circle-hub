import {addSyntheticExecutor} from './testing/credentials.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { ExecutorRegistry } from './executors.ts';
import { definition } from './testing/definition.ts';

test('executor definitions are canonical, authorized by digest, versioned and disabled without changing history', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
  const registry = new ExecutorRegistry(kit);
  const first = await addSyntheticExecutor(kit,registry,admin,definition('http://127.0.0.1:1/mcp'),'synthetic-secret');
  assert.equal(await kit.vault.has(`executor.${first.id}.bearer`),false);assert.equal((await kit.variables.list(admin)).filter(v=>v.kind==='secret').length,1);
  assert.equal((await registry.get(first.id))?.digest, first.digest);
  const next = await registry.update(admin, first.id, { ...first.definition, max_run_ms: 6000 });
  assert.notEqual(next.digest, first.digest);
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await kit.objects.get(first.digest))!)), first.definition);
  await registry.disable(admin, first.id);
  assert.equal((await registry.get(first.id))?.definition.enabled, false);
  assert.equal((await registry.list(admin)).length, 1);
  const user = await kit.principals.createUser(admin, '合成用户');
  await assert.rejects(registry.update(user, first.id, first.definition));
});

test('definitions reject external plaintext, unlisted calls, invalid mapping values and missing fixed CAs', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
  const registry = new ExecutorRegistry(kit);
  for (const input of [definition('http://192.0.2.1/mcp'), definition('https://192.0.2.1/mcp'),
    { ...definition('http://127.0.0.1:1/mcp'), allowed_tools: [] },
    { ...definition('http://127.0.0.1:1/mcp'), status: { pointer: '/state', map: { fake: { effect_outcome: 'invented' } } } },
  ]) await assert.rejects(addSyntheticExecutor(kit,registry,admin,input,'synthetic-secret'));
});

test('write declarations preserve source positions and restrict executors to job effects',async()=>{
 const {ExecutorDefinition,ExecutorSource}=await import('../../contracts/src/resources.ts');
 const raw=definition('http://127.0.0.1:1/mcp');
 const write={interaction:'submit_then_read',effect_class:'job',retry_safety:'same_key_safe',signing:'service_on_behalf',reversible:false,target_key:{$value:'resources'},audience:null,evidence:{call:raw.calls.result.tool,pointer:raw.result.sha256},refusal:{stage:'/stage',reached_device:'/reached'},writes_hub_records:true};
 const value={...raw,receipt:{...raw.receipt,stage:'/stage',reached_device:'/reached'},calls:{...raw.calls,submit:{...raw.calls.submit,write}}};
 assert.ok(ExecutorDefinition.safeParse(value).success);assert.ok(ExecutorSource.safeParse(value).success);
 for(const patch of [{effect_class:'sync_write'},{audience:'outside-space'},{writes_hub_records:false},{evidence:{call:'wrong',pointer:'/digest'}}])assert.equal(ExecutorDefinition.safeParse({...value,calls:{...value.calls,submit:{...value.calls.submit,write:{...write,...patch}}}}).success,false);
 assert.equal(ExecutorSource.safeParse({...value,environment:'${var:DEMO_ENV}'}).success,false);
 assert.equal(ExecutorSource.safeParse({...value,calls:{...value.calls,submit:{...value.calls.submit,write:{...write,target_key:'${var:DEMO_TARGET}'}}}}).success,false);
});
