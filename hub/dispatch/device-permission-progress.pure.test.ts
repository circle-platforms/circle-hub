import {interruptedDeviceUse} from './device-use-progress.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DeviceObservation} from '../../contracts/src/pack.ts';
import {PROTOCOL_CODES} from '../../contracts/generated/protocol.ts';
import {EffectBoundaryError,deny} from './boundary.ts';
import {observeDevices,observeSeats,askDevices,askSeat} from './devices.ts';
import {ExecutorDefinition} from './definition.ts';
import type {RegisteredExecutor} from './executors.ts';
import {definition} from './testing/definition.ts';
import {probes} from './testing/probes.ts';

const by={id:'usr_0'+'a'.repeat(25),role:'user' as const,name:'合成成员'};
const run='run_0'+'b'.repeat(25);
const help={line_pattern:'^[A-Za-z0-9 ]{1,500}$',call:{tool:'ask_position',arguments:{line:{$value:'line'},seat:{$value:'seat_index'},ticket:{$value:'lease_id'}}},text:'/help',caret_only:'/caret',entered:'/entered',cleared:'/cleared'};
function fixture(denyAt:number,retry=false) {
  const d=ExecutorDefinition.parse({...definition('http://127.0.0.1:1/mcp'),allowed_tools:[...definition('x').allowed_tools,'inspect_seat','ask_position'],probes:{...probes,help}});
  const registered={id:'exe_0'+'c'.repeat(25),digest:'d'.repeat(64),resolved_digest:'e'.repeat(64),variables:[],definition:d} as RegisteredExecutor;
  let admissions=0,requests=0,connections=0,releases=0;
  const observations:DeviceObservation[]=[];
  const journal:unknown[]=[];
  const client={connect:async()=>{connections++;},declaredRead:async()=>{
    requests++;
    if(retry)throw new Error('synthetic transport outcome unresolved');
    return {value:{output:'version: synthetic-build',help:'',caret:true,entered:false,cleared:true},source:'src:'+'f'.repeat(64)};
  }};
  const ctx={
    now:()=>new Date('2026-11-14T00:00:00.000Z'),
    options:{records:{principals:{list:async()=>[{...by,role:'admin'}]}}},
    admitNewUse:async()=>{
      if(++admissions===denyAt)throw new EffectBoundaryError(deny(1,'ENVIRONMENT_PERMISSION_UNAVAILABLE',PROTOCOL_CODES.ENVIRONMENT_PERMISSION_UNAVAILABLE.when));
    },
    assertNoSecrets:async()=>{},secret:async()=>'synthetic',session:()=>client,
    acquire:async()=>({id:'synthetic-lease',token:'synthetic-token',ttl:10000}),
    context:()=>({}),heartbeat:()=>({stop:async()=>{}}),release:async()=>{releases++;},
    certified:async()=>true,sleep:async()=>{},
    recordObservation:async(input:Record<string,unknown>)=>{
      const value=DeviceObservation.parse({inventory:input.inventory,device:input.device,label:input.label,build:'synthetic-build',base:null,values:['synthetic-build'],observed_at:'2026-11-14T00:00:00.000Z',run,job:null,reference:input.reference});
      observations.push(value);return value;
    },
    journal:{append:async(...args:unknown[])=>{journal.push(args);}},
  } as unknown as ThisParameterType<typeof observeSeats> & ThisParameterType<typeof askSeat>;
  return {ctx,registered,observations,journal,get requests(){return requests;},get connections(){return connections;},get releases(){return releases;}};
}
const targets=new Map([['a'.repeat(64)+'#/devices/0',{label:'合成设备0'}],['a'.repeat(64)+'#/devices/1',{label:'合成设备1'}]]);

test('first admission keeps the exact zero-execution fact and opens no session',async()=>{
  const f=fixture(1);
  await assert.rejects(observeSeats.call(f.ctx,by,run,f.registered,f.registered.definition.probes!.seats,targets),error=>{
    assert.ok(error instanceof EffectBoundaryError,String(error));
    assert.equal(error.failure.message,PROTOCOL_CODES.ENVIRONMENT_PERMISSION_UNAVAILABLE.when);
    assert.equal(error.progress,undefined);
    return true;
  });
  assert.equal(f.connections,0);assert.equal(f.requests,0);
});

test('refusing the second seat preserves the first recorded observation and scopes nonexecution to the next request',async()=>{
  const f=fixture(3);
  await assert.rejects(observeSeats.call(f.ctx,by,run,f.registered,f.registered.definition.probes!.seats,targets),error=>{
    assert.ok(error instanceof EffectBoundaryError,String(error));
    assert.equal(error.failure.code,'ENVIRONMENT_PERMISSION_UNAVAILABLE');
    assert.ok(error.failure.message.includes('后续请求没有执行'));
    assert.equal(error.failure.message.includes('这次没有执行'),false);
    assert.deepEqual(error.progress?.observations,f.observations);
    assert.equal(error.progress?.attempts,1);
    assert.deepEqual(error.failure.grounds,[f.observations[0].reference]);
    return true;
  });
  assert.equal(f.observations.length,1);assert.equal(f.requests,1);assert.equal(f.releases,1);
});

