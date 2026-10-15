import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Harness} from '../acceptance/harness.ts';

test('Synthetic PostgreSQL shutdown waits for actual pool socket closure and closes once',async t=>{
 const scratch=await mkdtemp(join(tmpdir(),'hub-pool-shutdown-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 const pool=new EventEmitter() as any,client=new EventEmitter();let closed=false,ends=0,stops=0;
 pool.end=async()=>{ends++;setTimeout(()=>{closed=true;client.emit('end');},20);};
 const postgres={stop:async()=>{stops++;assert.equal(closed,true,'PostgreSQL must not terminate a still-connected test client');}};
 const h=new Harness(scratch,postgres as any,pool,{});
 pool.emit('connect',client);
 assert.equal(pool.listenerCount('error'),0,'Unexpected database errors must remain visible');
 await h.close();await h.close();assert.equal(ends,1);assert.equal(stops,1);
});
