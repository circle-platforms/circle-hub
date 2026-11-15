import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import pg from 'pg';
import {Database, createPool} from './db.ts';
import {PgRecordStore,createRecordStore} from './store.ts';

// Only these in-memory bounded clients run; no socket, database, timer or SQL server is created.
class BoundedPool {
  readonly options: {max:number};
  lastClient?:pg.PoolClient;
  beforeLockReply?: (client:pg.PoolClient)=>void|Promise<void>;
  beforeUnlockReply?: (client:pg.PoolClient)=>void|Promise<void>;
  unlockQueries=0;
  active=0; waitingCount=0; ended=0; destroyed=0; failLock=false; malformedLock=false; failAfterAcquire=false; failUnlock=false;
  readonly pending: Array<(client: pg.PoolClient)=>void> = [];
  readonly keys = new Set<string>();
  readonly sharedLocks:Set<string>;
  constructor(max:number, sharedLocks = new Set<string>()) {this.options={max};this.sharedLocks=sharedLocks;}
  get totalCount(){return this.active;}
  get idleCount(){return 0;}
  async connect():Promise<pg.PoolClient>{
    if(this.active>=this.options.max){this.waitingCount++;return new Promise(resolve=>this.pending.push(resolve));}
    this.active++;return this.client();
  }
  private client():pg.PoolClient {
    let released=false;const held=new Set<string>();
    const client=Object.assign(new EventEmitter(),{query:async (sql:string,values:unknown[]=[])=>{
      const key=JSON.stringify(values);
      if(sql.includes('pg_try_advisory_lock')){
        if(this.failLock)throw new Error('synthetic lock read failed');
        if(this.malformedLock)return {rows:[]};
        const locked=!this.sharedLocks.has(key);if(locked){this.sharedLocks.add(key);this.keys.add(key);held.add(key);}
        if(this.failAfterAcquire)throw new Error('synthetic acknowledgement loss');
        await this.beforeLockReply?.(client);
        return {rows:[{locked}]};
      }
      if(sql.includes('pg_advisory_unlock')){this.unlockQueries++;await this.beforeUnlockReply?.(client);if(this.failUnlock)throw new Error('synthetic unlock failed');this.sharedLocks.delete(key);this.keys.delete(key);held.delete(key);return {rows:[{unlocked:true}]};}
      assert.equal(sql,'SELECT synthetic_read');return {rows:[{ok:true}]};
    },release:(failure?:Error)=>{
      assert.equal(released,false);released=true;
      if(failure){this.destroyed++;for(const key of held){this.sharedLocks.delete(key);this.keys.delete(key);}}
      const next=this.pending.shift();if(next){this.waitingCount--;next(this.client());}else this.active--;
    }}) as unknown as pg.PoolClient;
    this.lastClient=client;return client;
  }
  async query(sql:string,values:unknown[]=[]){const client=await this.connect();try{return await client.query(sql,values);}finally{client.release();}}
  async end(){this.ended++;assert.equal(this.active,0);}
}
const typed=(pool:BoundedPool)=>pool as unknown as pg.Pool;
const options={maxRecordBytes:1024,now:()=>new Date('2026-11-15T00:00:00.000Z')};

test('observation locks cannot starve the main pool needed to read records and save responses',async()=>{
  const main=new BoundedPool(1),locks=new BoundedPool(2),db=new Database(typed(main));
  const store=new PgRecordStore(db,options,typed(locks));
  const unlock=await store.tryHold('synthetic-job');assert.ok(unlock);
  const read=db.query('SELECT synthetic_read');
  try {
    assert.equal(main.waitingCount,0,'a held observation must not queue its own main-pool work');
    assert.equal(main.active,1);assert.equal(locks.active,1);
    assert.deepEqual((await read).rows,[{ok:true}]);
  } finally {await unlock();await read;}
  assert.equal(main.active,0);assert.equal(locks.active,0);
});

test('the observation pool stays bounded and waiting for it does not consume main connections',async()=>{
  const main=new BoundedPool(1),locks=new BoundedPool(1),store=new PgRecordStore(new Database(typed(main)),options,typed(locks));
  const first=await store.tryHold('one');assert.ok(first);
  const next=store.tryHold('two');assert.equal(locks.active,1);assert.equal(locks.waitingCount,1);assert.equal(main.active,0);
  await first();const second=await next;assert.ok(second);await second();assert.equal(locks.active,0);
});

test('same-key contention alone returns null and retains the namespace while errors propagate',async()=>{
  const main=new BoundedPool(1),locks=new BoundedPool(2),store=new PgRecordStore(new Database(typed(main)),options,typed(locks));
  const first=await store.tryHold('same');assert.ok(first);
  assert.deepEqual([...locks.sharedLocks],[JSON.stringify([730162,'dispatch.observation:same'])]);
  assert.equal(await store.tryHold('same'),null);assert.equal(locks.active,1);
  await first();await first();assert.equal(locks.active,0);
  locks.failLock=true;await assert.rejects(store.tryHold('failure'),/synthetic lock read failed/);assert.equal(locks.active,0);
});

test('an unwired records-only store fails explicitly and never falls back to its main pool',async()=>{
  const main=new BoundedPool(1),db=new Database(typed(main));
  const store=new PgRecordStore(db,options,null);
  await assert.rejects(store.tryHold('unwired'),/专用连接池尚未装配/);
  await assert.rejects(createRecordStore(db,options).tryHold('factory-unwired'),/专用连接池尚未装配/);assert.equal(main.active,0);
  assert.throws(()=>new PgRecordStore(db,options,typed(main)),/独立连接池/);
  assert.throws(()=>new PgRecordStore(db,options,typed(new BoundedPool(0))),/正整数上限/);
});

