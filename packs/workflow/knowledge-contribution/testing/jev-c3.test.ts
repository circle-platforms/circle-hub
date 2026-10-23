import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {Hub} from '../tools/jev/lib/hub.ts';
import {HUB_KEY} from './servers.ts';
test('c3 1 submission refusal remains a receipt while read refusals remain typed errors',async t=>{
 const receipt={call_result:'error',acceptance:'not_accepted',errors:[{code:'RUN_SUPERSEDED',item:'p_synthetic',fix:'对新运行提交'}]};const server=createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);const input=JSON.parse(Buffer.concat(parts).toString());res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:input.method==='initialize'?{}:{content:[{type:'text',text:'合成拒绝回执'}],structuredContent:receipt}}));});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>server.close());const hub=new Hub(`http://127.0.0.1:${(server.address() as any).port}`,HUB_KEY,()=>{});assert.deepEqual(await hub.call('submit_result',{}),receipt);await assert.rejects(()=>hub.call('get_nodes',{}),/RUN_SUPERSEDED/);
});
