// Pure checks of synthetic argument words; no DNS lookup or external connection.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkParam} from './params.ts';
test('hostname arguments use bounded ASCII DNS labels rather than URL or address coercion',()=>{
  for(const value of ['node','node-2.example','Node-2.Example.','xn--bcher-kva.example'])assert.deepEqual(checkParam({name:'host',type:'hostname'},value,false),{ok:true},value);
  for(const value of ['', 'https://node.example/path','-bad.example','bad-.example','two..example','a'.repeat(64)+'.example','a'.repeat(255),'node/example','node:443','192.0.2.999','192.0.2.1'])assert.equal(checkParam({name:'host',type:'hostname'},value,false)?.ok,false,value);
});
test('address or hostname accepts only the declared union and retains length bounds',()=>{
  for(const value of ['192.0.2.1','2001:db8::1','node.example'])assert.deepEqual(checkParam({name:'peer',type:'ip_or_hostname'},value,false),{ok:true},value);
  for(const value of ['192.0.2.999','2001:db8:::1','https://192.0.2.1/path','user@node.example','node:443',' spaced'])assert.equal(checkParam({name:'peer',type:'ip_or_hostname'},value,false)?.ok,false,value);
  assert.equal(checkParam({name:'peer',type:'ip_or_hostname',maxLength:4},'node.example',false)?.ok,false);
});
