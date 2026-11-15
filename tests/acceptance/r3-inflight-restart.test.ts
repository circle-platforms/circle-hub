// UNRUN until the integrator supplies the fixed recovery core SHA and the sole PostgreSQL slot.
// Actual SIGKILL/re-exec, one synthetic gateway ledger surviving the Hub children, one unchanged database.
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {test,type TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import type {ActionBody} from '../../hub/records/api.ts';
import {setupJournal} from '../../hub/dispatch/testing/journal.ts';
import {observationLockFree} from '../../hub/dispatch/testing/context.ts';

type Context=Awaited<ReturnType<typeof setupJournal>>;
const cleanups=new WeakMap<Context,Set<()=>Promise<void>>>();
async function journal(t:TestContext,options:Parameters<typeof setupJournal>[0]={}){
  const c=await setupJournal(options);const pending=new Set<()=>Promise<void>>();cleanups.set(c,pending);
  t.after(async()=>{const results=await Promise.allSettled([...pending].map(close=>close()));await c.close();if(results.some(result=>result.status==='rejected'))throw new Error('synthetic child cleanup or output policy failed');});
  return c;
}
type Notice={type:string;stage?:string;job?:string;source?:string;sha256?:string;inputs?:string[];response?:string};
async function child(t:TestContext,c:Context,mode:'dispatch'|'recover',checkpoint?:string){
  const processChild=spawn(process.execPath,[fileURLToPath(new URL('../../hub/dispatch/testing/recovery-worker.ts',import.meta.url))],{stdio:['pipe','pipe','pipe','ipc'],env:{PATH:process.env.PATH}});
  assert.ok(processChild.stdin&&processChild.stdout&&processChild.stderr);
  const notices:Notice[]=[],events=new EventEmitter();let output='',errors='';
  processChild.stdout.on('data',value=>{output+=value;});processChild.stderr.on('data',value=>{errors+=value;});
  processChild.on('message',message=>{notices.push(message as Notice);events.emit('notice');});
  const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>processChild.once('exit',(code,signal)=>resolve({code,signal})));
  const wait=(type:string)=>Promise.race([new Promise<Notice>(resolve=>{const check=()=>{const value=notices.find(message=>message.type===type);if(value){events.off('notice',check);resolve(value);}};events.on('notice',check);check();}),exited.then(()=>{throw new Error('synthetic recovery child exited before requested checkpoint');})]);
  cleanups.get(c)!.add(async()=>{if(processChild.exitCode===null&&processChild.signalCode===null)processChild.kill('SIGKILL');await exited;assert.ok(output.length===0,'child must not print identities/configuration');assert.ok(errors.length===0,'child errors must not print configuration');});
  processChild.stdin.end(JSON.stringify({config:{...c.kit.config,database:c.kit.database},now:c.now().toISOString(),detail:c.detail,admin:c.admin,executor:c.executor.id,mode,checkpoint}));
  await wait('ready');processChild.send('go');
  return {process:processChild,wait,exited,async kill(){processChild.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');},async close(){processChild.send('close');const exit=await exited;assert.equal(exit.code,0);assert.equal(exit.signal,null);}};
}
async function eventual<T>(read:()=>Promise<T>,done:(value:T)=>boolean):Promise<T>{
  const deadline=Date.now()+20000;
  for(;;){const value=await read();if(done(value))return value;if(Date.now()>=deadline)throw new Error('synthetic recovery observation did not converge');await new Promise(resolve=>setTimeout(resolve,20));}
}
async function intent(c:Context){return eventual(()=>c.kit.store.getByKey<ActionBody>('action',`dispatch.bytes:${c.payload.body.sha256}:${c.detail.run.predecessor}:1`),row=>row!==null);}
const sends=(c:Context)=>c.calls.filter(name=>name==='send_blob').length;
const tasks=(c:Context)=>[...c.rows.values()].filter(row=>row.key==='synthetic-remote').length;
async function recover(t:TestContext,c:Context,job:string){await observationLockFree(c,job);const worker=await child(t,c,'recover');await worker.wait('scheduled');return worker;}
async function completed(c:Context,job:string){await eventual(()=>c.service.journal.events(job),events=>events.some(event=>event.body.detail.phase==='complete'&&event.body.detail.done===true));return c.service.status(c.admin,job);}
async function admittedAndKilled(t:TestContext,c:Context,onSubmit:{current?:ChildProcess}){
  const worker=await child(t,c,'dispatch');onSubmit.current=worker.process;
  assert.equal((await worker.exited).signal,'SIGKILL');const row=await intent(c);assert.ok(row);return String(row.body.detail.job);
}
// Override only synthetic wire replies, not the production recovery decision logic or Journal.
function rewriteReply(c:Context,tool:string,rewrite:(value:Record<string,unknown>)=>Record<string,unknown>){
  c.endpoint.server.prependListener('request',(req,res)=>{
    let request='';req.on('data',bytes=>{request+=String(bytes);});
    const end=res.end;
    res.end=((chunk:unknown,...args:unknown[])=>{
      const rpc=JSON.parse(request) as {params?:{name?:string}};
      if(rpc.params?.name===tool&&(typeof chunk==='string'||Buffer.isBuffer(chunk))){
        const reply=JSON.parse(String(chunk));
        if(reply.result?.structuredContent)reply.result.structuredContent=rewrite(reply.result.structuredContent);
        chunk=JSON.stringify(reply);
      }
      return Reflect.apply(end,res,[chunk,...args]);
    }) as typeof res.end;
  });
}

test('R3-1 SIGKILL after committed reservation without intent converges without sending',{timeout:60000},async t=>{
  const c=await journal(t);
  const first=await child(t,c,'dispatch','reservation'),point=await first.wait('checkpoint');assert.ok(point.job);await first.kill();
  const worker=await recover(t,c,point.job);const status=await completed(c,point.job);assert.equal(status.outcome,'not_dispatched');assert.equal(sends(c),0);assert.equal(c.rows.size,0);await worker.close();
});

test('R3-2 admitted not_started converges and permits a fresh explicit gate without resubmitting the old request',{timeout:60000},async t=>{
  const holder:{current?:ChildProcess}={};const c=await journal(t,{stopped:true,onSubmit:async()=>{holder.current!.kill('SIGKILL');}});
  const job=await admittedAndKilled(t,c,holder);const syntheticLedger=c.rows;assert.equal(syntheticLedger.size,1);
  const worker=await recover(t,c,job);assert.equal((await completed(c,job)).outcome,'proven_not_executed');assert.equal(sends(c),1);await worker.close();
  const fresh=await child(t,c,'dispatch','gate');await fresh.wait('checkpoint');await fresh.kill();assert.equal(sends(c),1,'new authorization gate is not an automatic retransmission');assert.equal(syntheticLedger.size,1);
});

test('R3-3 original started request with lost reply is recovered automatically, never manually resumed',{timeout:60000},async t=>{
  const holder:{current?:ChildProcess}={};const c=await journal(t,{lost:true,onSubmit:async()=>{holder.current!.kill('SIGKILL');}});
  const job=await admittedAndKilled(t,c,holder),worker=await recover(t,c,job);const status=await completed(c,job);
  assert.equal(status.outcome,'effective');assert.equal(sends(c),1);assert.equal(tasks(c),1);assert.ok(c.calls.includes('lookup_blob'));await worker.close();
});

test('R3-4 two actual process restarts retain request/task/round identity and one submit',{timeout:60000},async t=>{
  const c=await journal(t);
  const first=await child(t,c,'dispatch','status.response'),a=await first.wait('checkpoint');assert.ok(a.job);const original=await intent(c);assert.ok(original);await first.kill();
  await observationLockFree(c,a.job);const second=await child(t,c,'recover','status.response');await second.wait('checkpoint');await second.kill();
  const third=await recover(t,c,a.job);await completed(c,a.job);assert.equal((await intent(c))?.digest,original.digest);assert.equal(sends(c),1);assert.equal(tasks(c),1);await third.close();
});

test('R3-5 late reports retry reads while a valid first committed raw result survives later gateway loss',{timeout:120000},async t=>{
  for(const firstComplete of [false,true]){
  const c=await journal(t);let afterRestart=false;rewriteReply(c,'read_blob',value=>((afterRestart?!firstComplete:firstComplete)?value:{...value,complete:false,rows:[]}));
  const first=await child(t,c,'dispatch','result.response'),point=await first.wait('checkpoint');assert.ok(point.job);assert.ok(point.response);await first.kill();
  const raw=await c.kit.store.get<ActionBody>(point.response);assert.ok(raw);assert.equal(raw.body.detail.complete,true);assert.equal(typeof raw.body.detail.rpc_id,'number');assert.equal(raw.body.detail.rpc_method,'tools/call');
  const source=String(raw.body.inputs.find(value=>value.startsWith('src:')));const before=await c.kit.objects.get(source.slice(4));assert.ok(before);
  const readCount=c.calls.filter(name=>name==='read_blob').length;afterRestart=true;
  const worker=await recover(t,c,point.job);const state=await completed(c,point.job);assert.equal(state.outcome,'effective');assert.deepEqual(await c.kit.objects.get(source.slice(4)),before);if(firstComplete)assert.equal(c.calls.filter(name=>name==='read_blob').length,readCount,'valid saved original replaces unavailable remote read');else assert.ok(c.calls.filter(name=>name==='read_blob').length>readCount,'incomplete original cannot become a valid completed report');assert.equal(sends(c),1);await worker.close();
  }
});

test('R3-6 changed original account and actor are independently unknown, not accepted by the startup administrator',{timeout:90000},async t=>{
  for(const identityChange of ['subject','actor'] as const){
    const holder:{current?:ChildProcess}={};const c=await journal(t,{identityChange,onSubmit:async()=>{holder.current!.kill('SIGKILL');}});
    const job=await admittedAndKilled(t,c,holder);const originalActor=c.endpoint.calls.find(call=>call.params.name==='send_blob')!.headers['x-circle-hub-actor'];const worker=await recover(t,c,job);
    await eventual(()=>c.service.journal.events(job),events=>events.some(event=>event.body.detail.recovery===true&&event.body.detail.uncertain===true));
    const state=await c.service.status(c.admin,job);assert.equal(state.outcome,'unknown',identityChange);assert.equal(state.frozen,true,identityChange);assert.equal(c.endpoint.calls.filter(call=>call.params.name==='lookup_blob').at(-1)!.headers['x-circle-hub-actor'],originalActor);assert.equal(sends(c),1);assert.equal(c.calls.filter(name=>name==='read_blob').length,0);await worker.close();
  }
});

test('R3-7 expired original lease does not acquire a replacement; completed restart stays idempotent',{timeout:60000},async t=>{
  const holder:{current?:ChildProcess}={};const c=await journal(t,{onSubmit:async()=>{holder.current!.kill('SIGKILL');}});rewriteReply(c,'touch_slot',value=>({...value,ok:false}));
  const job=await admittedAndKilled(t,c,holder);c.clock.ms+=60000;const acquireCount=c.calls.filter(name=>name==='open_slot').length;
  const first=await recover(t,c,job);await completed(c,job);await first.close();
  const before=(await c.service.journal.events(job)).filter(event=>event.body.detail.phase==='complete'&&event.body.detail.done===true).map(event=>event.digest);
  const second=await recover(t,c,job);await second.close();
  assert.deepEqual((await c.service.journal.events(job)).filter(event=>event.body.detail.phase==='complete'&&event.body.detail.done===true).map(event=>event.digest),before);
  assert.equal(c.calls.filter(name=>name==='open_slot').length,acquireCount);assert.equal(sends(c),1);assert.equal(tasks(c),1);
});

test('R3-8 SIGKILL after ingestObservedRead inside the shared transaction exposes neither source nor response action',{timeout:60000},async t=>{
  const c=await journal(t);
  const first=await child(t,c,'dispatch','uncommitted-result'),point=await first.wait('checkpoint');assert.ok(point.source);assert.ok(point.sha256);const row=await intent(c);assert.ok(row);const job=String(row.body.detail.job);
  assert.equal(await c.kit.store.get(point.source),null,'uncommitted source record is not visible from the parent connection');
  assert.equal((await c.service.journal.events(job)).filter(event=>event.body.detail.phase==='result.response').length,0);
  await first.kill();await observationLockFree(c,job);
  assert.equal(await c.kit.store.get(point.source),null);assert.equal((await c.service.journal.events(job)).filter(event=>event.body.detail.phase==='result.response').length,0);
  const worker=await recover(t,c,job);await completed(c,job);assert.equal(sends(c),1);assert.equal(tasks(c),1);assert.ok(c.calls.filter(name=>name==='read_blob').length>=2);await worker.close();
});


test('R3-9 pending not-yet-started requests renew the original lease across injected TTL without acquire or submit',{timeout:60000},async t=>{
  const holder:{current?:ChildProcess}={};
  const c=await journal(t,{pendingReads:100000,onSubmit:async()=>{holder.current!.kill('SIGKILL');}});
  const job=await admittedAndKilled(t,c,holder),original=await intent(c);assert.ok(original);
  const remote=original.body.detail.remote_lease as {id:unknown;token:unknown;ttl:number};
  assert.ok(Number.isFinite(remote.ttl)&&remote.ttl>0);
  const acquired=c.calls.filter(name=>name==='open_slot').length,submitted=sends(c);
  const worker=await recover(t,c,job);
  await eventual(()=>c.service.journal.events(job),events=>events.some(event=>event.body.detail.phase==='query_pending'&&event.body.detail.recovery===true));
  const heartbeats=c.calls.filter(name=>name==='touch_slot').length;
  const advance=Math.ceil(remote.ttl*2);c.clock.ms+=advance;
  worker.process.send({type:'advance-clock',milliseconds:advance});await worker.wait('clock-advanced');
  await eventual(async()=>c.calls.filter(name=>name==='touch_slot').length,count=>count>heartbeats);
  const argumentsOfHeartbeat=c.endpoint.calls.filter(call=>call.params.name==='touch_slot').at(-1)!.params.arguments as Record<string,unknown>;
  assert.ok(argumentsOfHeartbeat.ticket===remote.id&&argumentsOfHeartbeat.token===remote.token,'heartbeat must use the original lease identity without printing it');
  const events=await c.service.journal.events(job);
  assert.equal(events.some(event=>event.body.detail.phase==='complete'&&event.body.detail.done===true),false,'a pending request has no completed effect');
  assert.equal(c.calls.filter(name=>name==='inspect_blob').length,0,'pending has no trusted remote task identity yet');
  assert.equal(c.calls.filter(name=>name==='read_blob').length,0);
  assert.equal(c.calls.filter(name=>name==='open_slot').length,acquired);
  assert.equal(sends(c),submitted);assert.equal(submitted,1);
  await worker.close();
});
