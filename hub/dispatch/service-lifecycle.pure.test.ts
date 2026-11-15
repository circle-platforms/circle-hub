import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DispatchService,type DispatchOptions} from './service.ts';

function deferred<T>(){
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};
}
test('close drains accepted-dispatch preparation before closing its dependencies',async()=>{
  const listed=deferred<[]>();let reads=0,closed=false;
  const service=new DispatchService({records:{principals:{list(){reads++;return listed.promise;}}},
    close:async()=>{closed=true;}} as unknown as DispatchOptions);
  const accepted=service.dispatchAccepted('synthetic-run');assert.equal(reads,1);
  const close=service.close();await Promise.resolve();assert.equal(closed,false);
  listed.resolve([]);assert.equal((await accepted).started,false);await close;assert.equal(closed,true);
  await assert.rejects(service.dispatchAccepted('synthetic-run'),/服务正在停止/);assert.equal(reads,1);
});
test('a failed startup record boundary is retriable and never cached as an empty startup',async()=>{
  let attempts=0;
  const service=new DispatchService({records:{store:{watermark:async()=>{attempts++;if(attempts===1)throw Error('synthetic boundary unavailable');return 7;}}}} as unknown as DispatchOptions);
  await assert.rejects(service.initializeRecovery(),/synthetic boundary unavailable/);
  await service.initializeRecovery();await service.initializeRecovery();assert.equal(attempts,2);
  await service.close();
});
