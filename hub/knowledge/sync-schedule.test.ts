import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as scheduling from './sync-schedule.ts';
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
