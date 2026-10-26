// Expected values may refer to data, never to the choice of a runtime binding.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExecutorSource,resolveExecutorValues} from './source.ts';
import {definition} from './testing/definition.ts';
import {setup} from './testing/context.ts';
test('references under a runtime binding key are rejected at source admission',()=>{
 const base=definition('http://127.0.0.1:1/mcp');
 for(const equals of [{$value:'${var:DEMO_BIND}'},{nested:{$value:'${var:DEMO_BIND}'}}]) {
  const source={...base,conditions:[{pointer:'/build',equals}]};
  assert.equal(ExecutorSource.safeParse(source).success,false);
  assert.throws(()=>resolveExecutorValues(source as any,new Map([['DEMO_BIND','lease_token']])));
 }
 assert.equal(ExecutorSource.safeParse({...base,conditions:[{pointer:'/build',equals:{$value:'build'}}]}).success,true,'literal administrator bindings remain explicit');
});
test('executor registration and updates reject variable-controlled runtime bindings',async t=>{
 const c=await setup();t.after(()=>c.close());await c.kit.variables.setVariable(c.admin,'DEMO_BIND','lease_token','DEMO_BIND');
 const source={...c.executor.source,conditions:[{pointer:'/build',equals:{$value:'${var:DEMO_BIND}'}}]};
 await assert.rejects(c.registry.add(c.admin,source),/期望值.*字面.*调用绑定/);await assert.rejects(c.registry.update(c.admin,c.executor.id,source),/期望值.*字面.*调用绑定/);
 assert.equal((await c.registry.get(c.executor.id))!.digest,c.executor.digest);
});
