import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as fixture from '../fixtures/apv-module-flow-synthetic-provider-protocol.ts';
import {canonicalHash,sha256} from '../../packages/contracts/src/index.ts';

test('APV module fixture uses the entire frozen provider receipt policy without an echo fallback or selective mapping shadow',()=>{
 const policy={schema:'hub-provider-observation/1',receipts:{submit:{receiptSchema:{required:['sha256','case_ids']}}},identityProjection:{stepId:'workbook',export:'projectWorkbook'},toolArguments:{env_prepare:{device_build:{inputPath:['value','build']}}},lease:{argumentsByTool:{case_status:{}}}},bytes=Buffer.from(JSON.stringify({configuration:{receiptPolicy:policy}})),frozen:any={files:[{path:'resources/case-gateway.json',base64:bytes.toString('base64'),sha256:sha256(bytes)}]};
 const read=(fixture as any).frozenApvReceiptPolicy;assert.equal(typeof read,'function');const actual=read(frozen);assert.equal(canonicalHash(actual),canonicalHash(policy));assert.deepEqual(actual,policy);assert.notEqual(actual,policy);
 actual.identityProjection.export='tampered';assert.equal(read(frozen).identityProjection.export,'projectWorkbook');
 assert.throws(()=>read({files:[]}),/receipt policy|gateway resource/i);
});

test('APV synthetic provider stage originals correlate original workbook SHA and case identities without invented echo hashes',()=>{
 const raw=(fixture as any).apvProviderReceipt;assert.equal(typeof raw,'function');const state={taskId:'synthetic_task_301',workbook:Buffer.from('synthetic original workbook')},hash=sha256(state.workbook);
 const submit=raw(state,'case_submit'),status=raw(state,'case_status'),results=raw(state,'case_results');
 assert.deepEqual(submit,{ok:true,task_id:state.taskId,sha256:hash,case_ids:['301']});assert.equal(status.state,'done');assert.equal(status.rc,0);assert.equal(results.xlsx_sha256,hash);assert.equal(results.channel,'ready');
 for(const observed of [submit,status,results])for(const key of ['request_hash','input_sha256','byte_hashes'])assert.ok(!Object.hasOwn(observed,key),key);
 assert.ok(!Object.hasOwn(submit,'state'));assert.ok(!Object.hasOwn(results,'state'));
});
