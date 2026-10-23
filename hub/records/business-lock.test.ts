import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
let postgres:TemporaryPostgres;before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
test('business locks are transaction scoped and distinct content keys do not block each other',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());assert.equal(typeof kit.store.lock,'function');
  let held!:()=>void,release!:()=>void;const ready=new Promise<void>(done=>held=done);const gate=new Promise<void>(done=>release=done);
  const first=kit.store.withTransaction(async tx=>{await kit.store.lock('synthetic:one',tx);held();await gate;});await ready;
  let sameEntered=false;const same=kit.store.withTransaction(async tx=>{await kit.store.lock('synthetic:one',tx);sameEntered=true;});
  try {
    const distinct=kit.store.withTransaction(async tx=>{await kit.store.lock('synthetic:two',tx);return true;});
    assert.equal(await Promise.race([distinct,new Promise(resolve=>setTimeout(()=>resolve(false),1000))]),true);
    assert.equal(sameEntered,false);
  } finally {release();await first;await same;}
  assert.equal(sameEntered,true);
});
test('rollback releases a business lock without changing record history',async t=>{
  const kit=await openTestRecords({postgres});t.after(()=>kit.close());assert.equal(typeof kit.store.lock,'function');
  await assert.rejects(kit.store.withTransaction(async tx=>{await kit.store.lock('synthetic:rollback',tx);throw new Error('synthetic rollback');}),/synthetic rollback/);
  await kit.store.withTransaction(async tx=>{await kit.store.lock('synthetic:rollback',tx);});
  assert.equal((await kit.store.list({kind:'claim'})).items.length,0);
});
