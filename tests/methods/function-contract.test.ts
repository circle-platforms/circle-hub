import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FunctionContract} from '../../packs/apv/execution/function-contract.ts';
import {readExecutionWorkbook} from '../../packs/apv/execution/workbook.ts';
import {executionWorkbook} from '../fixtures/execution-workbook.ts';
import {functionContract} from '../fixtures/command-source.ts';

function contract(){
  const value=JSON.parse(functionContract().toString());
  value.runtime={minimum_version:'1.0.0',runner_source:'synthetic/runner.ts',runner_sha256:'1'.repeat(64),found_times_supported:true};
  value.source_hashes={'synthetic/fixture.ts':'2'.repeat(64)};
  value.objects=['APV_0','APV_1','test_env','check_point','time'].map(e=>({e,python_type:'synthetic.Fixture',mro:['Fixture'],status:'enabled',reason:'Synthetic declaration',status_authority:'synthetic',source:{path:'synthetic/fixture.ts',line:1}}));
  value.entries.push({e:'test_env',f:'console',status:'enabled'});
  value.entries=value.entries.map((entry:any)=>({...entry,python_symbol:'synthetic.Fixture.method',signature:{parameters:['command'],required:['command'],optional:['prompt','timeout'],text:'Synthetic signature'},g_syntax:'literal',h_semantics:'output register',i_semantics:'input register',dispatch:'synthetic',reason:'Synthetic declaration',status_authority:'synthetic',source:{path:'synthetic/fixture.ts',line:1},minimum_runtime:'1.0.0'}));
  value.execute_actions=[];value.atlas_snapshot={object_count:value.objects.length,execute_capability_count:0};value.contract_sha256='3'.repeat(64);
  value.certification={schema:'synthetic-certification/1',basis_contract_sha256:'4'.repeat(64),certified_entries_sha256:'5'.repeat(64),basis_contract_file_sha256:'6'.repeat(64),deployment_receipt_sha256:'7'.repeat(64),receipt_set_sha256:'8'.repeat(64),receipt_count:0};return value;
}

test('Function contract: full reference-shaped metadata leaves the enabled method gate and unsupported console boundary intact',async()=>{
  const functions=new FunctionContract(Buffer.from(JSON.stringify(contract())));
  assert.equal(functions.status('test_env','routera'),'enabled');assert.equal(functions.status('test_env','console'),'enabled');assert.equal(functions.status('test_env','reboot'),'absent');assert.equal(functions.status('test_env','close'),'internal');assert.equal(functions.status('APV_0','reboot'),'disabled');
  const book=await readExecutionWorkbook(await executionWorkbook({command:'service create port 443',hostCommand:{host:'routera',command:'dig example.test'}}),functions);assert.equal(book.commands.length,1);assert.equal(book.hostCommands.length,1);
  for(const host of ['reboot','close','console'])assert.equal((await readExecutionWorkbook(await executionWorkbook({hostCommand:{host,command:'literal'}}),functions)).hostCommands[0].host,host);
  await assert.rejects(readExecutionWorkbook(await executionWorkbook({method:'reboot',command:'literal'}),functions),(error:any)=>error.code==='INVALID_EXECUTION_WORKBOOK');
});

test('Function contract: incomplete duplicate and unknown states fail closed and disabled objects cannot enable a method',()=>{
  const base=contract();
  for(const value of [{...base,complete:false},{...base,entries:[...base.entries,base.entries[0]]},{...base,entries:[{e:'test_env',f:'routera',status:'unknown'}]},{...base,objects:[...base.objects,base.objects[0]]}])assert.throws(()=>new FunctionContract(Buffer.from(JSON.stringify(value))),(error:any)=>error.code==='INVALID_PAYLOAD');
  const functions=new FunctionContract(Buffer.from(JSON.stringify({...base,objects:base.objects.map((object:any)=>object.e==='test_env'?{...object,status:'disabled'}:object)})));assert.equal(functions.status('test_env','routera'),'disabled');
});
