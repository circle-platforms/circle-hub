import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {verifyProviderReceipt,preDispatchRefusal,verifyProviderDirectory,providerCallWire,usesPlaintextAuthentication,providerLeaseArguments,providerHeartbeatInterval} from '../../packages/execution/src/flow-provider.ts';
import {McpGateway} from '../../packages/connectors/src/case-gateway.ts';
import {frozenToolWire,freezeProviderReceipt,mayReleaseFlowLease} from '../../packages/execution/src/flow-worker.ts';
import {hydrateReturn} from '../../packages/connectors/src/return-pointers.ts';
import {EXECUTION_TRANSITION_LIMITS,canonicalJson,sha256} from '../../packages/contracts/src/index.ts';

const digest=(letter:string)=>letter.repeat(64);
const policy={
 remoteIdPath:['task_id'],requestHashPath:['request_hash'],inputSha256Path:['input_sha256'],byteHashesPath:['byte_hashes'],statePath:['state'],runningValues:['running'],terminalValues:['done'],
 receiptSchema:{type:'object',required:['ok','task_id','request_hash','input_sha256','byte_hashes','state'],properties:{ok:{const:true},task_id:{type:'string'},request_hash:{type:'string'},input_sha256:{type:'string'},byte_hashes:{type:'object'},state:{enum:['running','done']}},additionalProperties:true},
 refusal:{stagePath:['stage'],preDispatchStages:['lease','validation','environment'],dispatchedPath:['dispatched'],remoteIdPath:['task_id']},
};
const binding={receiptPolicy:policy},identity={remoteId:'remote_fixture',requestHash:digest('a'),inputSha256:digest('b')},byteHashes={first:digest('c'),second:digest('d')};
const receipt=()=>({ok:true,task_id:identity.remoteId,request_hash:identity.requestHash,input_sha256:identity.inputSha256,byte_hashes:{second:byteHashes.second,first:byteHashes.first},state:'done',result:{verdict:'PASS'}});
const insufficient=(fn:()=>unknown)=>assert.throws(fn,(error:any)=>error.code==='EVIDENCE_INSUFFICIENT');

test('Generic flow receipt: approved terminal proof binds the original identity and canonical byte hashes rather than object key order',()=>{
 assert.deepEqual(verifyProviderReceipt(binding,receipt(),identity,byteHashes,true),{remoteId:identity.remoteId,state:'done'});
 assert.deepEqual(verifyProviderReceipt(binding,{...receipt(),state:'running'},identity,byteHashes,false),{remoteId:identity.remoteId,state:'running'});
 insufficient(()=>verifyProviderReceipt(binding,{...receipt(),state:'running'},identity,byteHashes,true));
});

test('Generic flow receipt: another operation revision or original cannot be re-labelled as the persisted successful write',()=>{
 for(const changed of [
  {...receipt(),task_id:'remote_other'},
  {...receipt(),request_hash:digest('e')},
  {...receipt(),input_sha256:digest('f')},
  {...receipt(),byte_hashes:{...byteHashes,first:digest('e')}},
  {...receipt(),byte_hashes:{first:byteHashes.first}},
  {...receipt(),byte_hashes:{first:byteHashes.first,second:byteHashes.second,extra:digest('e')}},
 ])insufficient(()=>verifyProviderReceipt(binding,changed,identity,byteHashes,true));
});

test('Generic flow receipt: a product PASS or terminal claim never substitutes for the approved provider state and required receipt fields',()=>{
 insufficient(()=>verifyProviderReceipt(binding,{...receipt(),state:'running',terminal:true,result:{verdict:'PASS',terminal:true}},identity,byteHashes,true));
 for(const changed of [{...receipt(),ok:false},{...receipt(),state:'unrecognized'},{result:{verdict:'PASS',terminal:true}}])assert.throws(()=>verifyProviderReceipt(binding,changed,identity,byteHashes,true));
});

