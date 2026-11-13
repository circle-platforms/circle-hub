// Synthetic current-schema reset replay. Protected states are never printed by these tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openTestRecords } from '../testing/records.ts';
import { Database,createPool } from './db.ts';
import { exportConfigurationSnapshot,validateConfigurationSnapshot,restoreConfigurationSnapshot } from './configuration-snapshot.ts';
import { sha256Hex } from './digest.ts';
import { RecordsError } from './errors.ts';

async function world(t:import('node:test').TestContext){
  const source=await openTestRecords();
  const target=await openTestRecords({postgres:source.postgres});
  const db=new Database(createPool(source.database));
  const targetDb=new Database(createPool(target.database));
  t.after(async()=>{await targetDb.end();await db.end();await target.close();await source.close();});
  const sourceConfig={database:source.database,dataDir:source.dataDir,logDir:source.config.logDir,limits:source.config.limits};
  const targetConfig={database:target.database,dataDir:target.dataDir,logDir:target.config.logDir,limits:target.config.limits};
  return {source,target,db,targetDb,sourceConfig,targetConfig};
}

test('protected replay retains original identities, credential hashes, variables, document bytes and reservation registrations',{timeout:120000},async t=>{
  const w=await world(t),password='Synthetic-config-password-47!';
  const {user:admin,token}=await w.source.principals.bootstrapAdmin('synthetic-owner',{password,mustChange:false});
  const user=await w.source.principals.createUser(admin,'synthetic-member','user',{password:'Synthetic-member-password-48!',mustChange:false});
  const client=await w.source.principals.registerClient('synthetic-client',['http://127.0.0.1/callback']);
  const memberToken=await w.source.principals.issueToken(admin,user.id,'synthetic-token',client.id);
  const team=await w.source.teams.create(admin,'合成保留组');await w.source.teams.add(admin,team.id,user.id);
  for(let n=0;n<17;n++)await w.source.variables.setVariable(admin,'SYNTHETIC_'+n,{ordinal:n},'合成保留变量');
  const docs=new Map<string,Buffer>();
  for(let n=0;n<12;n++){
    const name='synthetic-'+n,bytes=Buffer.from('synthetic named document '+n),sha=sha256Hex(bytes);docs.set(sha,bytes);
    await w.source.artifacts.ingest({bytes,mediaType:'text/plain',origin:{read:{object:'doc:doc:'+name+'@'+sha}},author:{user:null},provenanceType:'declared',visibility:{readers:[],admins:true,packs:[],shareable:false}});
    await w.source.pointers.move({name:'doc:'+name,expected:null,next:sha,by:admin});
  }
  await w.db.query('INSERT INTO lease_registrations(prefix,owner,registered_at) VALUES($1,$2,$3)',['synthetic-bed/',user.id,new Date().toISOString()]);
  await mkdir(join(w.source.dataDir,'vault'),{recursive:true});await mkdir(join(w.target.dataDir,'vault'),{recursive:true});
  const sourceOpaque=join(w.source.dataDir,'vault','synthetic-opaque'),targetOpaque=join(w.target.dataDir,'vault','synthetic-opaque');
  await writeFile(sourceOpaque,'synthetic sealed bytes',{mode:0o600});await writeFile(targetOpaque,'synthetic destination sealed bytes',{mode:0o600});
  const beforeSource=await readFile(sourceOpaque),beforeTarget=await readFile(targetOpaque);
  const snapshot=await exportConfigurationSnapshot(w.sourceConfig);
  assert.equal(snapshot.pointers.length,12);assert.equal(snapshot.lease_registrations.length,1);
  assert.equal(snapshot.records.filter(row=>row.kind==='authorization'&&JSON.parse(row.body).object.startsWith('var:')).length,17);
  assert.ok(!JSON.stringify(snapshot).includes(password));assert.ok(!JSON.stringify(snapshot).includes(token.token));assert.ok(!JSON.stringify(snapshot).includes(memberToken.token));
  const validated=validateConfigurationSnapshot(JSON.parse(JSON.stringify(snapshot)));
  await restoreConfigurationSnapshot(w.targetConfig,validated);
  assert.equal((await w.target.principals.verifyPassword(admin.name,password))?.user.id,admin.id);
  assert.equal((await w.target.principals.authenticate('Bearer '+memberToken.token))?.id,user.id);
  assert.equal((await w.target.teams.get(admin,team.id))?.name,team.name);
  const sourceAuth=(await w.db.query('SELECT id,password_hash FROM users ORDER BY id')).rows,targetAuth=(await w.targetDb.query('SELECT id,password_hash FROM users ORDER BY id')).rows;
  assert.deepEqual(targetAuth,sourceAuth);
  assert.deepEqual((await w.targetDb.query('SELECT id,sha256,revoked_at FROM tokens ORDER BY id')).rows,(await w.db.query('SELECT id,sha256,revoked_at FROM tokens ORDER BY id')).rows);
  for(const [sha,bytes]of docs)assert.deepEqual(Buffer.from((await w.target.objects.get(sha))!),bytes);
  assert.equal((await w.targetDb.query('SELECT prefix,owner FROM lease_registrations')).rows[0].owner,user.id);
  assert.deepEqual(await readFile(sourceOpaque),beforeSource);assert.deepEqual(await readFile(targetOpaque),beforeTarget);
  assert.deepEqual((await w.targetDb.query('SELECT id,digest FROM records ORDER BY seq')).rows,[...snapshot.records].sort((a,b)=>BigInt(a.seq)<BigInt(b.seq)?-1:BigInt(a.seq)>BigInt(b.seq)?1:0).map(row=>({id:row.id,digest:row.digest})));
});

test('nonempty targets and incompatible receipts fail before committing protected state',{timeout:120000},async t=>{
  const w=await world(t);await w.source.principals.bootstrapAdmin('synthetic-source');
  const snapshot=await exportConfigurationSnapshot(w.sourceConfig);
  await w.target.principals.bootstrapAdmin('synthetic-existing');
  const before=(await w.targetDb.query('SELECT id FROM users')).rows;
  await assert.rejects(restoreConfigurationSnapshot(w.targetConfig,snapshot),RecordsError);
  assert.deepEqual((await w.targetDb.query('SELECT id FROM users')).rows,before);
  const altered=structuredClone(snapshot);altered.migrations[0].sha256='f'.repeat(64);
  assert.throws(()=>validateConfigurationSnapshot(altered),RecordsError);
});
