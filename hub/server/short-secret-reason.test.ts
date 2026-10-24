// Short secrets still cannot appear verbatim in append-only reasons.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openTestRecords} from '../testing/records.ts';
import {canonicalBytes,newId,validateChangeReason} from '../records/api.ts';
import {namedSecretCommand,type VariableCommandSession} from './variables.ts';
let pg:TemporaryPostgres;before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('complete short secret spellings are rejected independently of the eight-character fragment window',()=>{
 for(const value of ['reader','a"b!','q%7'])for(const form of [value,JSON.stringify(value).slice(1,-1),encodeURIComponent(value),Buffer.from(value).toString('base64')])assert.throws(()=>validateChangeReason('合成说明 '+form,[value]),/理由不能含密钥/);
 assert.equal(validateChangeReason('合成说明',['reader']),'合成说明');
});
test('short secret CLI rejection writes neither a vault entry nor a decision and never prints the value',async t=>{
 const kit=await openTestRecords({postgres:pg});t.after(()=>kit.close());const admin=(await kit.principals.bootstrapAdmin('合成管理员')).user;const id=newId('res');
 const source={schema:'resource@1',id,system_pack:'demo-system@1.0.0',system_pack_digest:'b'.repeat(64),origins:{api:'https://service.example.invalid'},allow_plaintext:[],credentials:{username:'${secret:DEMO_LOGIN}'},credential_digests:{username:'plain'}};
 const object=await kit.objects.put(canonicalBytes(source),'application/json');await kit.authorizations.configureResource(admin,id,object.sha256,'合成引用');
 const count=(await kit.store.list({kind:'authorization'})).items.length;const output:string[]=[];
 const session:VariableCommandSession={ctx:{io:{cwd:kit.dataDir}},options:{readSecret:async()=> 'reader'},admin:async()=>admin,records:async()=>kit,hub:async()=>({registry:{variableDeclarations:async()=>[]},packs:{} as any}),out:s=>output.push(s),err:s=>output.push(s)};
 await assert.rejects(namedSecretCommand(session,['set','--name','DEMO_LOGIN','--short','DEMO_LOGIN','--reason','portal reader enrolled']),error=>error instanceof Error&&/理由不能含密钥/.test(error.message)&&!error.message.includes('reader'));
 assert.equal((await kit.store.list({kind:'authorization'})).items.length,count);assert.deepEqual(await kit.vault.list(),[]);
 assert.ok(!output.join('\n').includes('reader'));assert.ok(!JSON.stringify((await kit.store.list({kind:'authorization'})).items).includes('reader'));
});
