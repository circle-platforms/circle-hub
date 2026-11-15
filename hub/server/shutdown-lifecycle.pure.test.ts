import assert from 'node:assert/strict';
import {test} from 'node:test';
import {shutdownServing} from './main.ts';

function deferred() {
  let resolve:()=>void=()=>{};
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

test('shutdown synchronously gates new effects before maintenance and keeps pools until HTTP and dispatch finish', async () => {
  const calls:string[]=[], maintenance=deferred(), http=deferred(), dispatch=deferred();
  const stopped=shutdownServing({close(){calls.push('gate');return http.promise;}},
    async()=>{calls.push('maintenance');await maintenance.promise;calls.push('maintenance stopped');},
    async()=>{calls.push('dispatch');await dispatch.promise;calls.push('workers and heartbeats stopped');},
    async()=>{calls.push('pools');});
  assert.deepEqual(calls,['gate','maintenance']);
  maintenance.resolve();await maintenance.promise;await Promise.resolve();
  assert.equal(calls.includes('dispatch'),false);
  http.resolve();await http.promise;await Promise.resolve();await Promise.resolve();
  assert.equal(calls.includes('pools'),false);
  dispatch.resolve();await stopped;
  assert.deepEqual(calls,['gate','maintenance','maintenance stopped','dispatch','workers and heartbeats stopped','pools']);
});

test('an HTTP drain rejection still closes dispatch and pools after stopping maintenance', async () => {
  const failure=new Error('synthetic drain failure'), calls:string[]=[];
  await assert.rejects(shutdownServing({close(){calls.push('gate');return Promise.reject(failure);}},
    async()=>{calls.push('maintenance');},async()=>{calls.push('dispatch');},async()=>{calls.push('pools');}),error=>error===failure);
  assert.deepEqual(calls,['gate','maintenance','dispatch','pools']);
});

test('maintenance or dispatch failure cannot skip final pool closure', async () => {
  for(const phase of ['maintenance','dispatch']) {
    const failure=new Error('synthetic '+phase), calls:string[]=[];
    await assert.rejects(shutdownServing({close(){calls.push('gate');return Promise.resolve();}},
      async()=>{calls.push('maintenance');if(phase==='maintenance')throw failure;},
      async()=>{calls.push('dispatch');if(phase==='dispatch')throw failure;},
      async()=>{calls.push('pools');}),error=>error===failure);
    assert.deepEqual(calls,['gate','maintenance','dispatch','pools']);
  }
});

test('a synchronous close exception does not prevent worker or pool cleanup', async () => {
  const failure=new Error('synthetic gate exception'), calls:string[]=[];
  await assert.rejects(shutdownServing({close(){throw failure;}},async()=>{calls.push('maintenance');},
    async()=>{calls.push('dispatch');},async()=>{calls.push('pools');}),error=>error===failure);
  assert.deepEqual(calls,['maintenance','dispatch','pools']);
});
