import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { startPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { AccessError } from './api.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, migrate } from './migrations.ts';
import { PgPrincipals } from './principals.ts';
import { newId } from './ids.ts';
import { sha256Hex } from './digest.ts';
import { hashPassword } from './password.ts';

test('concurrent password derivations wait their turn instead of being refused as busy',async()=>{
  // Two derivations run at once; the others queue (several members may sign in together).
  const hashes=await Promise.all(Array.from({length:5},(_,i)=>hashPassword(`synthetic-concurrent-${i}-password`)));
  assert.equal(new Set(hashes).size,5);
  assert.ok(hashes.every(hash=>hash.startsWith('scrypt$131072$8$1$')));
});

test('passwords stay salted and private, reset revokes browser sessions, and changes preserve account-bound Circle tokens', async t => {
  const postgres=await startPostgres();
  let now=new Date('2026-11-02T00:00:00.000Z');
  const kit=await openTestRecords({postgres,now:()=>now});
  const {user:admin}=await kit.principals.bootstrapAdmin('合成管理员');
  const initial='synthetic-initial-password';
  const user=await kit.principals.createUser(admin,'合成成员','user',{password:initial,mustChange:true});
  const other=await kit.principals.createUser(admin,'合成其他成员','user',{password:initial,mustChange:false});
  const db=new pg.Client({...kit.database,ssl:false});await db.connect();t.after(async()=>{await db.end();await kit.close();await postgres.stop();});
  const rows=(await db.query('SELECT password_hash FROM users WHERE id = ANY($1)',[[user.id,other.id]])).rows;
  assert.notEqual(rows[0].password_hash,rows[1].password_hash);
  assert.ok(rows.every(row=>!String(row.password_hash).includes(initial)));
  assert.ok(!JSON.stringify(await kit.principals.list()).includes('password_hash'));
  assert.equal(await kit.principals.verifyPassword(user.name,'wrong'),null);
  assert.equal(await kit.principals.verifyPassword('不存在',initial),null);
  const verified=await kit.principals.verifyPassword(user.name,initial);assert.ok(verified?.mustChange);
  const session=await kit.principals.openConsoleSession(user.id,verified.revision);assert.ok(session);
  const circle=await kit.principals.issueToken(admin,user.id,'合成设备');
  assert.deepEqual((await kit.principals.tokens(user.id)).map(row=>row.id),[circle.id]);
  await assert.rejects(()=>kit.principals.resetPassword(other,user.id),AccessError);
  const reset=await kit.principals.resetPassword(admin,user.id);
  assert.equal(await kit.principals.authenticate('Bearer '+session.token),null);
  assert.equal(await kit.principals.openConsoleSession(user.id,verified.revision),null,'an old verification cannot open a session after reset');
  assert.equal(await kit.principals.verifyPassword(user.name,initial),null);
  assert.equal(await kit.principals.changePassword(user,'wrong','synthetic-new-password'),false);
  assert.equal(await kit.principals.changePassword(user,reset,reset),false);
  assert.equal(await kit.principals.changePassword(user,reset,'synthetic-new-password'),true);
  assert.equal((await kit.principals.passwordState(user.id)).mustChange,false);
  assert.equal((await kit.principals.authenticate('Bearer '+circle.token))?.id,user.id);
  assert.ok((await kit.principals.history(user.id)).some(row=>row.password_changed));
  const fresh=await kit.principals.verifyPassword(user.name,'synthetic-new-password');assert.ok(fresh);
  const bounded=await kit.principals.openConsoleSession(user.id,fresh.revision);assert.ok(bounded);
  now=new Date(now.getTime()+12*60*60*1000+1);
  assert.equal(await kit.principals.authenticate('Bearer '+bounded.token),null,'browser credential has an absolute lifetime');
  await kit.principals.setDisabled(admin,user.id,true);
  assert.equal(await kit.principals.verifyPassword(user.name,'synthetic-new-password'),null);
});

test('the password migration preserves version-7 accounts and Circle credentials until an explicit reset',async t=>{
  const postgres=await startPostgres();
  const config=await postgres.createDatabase(undefined,{empty:true});
  const db=new Database(createPool(config,2));
  t.after(async()=>{await db.end();await postgres.dropDatabase(config.database);await postgres.stop();});
  await migrate(db,MIGRATIONS.slice(0,7));
  const id=newId('usr'),tokenId=newId('tok'),token='s'.repeat(43),at='2026-11-02T00:00:00.000Z';
  await db.query('INSERT INTO users (id,name,role,disabled,created_at,updated_at) VALUES ($1,$2,$3,false,$4,$4)',[id,'合成旧管理员','admin',at]);
  await db.query('INSERT INTO tokens (id,user_id,sha256,label,created_at) VALUES ($1,$2,$3,$4,$5)',[tokenId,id,sha256Hex(token),'合成旧 Circle',at]);
  assert.deepEqual(await migrate(db),MIGRATIONS.slice(7).map(migration=>migration.version),'the password migration and every later one apply on top of version 7');
  assert.deepEqual(await migrate(db),[]);
  const principals=new PgPrincipals(db,()=>new Date(at));
  const user=await principals.authenticate('Bearer '+token);assert.ok(user);assert.equal(user.id,id);
  assert.deepEqual(await principals.passwordState(id),{configured:false,mustChange:false,revision:0});
  assert.equal((await principals.tokens(id))[0].id,tokenId);
  const initial=await principals.resetPassword(user,id);
  assert.ok((await principals.verifyPassword(user.name,initial))?.mustChange);
  assert.equal((await principals.authenticate('Bearer '+token))?.id,id);
});