test('Generic flow refusal: only an explicit failure before dispatch with no remote identity proves a failed write',()=>{
 const refusal={ok:false,stage:'validation',dispatched:false,reason:'Synthetic contract rejection'};
 assert.equal(preDispatchRefusal(policy,refusal),true);
 for(const changed of [
  {...refusal,ok:true},
  {...refusal,dispatched:true},
  {...refusal,stage:'execution'},
  {...refusal,task_id:'remote_fixture'},
  {...refusal,task_id:''},
  {...refusal,task_id:null},
  {ok:false,stage:'validation'},
 ])assert.equal(preDispatchRefusal(policy,changed),false);
 assert.ok(!preDispatchRefusal(policy,null));
});

test('Generic flow refusal: nested receipt paths preserve absence versus a present empty or null identity',()=>{
 const nested={...policy,refusal:{...policy.refusal,stagePath:['observation','stage'],dispatchedPath:['observation','dispatched'],remoteIdPath:['observation','task_id']}};
 assert.equal(preDispatchRefusal(nested,{ok:false,observation:{stage:'lease',dispatched:false}}),true);
 for(const task_id of ['',null,'remote_fixture'])assert.equal(preDispatchRefusal(nested,{ok:false,observation:{stage:'lease',dispatched:false,task_id}}),false);
 assert.equal(preDispatchRefusal(nested,{ok:false,observation:{stage:'lease',dispatched:false},stage:'validation',dispatched:false,task_id:'outer-not-selected'}),true);
});

test('Generic provider authentication: explicit anonymous loopback calls omit Bearer and an absent required credential never falls back',async t=>{
 const calls:{authorization:string|undefined}[]=[],server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const rpc=JSON.parse(Buffer.concat(chunks).toString());calls.push({authorization:req.headers.authorization});res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{tools:[]}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const profile={endpoint:`http://127.0.0.1:${(server.address() as any).port}/mcp`},anonymous=new McpGateway(profile,async()=>'',{allowAnonymous:true});assert.deepEqual(await anonymous.rpc('tools/list',{}),{tools:[]});assert.equal(calls[0].authorization,undefined);
 const required=new McpGateway(profile,async()=>''),before=calls.length;await assert.rejects(required.rpc('tools/list',{}),(error:any)=>error.code==='SOURCE_LOGIN_EXPIRED');assert.equal(calls.length,before);
});

