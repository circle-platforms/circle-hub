import assert from 'node:assert/strict';
import {test} from 'node:test';
import {executionWorkbook} from '../fixtures/execution-workbook.ts';
import {readExecutionWorkbook} from '../../packs/apv/execution/workbook.ts';
import {executionResults} from '../../packs/apv/execution/results.ts';

const log='2042-03-04 05:06:07 node-a - sends command in config: service inspect alpha\nhealthy\nLAB#\n#### Success Num 1: successed to find healthy in:\nservice inspect alpha\nhealthy\nLAB#\n#### Success Num 2: fail to find panic in:\nservice inspect alpha\nhealthy\nLAB#\n#### Success Num 1: successed to find: healthy\n';
test('Execution contract: hidden marker, single execution sheet and exact commands are read independently',async()=>{
  const book=await readExecutionWorkbook(await executionWorkbook());assert.deepEqual(book.cases.map(item=>item.autoid),['301']);assert.equal(book.cases[0].steps.length,3);assert.deepEqual(book.commands.map(item=>item.command),['service inspect alpha']);
  for(const options of [{hidden:false},{sheet:'Cases'},{extraSheet:true}])await assert.rejects(readExecutionWorkbook(await executionWorkbook(options)),(error:any)=>error.code==='INVALID_EXECUTION_WORKBOOK');
  const segment=await readExecutionWorkbook(await executionWorkbook({object:'Seg1_tmp'}));assert.equal(segment.commands.length,1);assert.equal(segment.commands[0].deviceIndex,1);
  for(const options of [{object:'test_env'},{inputVariables:'{"command":"unverified"}'},{command:'service create name Reg0_tmp'}])await assert.rejects(readExecutionWorkbook(await executionWorkbook(options)),(error:any)=>error.code==='INVALID_EXECUTION_WORKBOOK');
});
test('Execution results: four checkpoint truth pairs, multiline patterns, summaries, stale and ambiguous logs never inherit a case pass',async()=>{
  const book=await readExecutionWorkbook(await executionWorkbook()),raw={task_id:'remote-one',channel:'ready',xlsx_sha256:book.sha256,rc:0,cases:[{case_id:'301',result:'pass',log_stale:false,log}]};
  const result=executionResults(book,raw);assert.equal(result.cases[0].verdict,'pass');assert.equal(result.cases[0].steps[0].status,'observed');assert.deepEqual(result.cases[0].checkPoints.map((check:any)=>[check.method,check.status]),[['found','passed'],['not_found','passed']]);assert.equal(result.cases[0].checkPoints[0].logSpan.startLine,4);
  const failed=executionResults(book,{...raw,cases:[{...raw.cases[0],result:'fail',log:log.replace('Success Num 1: successed','Fail Num 1: fail').replace('Success Num 2: fail','Fail Num 2: successed')}]});assert.ok(failed.cases[0].checkPoints.every((check:any)=>check.status==='failed'));
  for(const change of [{log_stale:true},{log:''},{log:log.replace('healthy in:', 'other in:')},{log:log+log}]){const incomplete=executionResults(book,{...raw,cases:[{...raw.cases[0],...change}]});assert.ok(incomplete.unmapped.length);assert.ok(incomplete.cases[0].checkPoints.some((check:any)=>check.status==='unknown'));}
  const missing=executionResults(book,{...raw,channel:'missing_after_done',cases:[]});assert.equal(missing.cases[0].verdict,'unknown');assert.ok(missing.cases[0].steps.every((step:any)=>step.status==='unknown'));
  const multiline=structuredClone(book);multiline.cases[0].steps[1].data='healthy\nready';const multiResult=executionResults(multiline,{...raw,cases:[{...raw.cases[0],log:log.replace('healthy in:', 'healthy\nready in:')}]});assert.equal(multiResult.cases[0].checkPoints[0].status,'passed');assert.equal(multiResult.cases[0].checkPoints[0].pattern,'healthy\nready');
  await assert.rejects(readExecutionWorkbook(Buffer.from('not a zip')));
});
