import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {freezeEffectRegistry} from './snapshot.ts';
test('internal registration snapshots store resolved definitions using exactly the start variable values',async t=>{
 const c=await setup();t.after(()=>c.close());
 await c.kit.variables.setVariable(c.admin,'DEMO_BED','synthetic-bed','合成快照');
 await c.registry.update(c.admin,c.executor.id,{...c.executor.source,target:'${var:DEMO_BED}'});
 const variables=await c.kit.variables.snapshot(),frozen=await freezeEffectRegistry(c.kit,variables);
 const entries=JSON.parse(Buffer.from((await c.kit.objects.get(frozen.executors))!).toString()) as Record<string,string>;
 assert.equal(entries[c.executor.id],(await c.registry.get(c.executor.id,variables))!.resolved_digest);
 assert.ok(await c.kit.objects.get(entries[c.executor.id]));assert.ok(await c.kit.objects.get(frozen.policy));
 await c.kit.variables.setVariable(c.admin,'DEMO_BED','different-synthetic-bed','合成快照');
 assert.notEqual((await c.registry.get(c.executor.id))!.resolved_digest,entries[c.executor.id]);
 assert.deepEqual(await freezeEffectRegistry(c.kit,variables),frozen);
 await assert.rejects(c.registry.list(c.owner),/管理员/);
});
