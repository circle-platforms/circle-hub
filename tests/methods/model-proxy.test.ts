import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {modelProxy} from '../../packages/runtime/src/model-proxy.ts';
import {redactBytes} from '../../packages/runtime/src/redaction.ts';
test('Model credentials remain behind the trusted run proxy and arbitrary paths unauthorized calls or remote endpoints are refused',async t=>{
  const key='synthetic-upstream-key-private';let seen='';const upstream=createServer((req,res)=>{seen=req.headers.authorization??'';res.end('{"synthetic":true}');});await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>{upstream.closeAllConnections();return new Promise<void>(resolve=>upstream.close(()=>resolve()));});const endpoint=`http://127.0.0.1:${(upstream.address() as any).port}/v1`,proxy=await modelProxy(endpoint,key,{allowedUpstreams:[endpoint]});t.after(proxy.close);assert.notEqual(proxy.nonce,key);assert.equal((await fetch(proxy.url+'/models')).status,401);assert.equal((await fetch(proxy.url+'/unrelated',{headers:{authorization:'Bearer '+proxy.nonce}})).status,405);const result=await fetch(proxy.url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+proxy.nonce},body:'{}'});assert.equal(result.status,200);assert.equal(seen,'Bearer '+key);await assert.rejects(modelProxy('http://source.example.test',key));
});
test('Credential redaction preserves unrelated binary bytes and marks any replacement',()=>{const bytes=Buffer.concat([Buffer.from([0,255]),Buffer.from('synthetic-key'),Buffer.from([128,0])]),result=redactBytes(bytes,['synthetic-key']);assert.equal(result.sanitized,true);assert.deepEqual(result.bytes.subarray(0,2),Buffer.from([0,255]));assert.deepEqual(result.bytes.subarray(-2),Buffer.from([128,0]));assert.ok(!result.bytes.includes(Buffer.from('synthetic-key')));});
test('Model proxy preserves bounded SSE and records metadata only while rejecting upstream errors and oversize bodies',async t=>{
  let calls=0;const metadata:any[]=[];
  const upstream=createServer((req,res)=>{calls++;assert.equal(req.headers.cookie,undefined);assert.equal(req.headers['x-api-key'],undefined);assert.equal(req.headers.authorization,'Bearer synthetic-real-key');if(calls===1){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: one\n\n');setTimeout(()=>res.end('data: two\n\n'),5);}else if(calls===2){res.writeHead(403);res.end('private rejection body');}else res.end('x'.repeat(200));});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>{upstream.closeAllConnections();return new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const proxy=await modelProxy(`http://127.0.0.1:${(upstream.address() as any).port}/v1`,'synthetic-real-key',{allowedUpstreams:[`http://127.0.0.1:${(upstream.address() as any).port}/v1`],requestBytes:64,responseBytes:64,onMetadata:item=>{metadata.push(item);}});t.after(proxy.close);
  const headers={authorization:'Bearer '+proxy.nonce,cookie:'forbidden','x-api-key':'forbidden',host:'untrusted.example.test'},url=proxy.url+'/chat/completions';
  assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer wrong'},body:'{}'})).status,401);assert.equal(calls,0);
  const stream=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(await stream.text(),'data: one\n\ndata: two\n\n');
  const denied=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(denied.status,502);assert.ok(!(await denied.text()).includes('private rejection'));assert.equal(proxy.failure?.code,'MODEL_UPSTREAM_REJECTED');
  const oversized=await fetch(url,{method:'POST',headers,body:'x'.repeat(100)});assert.equal(oversized.status,413);assert.equal(calls,2);
  const large=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(large.status,502);assert.equal(proxy.failure?.code,'MODEL_UPSTREAM_REJECTED');
  await proxy.flush();assert.ok(metadata.length===4);assert.ok(metadata.every(item=>item.upstreamHost==='127.0.0.1'&&Number.isInteger(item.requestBytes)&&Number.isInteger(item.responseBytes)&&item.durationMs>=0));assert.ok(!JSON.stringify(metadata).includes('one'));assert.ok(!JSON.stringify(metadata).includes('synthetic-real-key'));await proxy.close();await assert.rejects(fetch(url,{method:'POST',headers,body:'{}'}));
});
