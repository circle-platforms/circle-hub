import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {encodePersonalSyncObject,decodePersonalSyncObject,personalSyncObjectId} from './sync-canonical.ts';
import {PersonalSyncObject,PersonalSyncCommit,PersonalSyncUpload,PersonalSyncModeChange,PERSONAL_SYNC_HTTP_ROUTES} from './sync.ts';
import {TOOLS,UploadFileInput,GetNodesInput} from './tools.ts';
const fixtures=JSON.parse(readFileSync(new URL('../test-fixtures/sync/v1/encoding.json',import.meta.url),'utf8'));
test('the shared client encoding vectors fix canonical bytes and identities independently of storage',()=>{
 for(const fixture of fixtures.cases){
  assert.equal(Buffer.from(encodePersonalSyncObject(fixture.input)).toString(),fixture.canonical,fixture.name);
  assert.equal(personalSyncObjectId(fixture.input),fixture.sha256,fixture.name);
  assert.ok(PersonalSyncObject.safeParse(decodePersonalSyncObject(Buffer.from(fixture.canonical),fixture.sha256)).success);
 }
 const raw=Buffer.from(fixtures.cases[4].input.body.bytes_base64,'base64');
 assert.equal(createHash('sha256').update(raw).digest('hex'),fixtures.raw_source_sha256);
 assert.equal(raw.toString(),'\uFEFF证据\r\ne\u0301\r\n');
});
test('wire encoding rejects alternate spellings, malformed text, collisions and changed identities',()=>{
 const f=fixtures.cases[0],bytes=Buffer.from(f.canonical);
 for(const input of [Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bytes]),Buffer.from(' '+f.canonical),Buffer.from(f.canonical.replace('"body":','"body":{},"body":')),Buffer.from([0xff])])assert.throws(()=>decodePersonalSyncObject(input,f.sha256));
 assert.throws(()=>decodePersonalSyncObject(bytes,'f'.repeat(64)));
 assert.throws(()=>encodePersonalSyncObject({...f.input,body:{...f.input.body,markdown:'\ud800'}}));
 const entry={schema:'personal-sync-object@1',kind:'entry_revision',body:{item_id:f.input.body.item_id,parents:[],directory_id:f.input.body.directory_id,content:{kind:'definition',statement:'合成',data:{'é':1,'e\u0301':2},applicability:null},grounds:[]}};
 assert.throws(()=>encodePersonalSyncObject(entry),/collision/);
 for(const encoded of ['YQ','YR==','YQ==\n'])assert.equal(PersonalSyncObject.safeParse({schema:'personal-sync-object@1',kind:'bytes',body:{bytes_base64:encoded}}).success,false);
});
test('strict HTTP payloads require CAS, namespace and explicit purge intent without entering MCP',()=>{
 const epoch='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
 const commit={schema:'personal-sync-commit@1',epoch,operation_id:'synthetic-1',expected_state:hash,base_snapshot:null,snapshot:hash};
 assert.ok(PersonalSyncCommit.safeParse(commit).success);
 for(const field of ['epoch','expected_state','operation_id']){const input={...commit} as Record<string,unknown>;delete input[field];assert.equal(PersonalSyncCommit.safeParse(input).success,false);}
 assert.equal(PersonalSyncCommit.safeParse({...commit,owner:'another-member'}).success,false);
 assert.equal(PersonalSyncUpload.safeParse({schema:'personal-sync-upload@1',epoch,operation_id:'upload',objects:[{id:hash,bytes_base64:''},{id:hash,bytes_base64:''}]}).success,false);
 const mode={epoch,operation_id:'mode',mode:'local',expected_state:hash,check:hash,confirm_purge:true};
 assert.ok(PersonalSyncModeChange.safeParse(mode).success);assert.equal(PersonalSyncModeChange.safeParse({...mode,confirm_purge:false}).success,false);
 assert.equal(TOOLS.length,6);assert.equal(Object.keys(PERSONAL_SYNC_HTTP_ROUTES).length,12);
 assert.equal(UploadFileInput.safeParse({sync:commit}).success,false);assert.equal(GetNodesInput.safeParse({sync:commit}).success,false);
});
test('shared synthetic scenarios contain typed knowledge and memory with valid content identities',()=>{
 const scenarios=JSON.parse(readFileSync(new URL('../test-fixtures/sync/v1/scenarios.json',import.meta.url),'utf8'));
 for(const object of scenarios.objects)assert.ok(PersonalSyncObject.safeParse(decodePersonalSyncObject(Buffer.from(object.canonical),object.id)).success);
 const ids=new Set(scenarios.objects.map((v:{id:string})=>v.id));
 for(const scenario of scenarios.merges)for(const id of [...scenario.base,...scenario.left,...scenario.right,...scenario.expected_heads])assert.ok(ids.has(id));
 assert.equal(scenarios.transfers[1].expected_missing[0],scenarios.transfers[1].foreign_owned[0]);
 // These declarations are consumed by future service tests; this test proves fixture coherence, not live merging.
});
test('byte chunks are bounded and object identities never silently acquire content defaults',()=>{
 assert.equal(PersonalSyncObject.safeParse({schema:'personal-sync-object@1',kind:'bytes',body:{bytes_base64:Buffer.alloc(1024*1024+1).toString('base64')}}).success,false);
 const f=fixtures.cases[0];
 const entry={schema:'personal-sync-object@1',kind:'entry_revision',body:{item_id:f.input.body.item_id,directory_id:f.input.body.directory_id,parents:[],content:{kind:'definition',statement:'合成'},grounds:[]}};
 assert.equal(PersonalSyncObject.safeParse(entry).success,false);
});
test('the shared HTTP route manifest is separate from the model tool protocol',()=>{
 const http=JSON.parse(readFileSync(new URL('../test-fixtures/sync/v1/http.json',import.meta.url),'utf8'));
 assert.deepEqual(http.routes,PERSONAL_SYNC_HTTP_ROUTES);
 assert.ok(Object.values(PERSONAL_SYNC_HTTP_ROUTES).every(route=>route.path.startsWith('/api/sync/v1/')));
});
