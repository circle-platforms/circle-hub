import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { makeWorld } from '../../knowledge/test-support.ts';
import { SCHEMAS } from '../../knowledge/api.ts';
import { recordReader } from './readers.ts';
let postgres:TemporaryPostgres;before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('engine contribution gates fail closed for current and unsupported schema revisions',async t=>{
  const w=await makeWorld(postgres);t.after(()=>w.close());
  for(const schema of [SCHEMAS.contribution,SCHEMAS.contribution.replace(/@\d+$/,'@99')]){
    const stored=await w.kit.store.put({kind:'claim',schema,provenance:'declared',body:{synthetic:'protected'}});
    const read=recordReader(w.kit.store,{read:async()=>null});
    assert.equal(await read.read(stored.digest,{user:w.admin.id,role:w.admin.role}),null);
    assert.equal(await recordReader(w.kit.store).read(stored.digest,{user:w.admin.id,role:w.admin.role}),null);
  }
});