test('Generic provider directory: effect drift is rejected independently of unchanged input schema',()=>{
 const read={name:'status',effect:'read',inputSchema:{type:'object'},annotations:{readOnlyHint:true}};
 verifyProviderDirectory([read],[{...read}]);verifyProviderDirectory([read],[{name:'status',inputSchema:read.inputSchema}]);
 for(const actual of [{...read,effect:'write'},{...read,annotations:{readOnlyHint:false}},{...read,annotations:{readOnlyHint:'true'}},{...read,inputSchema:{type:'object',additionalProperties:false}}])assert.throws(()=>verifyProviderDirectory([read],[actual]),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
 assert.throws(()=>verifyProviderDirectory([read],[read,read]),(error:any)=>error.code==='SOURCE_NOT_APPROVED');
});

test('Generic flow wire: true Tool bytes and expanded provider parameters include full framing and cannot bypass the existing input ceiling',()=>{
 const bytes=Buffer.alloc(64*1024+13,77),wire=frozenToolWire([['tools/fixture.ts','export function parse(){}']],[], 'tools/fixture.ts','parse',[bytes]),parsed=JSON.parse(wire);assert.deepEqual(Buffer.from(parsed.args[0].$bytes,'base64'),bytes);assert.equal(parsed.path,'tools/fixture.ts');assert.equal(parsed.export,'parse');assert.equal(parsed.args[0].type,undefined);
 const args=Object.fromEntries(Array.from({length:401},(_,index)=>['payload_'+index,bytes.toString('base64')]));assert.throws(()=>providerCallWire(1,'submit',args,{'hub/requestHash':digest('a')}),(error:any)=>error.code==='BODY_TOO_LARGE');
 const exact=providerCallWire(1,'submit',{payload_b64:bytes.toString('base64')},{'hub/requestHash':digest('a')});assert.ok(Buffer.byteLength(exact)<EXECUTION_TRANSITION_LIMITS.toolInputWireBytes);assert.equal(JSON.parse(exact).params._meta['hub/requestHash'],digest('a'));
});

test('Generic provider originals: a large NUL-bearing result is stored by exact canonical SHA and only a verified pointer is returned',async()=>{
 const storage=new Map<string,Buffer>(),objects={putObject:async({Key,Body}:any)=>{storage.set(Key,Buffer.from(Body));},getObject:async({Key}:any)=>Buffer.from(storage.get(Key)!)};
 const result={ok:true,log:'x'.repeat(3*1024*1024)+'\u0000終'},expected=Buffer.from(canonicalJson(result)),pointer=await freezeProviderReceipt(objects,'op_fixture','terminal',result);
 assert.equal(pointer.path,'flow/op_fixture/terminal');assert.equal(pointer.objectKey,sha256(expected));assert.equal(pointer.sha256,pointer.objectKey);assert.equal(pointer.size,expected.length);assert.equal((pointer as any).contentBase64,undefined);assert.ok(JSON.stringify(pointer).length<1024);
 const restored=await hydrateReturn(objects,pointer);assert.deepEqual(Buffer.from(restored.contentBase64,'base64'),expected);assert.equal(JSON.parse(expected.toString()).log.at(-2),'\u0000');
 await assert.rejects(hydrateReturn(objects,{...pointer,size:pointer.size+1}),(error:any)=>error.code==='SOURCE_HASH_MISMATCH');
 storage.set(pointer.objectKey,Buffer.from('tampered'));await assert.rejects(hydrateReturn(objects,pointer),(error:any)=>error.code==='SOURCE_HASH_MISMATCH');
});

test('Generic provider plaintext facts: approved exception configuration alone cannot mark TLS anonymous or loopback traffic as plaintext authentication',()=>{
 assert.equal(usesPlaintextAuthentication({endpoint:'http://192.0.2.42/mcp'},true),true);
 for(const [endpoint,authenticated]of [['https://192.0.2.42/mcp',true],['http://192.0.2.42/mcp',false],['http://127.0.0.1/mcp',true],['http://localhost/mcp',true],['http://[::1]/mcp',true]] as const)assert.equal(usesPlaintextAuthentication({endpoint},authenticated),false);
});

test('Generic provider lease: only nonempty identity positive safe fence and explicit finite TTL can reach dispatch',()=>{
 const selected={lease:{idPath:['id'],fencePath:['fence'],idArgument:'lease_id',fenceArgument:'token',ttlSecondsPath:['ttl']}},raw={id:'lease_fixture',fence:1,ttl:120};assert.deepEqual(providerLeaseArguments(selected,raw),{lease_id:'lease_fixture',token:1});assert.equal(providerHeartbeatInterval(selected,raw),20000);
 for(const id of ['', ' ', '\u0000',null,1])insufficient(()=>providerLeaseArguments(selected,{...raw,id}));
 for(const fence of [0,-1,0.5,Number.MAX_SAFE_INTEGER+1,NaN])insufficient(()=>providerLeaseArguments(selected,{...raw,fence}));
 for(const ttl of [undefined,null,'120',0,-1,NaN,Infinity])insufficient(()=>providerHeartbeatInterval(selected,{...raw,ttl}));
 // Valid lease identity is obtained before checking TTL, so failure can release it.
 assert.deepEqual(providerLeaseArguments(selected,{...raw,ttl:NaN}),{lease_id:'lease_fixture',token:1});
 insufficient(()=>providerLeaseArguments({lease:{...selected.lease,fenceArgument:'lease_id'}},raw));
});

test('Generic provider cleanup: an unsuccessful independent observation cannot release the unknown parent lease',()=>{
 assert.equal(mayReleaseFlowLease(true,false,false,false),false);
 assert.equal(mayReleaseFlowLease(true,false,true,false),true);
 assert.equal(mayReleaseFlowLease(false,false,false,false),true);
 assert.equal(mayReleaseFlowLease(false,true,false,false),false);
 assert.equal(mayReleaseFlowLease(false,true,false,true),true);
});
