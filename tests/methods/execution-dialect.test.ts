import assert from 'node:assert/strict';
import {test} from 'node:test';
import {frameworkArguments,SHELL_HOST_METHODS} from '../../packs/apv/execution/dialect.ts';
import {readExecutionWorkbook} from '../../packs/apv/execution/workbook.ts';
import {executionWorkbook} from '../fixtures/execution-workbook.ts';

test('Execution dialect: quoted comma arguments and prompt/timeout are parsed without rewriting shell or device syntax',()=>{
  assert.deepEqual(frameworkArguments('"dig @192.0.2.1 example.test TXT",prompt=router#,timeout=30'),{command:'dig @192.0.2.1 example.test TXT',kwargs:{prompt:'router#',timeout:30}});
  assert.deepEqual(frameworkArguments('"printf a,b",timeout=15'),{command:'printf a,b',kwargs:{timeout:15}});
  assert.equal(frameworkArguments('curl "http://service.example.test/?x=y"').command,'curl "http://service.example.test/?x=y"');
  assert.equal(frameworkArguments('echo one\necho two,timeout=10').command,'echo one\necho two,timeout=10');
  for(const text of ['dig example.test,unsafe=1','dig example.test,timeout=-1','dig example.test,timeout=0','dig example.test,timeout=1,timeout=2','"unclosed','first,second'])assert.throws(()=>frameworkArguments(text),(error:any)=>error.code==='INVALID_EXECUTION_WORKBOOK');
});

test('Execution dialect: enabled shell hosts are supported while lifecycle reboot console and fuzzy methods are rejected',async()=>{
  for(const host of SHELL_HOST_METHODS){const book=await readExecutionWorkbook(await executionWorkbook({hostCommand:{host,command:'dig @192.0.2.1 example.test,timeout=30'}}));assert.equal(book.hostCommands[0].command,'dig @192.0.2.1 example.test');assert.equal(book.hostCommands[0].kwargs.timeout,30);}
  for(const host of ['reboot','close','xlsx_begin','__init__','console','unregistered','RouterA'])await assert.rejects(readExecutionWorkbook(await executionWorkbook({hostCommand:{host,command:'dig example.test'}})),(error:any)=>error.code==='INVALID_EXECUTION_WORKBOOK');
  const book=await readExecutionWorkbook(await executionWorkbook({command:'"service create port 443",timeout=30,prompt=LAB#'}));assert.equal(book.commands[0].command,'service create port 443');
  const captured=await readExecutionWorkbook(await executionWorkbook({hostCommand:{host:'routera',command:'dig example.test',saveAs:'reply_one'}}));assert.equal(captured.cases[0].steps[1].saveAs,'reply_one');
  await assert.rejects(readExecutionWorkbook(await executionWorkbook({hostCommand:{host:'routera',command:'dig {}',inputRegister:'query_name'}})),(error:any)=>error.code==='INVALID_EXECUTION_WORKBOOK');
});
