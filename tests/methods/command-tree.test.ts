import assert from 'node:assert/strict';
import {test} from 'node:test';
import {commandCheck,commandHeads,commandParam,shlex} from '../../packages/methods/src/command-tree.ts';

const tree=[
  {name:'service create',arguments:[]},
  {name:'service create port',arguments:[{position:'1',type:'U16',optional:'false',help:'TCP port',min:'1',max:'65535'}]},
  {name:'service name',arguments:[{position:'1',type:'STRING'}]},
  {name:'service address',arguments:[{position:'1',type:'IPADDR'}]},
  {name:'service mode',arguments:[{position:'1',type:'STRING',enum:'active|standby'}]},
  {name:'service mask',arguments:[{position:'1',type:'IPMASK'}]},
  {name:'service optional',arguments:[{position:'1',type:'U32',optional:'true'}]},
];
test('Command rules use POSIX quote splitting lowercase longest heads and explicit parameter violations',()=>{
  assert.deepEqual(shlex('SERVICE name "A B" \\c'),['service','name','a b','c']);
  assert.equal(commandParam(tree,'service create port 80').head,'service create port');
  const input=['service create port 80','service create port','service create port 80 extra','service create port 65536','service address 203.0.113.4','service address bad','service mode ACTIVE','service mode unknown','service mask 255.0.255.0','service optional','service optional 4294967296','missing head','service name "unfinished'];
  const result=commandCheck(tree,input);assert.deepEqual(commandCheck(tree,input),result);
  assert.deepEqual(result.commands.map((c:any)=>c.violations[0]?.code??null),[null,'ARGUMENT_COUNT','ARGUMENT_COUNT','OUT_OF_RANGE',null,'TYPE_MISMATCH',null,'ENUM_MISMATCH','TYPE_MISMATCH',null,'OUT_OF_RANGE','HEAD_MISSING','TOKENIZE_ERROR']);
  assert.equal(result.commands[0].head,'service create port');assert.equal(result.commands[11].status,'missing');
});
test('Command heads never truncate and unsupported XML parameter types remain unknown',()=>{
  assert.throws(()=>commandHeads(tree,'service',2),(e:any)=>e.code==='RESULT_TOO_LARGE');
  const unknown=commandCheck([{name:'unknown',arguments:[{type:'VENDOR_TYPE'}]}],['unknown token']);assert.equal(unknown.commands[0].violations[0].code,'UNSUPPORTED_PARAMETER_TYPE');
});
