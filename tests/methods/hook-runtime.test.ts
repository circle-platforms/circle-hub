import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HookRuntime,verifyToolImports} from '../../packages/methods/src/hooks.ts';
const binding={method:{sha256:'a'.repeat(64)},resource:{assetId:'ast_fixture',version:'1.0.0',sha256:'b'.repeat(64),declaration:{allowedTestHosts:['fixture']}},source:{sourceArtifactId:'sar_synthetic'},inputRevision:'inrev_synthetic'};
test('Hook execution has no built-in decision and ordered frozen handlers return the exact hook result with provenance',()=>{
  const runtime=new HookRuntime();assert.deepEqual(runtime.run([],'verify.deviceCommand',{binding,subject:{command:'missing',tree:{heads:[]}}}),[]);
  const handlers=[{id:'fixture.check',version:'2.0.0',event:'verify.deviceCommand',order:1,code:"export default function handle(input){return input.subject.command==='allowed'?{decision:'pass'}:{decision:'block',code:'COMMAND_NOT_IN_TREE',facts:{command:input.subject.command}};}"}];const allowed=runtime.run(handlers,'verify.deviceCommand',{binding,subject:{command:'allowed',tree:{heads:[]}}});assert.equal(allowed[0].result.decision,'pass');assert.equal(allowed[0].ruleId,'fixture.check');assert.equal(allowed[0].ruleVersion,'2.0.0');const blocked=runtime.run(handlers,'verify.deviceCommand',{binding,subject:{command:'missing',tree:{heads:[]}}});assert.deepEqual(blocked[0].result,{decision:'block',code:'COMMAND_NOT_IN_TREE',facts:{command:'missing'}});
});
test('Hook execution cannot read environment escape into host code or run indefinitely',()=>{
  const runtime=new HookRuntime();for(const body of ['process.env','globalThis.constructor.constructor("return process")()','(()=>{while(true){}})()'])assert.throws(()=>runtime.run([{id:'bad',version:'1.0.0',event:'beforeDispatch',order:1,code:`export default function handle(){const value=${body};return {decision:'pass'};}`}],'beforeDispatch',{binding,subject:{input:{},operationId:'op_fixture'}}));
});
test('Tool imports are validated at loading including dynamic imports and local module traversal',()=>{
  const modules=new Map([['tools/main.ts',"import {z} from 'zod';import './helper.ts';export const result=z.string();"],['tools/helper.ts','export const helper=true;']]);verifyToolImports(modules,[{manifest:'tools/main.ts',imports:{zod:'4.6.5'}}]);assert.throws(()=>verifyToolImports(modules,[{manifest:'tools/main.ts',imports:{}}]),(error:any)=>error.code==='IMPORT_NOT_DECLARED');modules.set('tools/main.ts',"export const result=()=>import('node:fs');");assert.throws(()=>verifyToolImports(modules,[{manifest:'tools/main.ts',imports:{}}]),(error:any)=>error.code==='IMPORT_NOT_DECLARED');
});
test('Hook subject schemas are checked even with zero handlers and preserve the three agreed shapes',()=>{
  const runtime=new HookRuntime();for(const [event,subject]of [['verify.deviceCommand',{command:'literal'}],['verify.hostCommand',{command:1}],['verify.workbook',{client:'fixture',contract:{}}]] as const)assert.throws(()=>runtime.run([],event,{binding,subject}));
  assert.deepEqual(runtime.run([],'verify.workbook',{binding,subject:{client:'fixture',contract:{testEnvEnabled:[]}}}),[]);
});
