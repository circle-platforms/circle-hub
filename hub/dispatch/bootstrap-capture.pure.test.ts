import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {resolveCallErrorReason} from '../../contracts/api.ts';
import {ExecutorDefinition} from './definition.ts';
import {definition} from './testing/definition.ts';
import {RpcClient} from './transport.ts';
import {EnvironmentRegistrationIncompleteError,isBootstrapCaptureDefinition,bootstrapCaptureObservation,registrationIncompleteRefusal} from './bootstrap-capture.ts';

const empty=()=>ExecutorDefinition.parse({...definition('http://127.0.0.1:1/mcp'),resources:[],manifest_sha256:null});
test('capture eligibility uses the resolved enabled definition and strict empty resources, not permission failure',()=>{
  const d=empty();
  assert.equal(isBootstrapCaptureDefinition(d),true);
  assert.equal(isBootstrapCaptureDefinition({...d,resources:['synthetic/seat']}),false);
  assert.equal(isBootstrapCaptureDefinition({...d,enabled:false}),false);
  assert.equal(isBootstrapCaptureDefinition({...d,target:''}),false);
  assert.equal(isBootstrapCaptureDefinition({...d,target:'  \t\n '}),false);
  const authored={...d,target:' synthetic-target '};
  assert.equal(isBootstrapCaptureDefinition(authored),true);
  assert.equal(authored.target,' synthetic-target ');
  assert.equal(isBootstrapCaptureDefinition({...d,target:'${var:DEMO_TARGET}'}),false);
});
test('the single typed refusal uses the formal code/reason and carries no hidden target or member command',()=>{
  const e=new EnvironmentRegistrationIncompleteError();
  assert.equal(e.protocol.code,'SOURCE_NOT_PERMITTED');
  assert.equal(e.protocol.call_error_reason,'environment_registration_incomplete');
  assert.equal(e.administratorExecutor,undefined);
  assert.equal(e.protocol.fix,undefined,'next steps belong to the server presenter');
  const rule=resolveCallErrorReason(e.protocol.code,e.protocol.call_error_reason,'user');
  assert.ok(rule&&'category' in rule.classification);
  assert.equal(rule.classification.category,'not_found');
  assert.doesNotMatch(JSON.stringify(e.protocol),/synthetic-bed|target|endpoint|resource|circle-hub/);
});
test('a known registration precondition remains unsent rather than an uncertain handler catch',()=>{
  const declined=registrationIncompleteRefusal(new EnvironmentRegistrationIncompleteError());
  assert.equal(declined.outcome,'not_dispatched');
  assert.equal(declined.call_error_reason,'environment_registration_incomplete');
  assert.equal(Object.hasOwn(declined,'call_error_category'),false,'the source does not create a second category/next table');
  assert.equal(Object.hasOwn(declined,'next_action'),false);
});
test('the observation index retains actual returned data and missing pointers without inventing resource keys',()=>{
  const value={inventory:['synthetic-a','synthetic-b'],version:'synthetic-version'};
  const result=bootstrapCaptureObservation('precheck','src:'+'a'.repeat(64),'rec:'+'b'.repeat(64),value,['/inventory','/absent']);
  assert.equal(result.observed,true);
  assert.deepEqual(result.value,value);
  assert.deepEqual(result.captures[0],{pointer:'/inventory',value:value.inventory});
  assert.equal(Object.hasOwn(result.captures[1],'value'),false);
  assert.ok(result.captures[1].missing_fact);
  assert.equal(Object.hasOwn(result,'resources'),false);
});
test('the optional per-request hook refuses before any HTTP request, even initialization',async t=>{
  let requests=0;
  t.mock.method(http,'request',()=>{requests++;throw new Error('no network is permitted in this pure test');});
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const refusal=new EnvironmentRegistrationIncompleteError();
  const operations:string[]=[];
  const client=new RpcClient(empty(),'synthetic-secret','synthetic-bootstrap',async()=>{throw new Error('no response to save');},()=>new Date(),undefined,async operation=>{operations.push(operation);throw refusal;});
  await assert.rejects(client.connect(),error=>error===refusal);
  assert.deepEqual(operations,['initialize']);
  assert.equal(requests,0);
});
