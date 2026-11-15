import test from 'node:test';
import assert from 'node:assert/strict';
import tools from '../../contracts/generated/tools.json' with {type:'json'};
import {requestSummary} from './request-summary.ts';
import {sha256Hex} from '../records/api.ts';

const run='run_00000000000000000000000001',sha='a'.repeat(64);
test('audit distinguishes an explicit run context from an unscoped fragment without copying selector text',()=>{
  const text=`src:${sha}/kityminder@1/n/PRIVATE-SELECTOR`;
  const unscoped=JSON.parse(requestSummary('get_nodes',{reference:text})!);
  const scoped=JSON.parse(requestSummary('get_nodes',{run,reference:text})!);
  assert.equal(unscoped.run_supplied,false);assert.equal(scoped.run_supplied,true);assert.equal(scoped.declared_run,run);
  assert.deepEqual(unscoped.declared_reference,{scheme:'src',source:sha,parser:'kityminder@1',selector_digest:sha256Hex('n/PRIVATE-SELECTOR'),selector_bytes:Buffer.byteLength('n/PRIVATE-SELECTOR')});
  assert.ok(!JSON.stringify(unscoped).includes('PRIVATE-SELECTOR'));
});
test('uploads, natural text, notes, custom parameter names and unknown property names are never copied',()=>{
  const markers=['PRIVATE-UPLOAD-BYTES','PRIVATE-FILENAME','PRIVATE-NOTE','PRIVATE-PARAMETER','PRIVATE-UNKNOWN'];
  const cases:Array<[string,unknown]>=[['upload_file',{file_path:markers[0],name:markers[1],media_type:'text/plain'}],['resolve_reference',{text:markers[2]}],['start_run',{pack:'synthetic-flow',parameters:{[markers[3]]:markers[2]},[markers[4]]:'secret'}],['submit_result',{run,model:'synthetic',items:[{notes:markers[2]}]}]];
  for(const [tool,args]of cases){const summary=requestSummary(tool,args)!;for(const marker of markers)assert.ok(!summary.includes(marker));assert.ok(Buffer.byteLength(summary)<=1024);}
});
test('only declared field names are logged even when unknown names contain sensitive-looking data',()=>{
  const result=JSON.parse(requestSummary('get_nodes',{reference:'free query',run:'not-an-id','PRIVATE-BUSINESS-KEY':'hidden'})!);
  assert.deepEqual(result.fields,['reference','run']);assert.equal(result.unknown_fields,1);assert.equal(result.declared_run,undefined);assert.equal(result.declared_reference,undefined);
});
test('all tool schemas can contribute bounded structure while unknown methods have no argument preview',()=>{
  for(const tool of tools){const result=requestSummary(tool.name,{});assert.ok(result);assert.ok(Buffer.byteLength(result)<=1024);}
  assert.equal(requestSummary('unknown-tool',{text:'hidden'}),null);
  assert.equal(requestSummary('initialize',{clientInfo:{name:'hidden'}}),null);
  for(const args of [null,[],42,false,'private input'])assert.ok(!requestSummary('get_nodes',args)!.includes('private input'));
});
test('non-source reference paths are represented by digest rather than business text',()=>{
  const result=JSON.parse(requestSummary('get_nodes',{reference:`tree:${sha}/PRIVATE-PATH`})!);
  assert.equal(result.declared_reference.root,sha);assert.ok(result.declared_reference.path_digest);assert.ok(!JSON.stringify(result).includes('PRIVATE-PATH'));
});
