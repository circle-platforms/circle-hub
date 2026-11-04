import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as scheduling from './sync-schedule.ts';
import {addUsage,installTraceSink,type SpanRow} from '../telemetry/api.ts';
test('a standing sync is periodic, serial and stops without starting another run',async()=>{
 let calls=0,active=0,maximum=0;let finish!:()=>void;
 const reached=new Promise<void>(resolve=>finish=resolve);
 const start=(scheduling as any).scheduleSync;
 assert.equal(typeof start,'function');
 const schedule=start(async()=>{active++;maximum=Math.max(maximum,active);calls++;await new Promise(resolve=>setTimeout(resolve,10));active--;if(calls===2)finish();return calls;},{intervalMs:20,onError:async(error:unknown)=>{throw error;}});
 let watchdog:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([reached,new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(new Error('periodic sync did not resume')),2000);})]);}finally{clearTimeout(watchdog);}
 await schedule.stop();const stopped=calls;await new Promise(resolve=>setTimeout(resolve,50));assert.equal(calls,stopped);assert.equal(maximum,1);
});
test('a scheduled sync round is a background trace of its own',async t=>{
 const rows:SpanRow[]=[];t.after(installTraceSink({push:row=>rows.push(row)}));
 const schedule=scheduling.scheduleSync(async()=>{addUsage('db.rows',4);return 'report';},{intervalMs:60000,onError:async()=>{}});
 t.after(()=>schedule.stop());
 assert.equal(await schedule.runNow(),'report');
 assert.equal(rows.length,1);
 assert.deepEqual([rows[0].name,rows[0].origin,rows[0].is_root,rows[0].usage['db.rows']],['sync-knowledge','background',true,4]);
});