for(const retry of [false,true])test('a later help '+(retry?'retry':'prefix')+' refusal preserves prior attempts without claiming zero execution',async()=>{
  const f=fixture(3,retry);
  const target={inventory:'a'.repeat(64),device:'/devices/0',label:'合成设备0',line:'widget show',keys:['synthetic/device/a']};
  const asked={line:target.line,words:2,prefixes:[{text:'widget',words:1,next_word:'show'},{text:'widget show',words:2,next_word:null}]};
  await assert.rejects(askSeat.call(f.ctx,by,run,f.registered,f.registered.definition.probes!.seats[0],target,asked),error=>{
    assert.ok(error instanceof EffectBoundaryError,String(error));
    assert.ok(error.failure.message.includes('后续请求没有执行'));
    assert.equal(error.failure.message.includes('这次没有执行'),false);
    assert.equal(error.progress?.attempts,1);
    assert.equal(error.progress?.help_results[0].positions.length,retry?0:1);
    return true;
  });
  assert.equal(f.requests,1);assert.equal(f.releases,1);assert.equal(f.journal.length,1);
});


test('the first help admission also preserves the exact initial fact',async()=>{
  const f=fixture(1);
  const target={inventory:'a'.repeat(64),device:'/devices/0',label:'合成设备0',line:'widget',keys:['synthetic/device/a']};
  const asked={line:target.line,words:1,prefixes:[{text:'widget',words:1,next_word:null}]};
  await assert.rejects(askSeat.call(f.ctx,by,run,f.registered,f.registered.definition.probes!.seats[0],target,asked),error=>{
    assert.ok(error instanceof EffectBoundaryError,String(error));
    assert.equal(error.failure.message,PROTOCOL_CODES.ENVIRONMENT_PERMISSION_UNAVAILABLE.when);
    assert.equal(error.progress,undefined);
    return true;
  });
  assert.equal(f.requests,0);assert.equal(f.connections,0);
});


test('observations from an earlier provider survive a later provider admission failure',async()=>{
  const f=fixture(0);
  const second={...f.registered,id:'exe_0'+'g'.repeat(25),definition:{...f.registered.definition,manifest_sha256:'b'.repeat(64)}};
  let providers=0;
  Object.assign(f.ctx,{
    registry:{probed:async()=>[f.registered,second]},
    observeSeats:async(actor:typeof by,id:string,registered:RegisteredExecutor,seats:NonNullable<RegisteredExecutor['definition']['probes']>['seats'],labels:ReadonlyMap<string,{label:string}>)=>{
      if(++providers===2)throw new EffectBoundaryError(deny(1,'ENVIRONMENT_PERMISSION_UNAVAILABLE',PROTOCOL_CODES.ENVIRONMENT_PERMISSION_UNAVAILABLE.when));
      return observeSeats.call(f.ctx,actor,id,registered,seats,labels);
    },
  });
  await assert.rejects(observeDevices.call(f.ctx,by,run,[{inventory:'a'.repeat(64),device:'/devices/0',label:'合成设备0'},{inventory:'b'.repeat(64),device:'/devices/0',label:'合成设备1'}]),error=>{
    assert.ok(error instanceof EffectBoundaryError,String(error));
    assert.deepEqual(error.progress?.observations,f.observations);
    assert.equal(error.progress?.observations.length,1);
    assert.deepEqual(error.failure.grounds,[f.observations[0].reference]);
    assert.equal(error.failure.message.includes('这次没有执行'),false);
    return true;
  });
  assert.equal(f.requests,1);
});

test('completed help target answers survive a later target admission failure',async()=>{
  const f=fixture(0);
  let targets=0;
  Object.assign(f.ctx,{askDevice:async(actor:typeof by,id:string,target:{inventory:string;device:string;label:string;line:string;keys:string[]})=>{
    if(++targets===2)throw new EffectBoundaryError(deny(1,'ENVIRONMENT_PERMISSION_UNAVAILABLE',PROTOCOL_CODES.ENVIRONMENT_PERMISSION_UNAVAILABLE.when));
    return askSeat.call(f.ctx,actor,id,f.registered,f.registered.definition.probes!.seats[0],target,{line:target.line,words:1,prefixes:[{text:target.line,words:1,next_word:null}]});
  }});
  const target={inventory:'a'.repeat(64),device:'/devices/0',label:'合成设备0',line:'widget',keys:['synthetic/device/a']};
  await assert.rejects(askDevices.call(f.ctx,by,run,[target,{...target,device:'/devices/1',label:'合成设备1'}]),error=>{
    assert.ok(error instanceof EffectBoundaryError,String(error));
    assert.equal(error.progress?.help_results.length,1);
    assert.equal(error.progress?.help_results[0].positions.length,1);
    assert.deepEqual(error.failure.grounds,['src:'+'f'.repeat(64)]);
    assert.equal(error.failure.message.includes('这次没有执行'),false);
    return true;
  });
  assert.equal(f.requests,1);
});

test('unrelated source or remote uncertainty is never rewritten by device progress',()=>{
  const original=new EffectBoundaryError(deny(1,'SOURCE_UNAVAILABLE','原请求是否执行仍未知'));
  assert.equal(interruptedDeviceUse(original,{observations:[],help_results:[],attempts:1,sessions:1}),original);
});
