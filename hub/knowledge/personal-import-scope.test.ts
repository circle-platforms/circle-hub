import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeWorld,startPostgres} from './test-support.ts';
test('personal knowledge imports do not deduplicate onto independent pack captures at the same timestamp',async t=>{
 const postgres=await startPostgres();t.after(()=>postgres.stop());const w=await makeWorld(postgres,{now:()=>new Date('2026-11-03T00:00:00.000Z')});t.after(w.close);
 const bytes=Buffer.from('synthetic independent pack file');
 const independent=await w.kit.artifacts.ingest({bytes,mediaType:'text/plain',name:'SKILL.md',origin:{upload:{session:null,message:null}},author:{user:w.user.id,declared:null},provenanceType:'declared',visibility:{readers:[w.user.id],admins:false,packs:[],shareable:false},readTier:'model_readable'});
 const source=await w.knowledge.spaces!.importFile(w.user,bytes,'text/plain','SKILL.md','/',null);
 assert.notEqual(source.digest,independent.digest);assert.equal(source.body.sha256,independent.body.sha256);
 const privateCapture=await w.kit.store.get<{personal_scope:{owner:string;epoch:string}}>(source.digest);assert.equal(privateCapture?.body.personal_scope.owner,w.user.id);
 const epoch=(await w.kit.personalPayloads!.inspect(source.digest))!.epoch;await w.kit.personalPayloads!.purge(w.user,epoch);
 assert.equal(await w.kit.store.get(source.digest),null);assert.ok(await w.kit.store.get(independent.digest));
 assert.deepEqual(Buffer.from((await w.kit.artifacts.source(w.user,independent.body.sha256,{record:independent.digest}))!.bytes!),bytes);
});
