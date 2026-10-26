// Shared stops keep the actual deployment names in administrator repair actions.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {newId} from '../records/api.ts';
import {CredentialStop} from './credential-stop.ts';
import {ConnectorError} from './errors.ts';
test('both stopped paths provide actual secret names and the current resource reset command',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const resource=newId('res');
 const gate=new CredentialStop(kit.store,kit.vault,['a'.repeat(64)],['DEMO_LOGIN','DEMO_PASSWORD'],resource);
 await gate.epoch();await assert.rejects(gate.run(async()=>{throw new ConnectorError('LOGIN_FAILED','合成拒绝',{detail:{stopped:true}});}));
 const complete=(error:unknown)=>error instanceof ConnectorError&&error.message.includes('circle-hub secret set --name DEMO_LOGIN --name DEMO_PASSWORD')&&error.message.includes('circle-hub resource reset-login '+resource)&&!error.message.includes('<名字>');
 await assert.rejects(gate.assertOpen(),complete);let called=false;await assert.rejects(gate.run(async()=>{called=true;}),complete);assert.equal(called,false);
 const same=new CredentialStop(kit.store,kit.vault,['a'.repeat(64)],['DEMO_LOGIN','DEMO_PASSWORD'],resource);assert.equal(same.entry,gate.entry);await assert.rejects(same.assertOpen(),complete);
});
