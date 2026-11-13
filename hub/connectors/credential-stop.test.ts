// Shared stops keep the actual deployment names in administrator repair actions.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openTestRecords} from '../testing/records.ts';
import {newId} from '../records/api.ts';
import {CredentialStop} from './credential-stop.ts';
import {secretVersionKey} from './secret-version.ts';
import {ConnectorError} from './errors.ts';
test('both stopped paths provide actual secret names and the current resource reset command',async t=>{
 const kit=await openTestRecords();t.after(()=>kit.close());const resource=newId('res');
 const identities=[{name:'DEMO_LOGIN',version:1,sealed_sha256:'a'.repeat(64)},{name:'DEMO_PASSWORD',version:1,sealed_sha256:'b'.repeat(64)}];
 const versions=identities.map(secretVersionKey);
 const gate=new CredentialStop(kit.store,kit.vault,versions,['DEMO_LOGIN','DEMO_PASSWORD'],resource);
 await gate.epoch();await assert.rejects(gate.run(async()=>{throw new ConnectorError('LOGIN_FAILED','合成拒绝',{detail:{stopped:true}});}));
 const complete=(error:unknown)=>error instanceof ConnectorError&&error.message.includes('circle-hub secret set --name DEMO_LOGIN --name DEMO_PASSWORD')&&error.message.includes('circle-hub resource reset-login '+resource)&&!error.message.includes('<名字>');
 await assert.rejects(gate.assertOpen(),complete);let called=false;await assert.rejects(gate.run(async()=>{called=true;}),complete);assert.equal(called,false);
 const same=new CredentialStop(kit.store,kit.vault,[...versions].reverse(),['DEMO_LOGIN','DEMO_PASSWORD'],resource);assert.equal(same.entry,gate.entry);await assert.rejects(same.assertOpen(),complete);
 const replacement=identities.map(item=>item.name==='DEMO_LOGIN'?{...item,sealed_sha256:'c'.repeat(64)}:item);
 const changedCipher=new CredentialStop(kit.store,kit.vault,replacement.map(secretVersionKey),['DEMO_LOGIN','DEMO_PASSWORD'],resource);
 assert.notEqual(changedCipher.entry,gate.entry);await changedCipher.assertOpen();
 let usedReplacement=false;await changedCipher.run(async()=>{usedReplacement=true;});assert.equal(usedReplacement,true);
 await assert.rejects(same.assertOpen(),complete);
});