test('aggregate stats include both bounded pools and count process failures only once',async()=>{
  const main=new BoundedPool(1),locks=new BoundedPool(2),db=new Database(typed(main));
  main.active=1;locks.active=2;locks.waitingCount=1;
  const idle=createPool({host:'127.0.0.1',port:1,database:'synthetic',user:'synthetic',password:'synthetic'},1);
  const before=db.stats().connectionFailures;
  idle.emit('error',new Error('synthetic idle pool failure without connection'));
  const stats=db.stats([typed(locks),typed(locks),typed(main)]);
  assert.deepEqual(stats,{limit:3,total:3,idle:0,waiting:1,connectionFailures:before+1});
  assert.equal(stats.connectionFailures,db.stats().connectionFailures);
  assert.equal(idle.totalCount,0);await idle.end();
});


test('unknown lock replies never become null and failed lock sessions are destroyed',async()=>{
  const main=new BoundedPool(1),locks=new BoundedPool(1),store=new PgRecordStore(new Database(typed(main)),options,typed(locks));
  locks.malformedLock=true;await assert.rejects(store.tryHold('unknown'),/结果未知/);assert.equal(locks.destroyed,1);
  locks.malformedLock=false;locks.failAfterAcquire=true;await assert.rejects(store.tryHold('lost-ack'),/acknowledgement loss/);
  assert.equal(locks.destroyed,2);assert.equal(locks.sharedLocks.size,0);assert.equal(locks.active,0);
  locks.failAfterAcquire=false;const release=await store.tryHold('unlock-error');assert.ok(release);locks.failUnlock=true;
  await assert.rejects(release(),/unlock failed/);assert.equal(locks.destroyed,3);assert.equal(locks.sharedLocks.size,0);assert.equal(locks.active,0);
});


test('asynchronous loss notifies once fails the holder and discards the client once without an unhandled error',async()=>{
  const main=new BoundedPool(1),locks=new BoundedPool(1),store=new PgRecordStore(new Database(typed(main)),options,typed(locks));
  const failures:Error[]=[];
  const release=await store.tryHold('async-loss',error=>failures.push(error));assert.ok(release);
  const failure=new Error('synthetic held-client failure');
  try {
    assert.doesNotThrow(()=>locks.lastClient!.emit('error',failure));
    assert.deepEqual(failures,[failure]);assert.equal(locks.destroyed,1);assert.equal(locks.active,0);assert.equal(locks.sharedLocks.size,0);
    assert.doesNotThrow(()=>locks.lastClient!.emit('error',new Error('synthetic late failure')));
    assert.equal(failures.length,1);assert.equal(locks.destroyed,1);
    await assert.rejects(release(),error=>error===failure);
    await assert.rejects(release(),error=>error===failure);
  } finally {if(locks.active)await release();}
});


test('connection loss while acquisition is pending rejects instead of yielding a holder or contention',async()=>{
  const locks=new BoundedPool(1),store=new PgRecordStore(new Database(typed(new BoundedPool(1))),options,typed(locks));
  const failure=new Error('synthetic acquisition socket failure'),notifications:Error[]=[];
  locks.beforeLockReply=client=>{client.emit('error',failure);};
  await assert.rejects(store.tryHold('acquiring',error=>notifications.push(error)),error=>error===failure);
  assert.deepEqual(notifications,[],'there was no published holder; the acquisition itself rejects');
  assert.equal(locks.destroyed,1);assert.equal(locks.active,0);assert.equal(locks.sharedLocks.size,0);
});

test('loss during unlock notifies once and concurrent release callers fail without double disposal',async()=>{
  const locks=new BoundedPool(1),store=new PgRecordStore(new Database(typed(new BoundedPool(1))),options,typed(locks));
  const failure=new Error('synthetic unlock socket failure'),notifications:Error[]=[];
  const release=await store.tryHold('unlocking',error=>notifications.push(error));assert.ok(release);
  locks.beforeUnlockReply=client=>{client.emit('error',failure);};
  const results=await Promise.allSettled([release(),release()]);
  assert.ok(results.every(result=>result.status==='rejected'&&result.reason===failure));
  assert.deepEqual(notifications,[failure]);assert.equal(locks.unlockQueries,1);assert.equal(locks.destroyed,1);assert.equal(locks.active,0);
});

test('a throwing loss notifier cannot escape the socket listener and its error remains observable',async()=>{
  const locks=new BoundedPool(1),store=new PgRecordStore(new Database(typed(new BoundedPool(1))),options,typed(locks));
  const failure=new Error('synthetic original failure'),notice=new Error('synthetic notification failure');
  let notified=0;
  const release=await store.tryHold('notifier',error=>{assert.equal(error,failure);notified++;throw notice;});assert.ok(release);
  assert.doesNotThrow(()=>locks.lastClient!.emit('error',failure));
  await assert.rejects(release(),error=>error instanceof AggregateError&&error.errors[0]===failure&&error.errors[1]===notice);
  assert.equal(notified,1);assert.equal(locks.destroyed,1);assert.equal(locks.active,0);
});

test('normal concurrent release is idempotent and detaches the held-client listener before reuse',async()=>{
  const locks=new BoundedPool(1),store=new PgRecordStore(new Database(typed(new BoundedPool(1))),options,typed(locks));
  let notices=0;const release=await store.tryHold('normal',()=>{notices++;});assert.ok(release);
  assert.equal(locks.lastClient!.listenerCount('error'),1);
  await Promise.all([release(),release()]);await release();
  assert.equal(locks.unlockQueries,1);assert.equal(locks.destroyed,0);assert.equal(locks.active,0);assert.equal(notices,0);
  assert.equal(locks.lastClient!.listenerCount('error'),0);
});
