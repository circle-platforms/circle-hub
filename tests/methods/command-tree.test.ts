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

test('Command overloads merge heads return every unique signature and accept any fully matching signature',()=>{
  const one:Parameters<typeof commandParam>[0][number]={name:'monitor sample memory utilization',scope:'configuration',arguments:[{type:'U16',min:'1',max:'90'}]},many:typeof one={...one,arguments:[{type:'STRING',enum:'high|low'},{type:'U16',min:'1',max:'90'},{type:'IPADDR'},{type:'STRING'},{type:'STRING',optional:'true'}]},commands=[...tree,one,many,many];
  assert.deepEqual(commandHeads(commands,'service').heads,commandHeads(tree,'service').heads,'Overloads elsewhere must not poison a prefix lookup');assert.equal(commandHeads(commands,'monitor').heads.length,1);
  const params=commandParam(commands,one.name);assert.equal(params.signatures.length,2);assert.deepEqual(params.signatures.map((item:any)=>item.parameters.length),[1,5]);assert.deepEqual(params.parameters,[]);assert.equal(params.overloaded,true);
  const input=[`${one.name} 80`,`${one.name} high 80 203.0.113.7 tag`,`${one.name} high 91 203.0.113.7 tag`,`${one.name} wrong`,`${one.name} high 80 invalid tag`],checked=commandCheck(commands,input);
  assert.equal(checked.commands[0].violations.length,0);assert.equal(checked.commands[1].violations.length,0);assert.ok(checked.commands[2].violations.length);assert.ok(checked.commands[3].violations.length);assert.ok(checked.commands[4].violations.length);assert.equal(checked.commands[1].matchedSignatures.length,1);assert.equal(checked.commands[2].signatureChecks.length,2);assert.deepEqual(commandCheck(commands,input),checked);
});
