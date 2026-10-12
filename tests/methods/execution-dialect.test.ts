import assert from 'node:assert/strict';
import {test} from 'node:test';
import ExcelJS from 'exceljs';
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

test('Execution workbook: rejected dispatch rows identify row case object and method without echoing command data',async()=>{
  const broken=[
    {options:{hostCommand:{host:'reboot',command:'private-command-text'}},row:4,object:'test_env',method:'reboot'},
    {options:{method:'reboot',command:'private-command-text'},row:3,object:'APV_0',method:'reboot'},
    {options:{hostCommand:{host:'routera',command:'private-command-text,unsafe=1'}},row:4,object:'test_env',method:'routera'},
    {options:{hostCommand:{host:'routera',command:'private-command-text',inputRegister:'query_name'}},row:4,object:'test_env',method:'routera'},
  ];
  for(const item of broken)await assert.rejects(readExecutionWorkbook(await executionWorkbook(item.options)),(error:any)=>{
    assert.equal(error.code,'INVALID_EXECUTION_WORKBOOK');assert.deepEqual(error.details,{row:item.row,autoid:'301',object:item.object,method:item.method});assert.ok(!JSON.stringify(error.details).includes('private-command-text'));return true;
  });
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await executionWorkbook({hostCommand:{host:'routera',command:'dig example.test'}}) as any);
  workbook.worksheets[0].getCell('G4').value={formula:'1+1',result:2};
  await assert.rejects(readExecutionWorkbook(Buffer.from(await workbook.xlsx.writeBuffer())),(error:any)=>{assert.deepEqual(error.details,{row:4,autoid:'301',object:'test_env',method:'routera',column:7});return true;});
  workbook.worksheets[0].getCell('G4').value='dig example.test';
  workbook.worksheets[0].spliceRows(7,0,['902','P1',2,'Synthetic second case','test_env','reboot','private-command-text']);
  await assert.rejects(readExecutionWorkbook(Buffer.from(await workbook.xlsx.writeBuffer())),(error:any)=>{assert.deepEqual(error.details,{row:7,autoid:'902',object:'test_env',method:'reboot'});return true;});
});

test('Execution workbook: default host dispatch retains literal shell recipes rather than restricting clients to dig',async()=>{
  const recipes=[
    ['routera','dig @192.0.2.1 example.test -p 10001 +tcp TXT'],['routera','dig @192.0.2.1 example.test -p 16'],
    ['routera','sleep 1'],['routera','echo literal'],['routera','curl http://service.example.test/'],['routera','chmod 600 scratch.txt'],
    ['routera','kdig example.test'],['routera','for item in one two; do echo "$item"; done'],['routera','dnsperf -d queries.txt -l 1'],
    ['server231','rm -f scratch.txt'],['server231','tc qdisc show'],['server231','iptables -L'],['server231','systemctl status synthetic.service'],
  ];
  for(const [host,command] of recipes){const book=await readExecutionWorkbook(await executionWorkbook({hostCommand:{host,command}}));assert.equal(book.hostCommands[0].command,command);assert.equal(book.commands.length,1);}
});
