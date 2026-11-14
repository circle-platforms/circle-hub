import {ExecutorSource} from '../../contracts/src/resources.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TestEnvironment} from '../../contracts/api.ts';
import {canonicalBytes,sha256Hex,type RecordsKit,type Transaction} from '../records/api.ts';
import {MemberEnvironments} from './member-environments.ts';
import {definition} from './testing/definition.ts';

const actor={id:'usr_0'+'a'.repeat(25),name:'合成账户',role:'user' as const};
const first='exe_0'+'a'.repeat(25),second='exe_0'+'b'.repeat(25);
function environment(char:string,executors=[first]) {
  return TestEnvironment.parse({schema:'test-environment@1',id:'env_0'+char.repeat(25),name:'合成环境'+char,target:'synthetic-bed',prefixes:[],resources:[{key:'synthetic/device/a',owner:actor.id,registered_at:'2026-11-14T00:00:00.000Z'},{key:'synthetic/device/b',owner:actor.id,registered_at:'2026-11-14T00:00:00.000Z'}],executors,enabled:true,missing_facts:[]});
}
function fixture(values:TestEnvironment[], configured=true) {
  const events:string[]=[];
  const tx={} as Transaction;
  const sources=new Map([first,second].map(id=>{const bytes=canonicalBytes(ExecutorSource.parse({...definition('http://127.0.0.1:1/mcp'),id}));return [id,{bytes,sha:sha256Hex(bytes)}];}));
  const snapshots={user:actor,teams:()=>[],enabled:(record:unknown)=>record!==null&&record!==undefined,latest:(permission:string,_subject:string,id:string)=>permission==='resource_config'?(configured?{body:{bound:sources.get(id.slice('executor.'.length))?.sha}}:null):{body:{}}};
  const records={artifacts:{capturePermissionSnapshot:async(_by:unknown,supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);return snapshots;}},objects:{get:async(sha:string,supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);return [...sources.values()].find(source=>source.sha===sha)?.bytes??null;}},principals:{get:async()=>actor},testEnvironments:{
    inheritance:async(supplied?:Transaction)=>{assert.equal(supplied,tx);events.push('inheritance');return {completed:true,record:null,missingFacts:[]};},
    resolve:async(keys:readonly string[],supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);events.push('resolve:'+keys.join(','));return values.filter(value=>keys.every(key=>value.resources.some(row=>row.key===key)));},
    canUse:async(_by:unknown,id:string,supplied?:Transaction)=>{if(supplied)assert.equal(supplied,tx);events.push('permission:'+id);return true;},list:async()=>values,
  }} as unknown as RecordsKit;
  const instance=new MemberEnvironments(records,{readSource:async()=>{throw new Error('no unscoped executor read');}},{view:async()=>({entries:[]}),registrations:async()=>[]} as ConstructorParameters<typeof MemberEnvironments>[2]);
  return {instance,events,tx};
}

test('ambiguity is found before authorization and reveals no hidden environment identity',async()=>{
  const a=environment('a'),b={...environment('b'),name:'synthetic-hidden',target:'synthetic-hidden-target'};
  const {instance,events}=fixture([a,b]);
  const refusal=await instance.authorizeKeys(actor,['synthetic/device/a']);
  assert.equal(refusal?.code,'SOURCE_NOT_PERMITTED');
  assert.equal(events.some(event=>event.startsWith('permission:')),false);
  assert.doesNotMatch(JSON.stringify(refusal),/synthetic-hidden|env_|exe_/);
});

test('two executors explicitly bound to one target share one environment permission',async()=>{
  const env=environment('a',[first,second]);const {instance,events,tx}=fixture([env]);
  assert.equal(await instance.permission(actor,first,tx),true);
  assert.equal(await instance.permission(actor,second,tx),true);
  assert.equal(events.filter(event=>event==='permission:'+env.id).length,2);
});

test('matching resource keys alone never bind an unlisted executor',async()=>{
  const {instance,events,tx}=fixture([environment('a')]);
  assert.equal(await instance.permission(actor,second,tx),false);
  assert.equal(events.some(event=>event.startsWith('permission:')),false);
});

test('all keys are resolved before the first permission read',async()=>{
  const {instance,events}=fixture([environment('a')]);
  assert.equal(await instance.authorizeKeys(actor,['synthetic/device/a','synthetic/device/b']),null);
  assert.deepEqual(events.slice(0,2),['resolve:synthetic/device/a','resolve:synthetic/device/b']);
  assert.equal(events.length,3);
});

test('inheritance delegates the exact caller transaction without a startup cache',async()=>{
  const {instance,events,tx}=fixture([]);
  assert.equal((await instance.inheritance(tx)).completed,true);
  assert.equal((await instance.inheritance(tx)).completed,true);
  assert.deepEqual(events,['inheritance','inheritance']);
});


test('missing executor configuration is refused before dereferencing or reading source bytes',async()=>{
  const {instance,events,tx}=fixture([environment('a')],false);
  assert.equal(await instance.permission(actor,first,tx),false);
  assert.deepEqual(events,[]);
});
