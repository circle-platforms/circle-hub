import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RpcClient } from './transport.ts';
import { ExecutorDefinition } from './definition.ts';
import { definition } from './testing/definition.ts';
import { startEndpoint } from './testing/server.ts';

test('tools are checked before calling, extra management tools are never called, and originals are stored before interpretation', async t => {
  const server = await startEndpoint([...definition('x').allowed_tools, 'synthetic_admin_reset'], () => ({ ok: true, echo: 'Bearer synthetic-secret' }));
  t.after(() => server.close());
  const saved: string[] = [];
  const client = new RpcClient(ExecutorDefinition.parse(definition(server.endpoint)), 'synthetic-secret', 'synthetic-job', async bytes => { saved.push(new TextDecoder().decode(bytes)); return 'src:' + 'a'.repeat(64); });
  await client.connect();
  const result = await client.call('precheck', {});
  assert.equal((result.value as any).echo, 'Bearer [已隐藏]');
  assert.ok(saved.some(s => s.includes('echo')));
  assert.ok(saved.every(s => !s.includes('synthetic-secret')));
  assert.ok(server.calls.every(c => c.headers.authorization === 'Bearer synthetic-secret' && c.headers['x-circle-hub-actor'] === 'synthetic-job'));
  assert.deepEqual(server.calls.filter(c => c.method === 'tools/call').map(c => c.params.name), ['inspect_slot']);
});

test('missing tools stop before all lifecycle calls; redirects and oversized replies are not followed or accepted', async t => {
  const missing = await startEndpoint(['inspect_slot'], () => ({})); t.after(() => missing.close());
  const client = new RpcClient(ExecutorDefinition.parse(definition(missing.endpoint)), 'synthetic-secret', 'synthetic-job', async () => 'src:' + 'a'.repeat(64));
  await assert.rejects(client.connect());
  assert.equal(missing.calls.filter(c => c.method === 'tools/call').length, 0);
  const redirected = await startEndpoint(definition('x').allowed_tools, (_n, _a, res) => { res.writeHead(307, { location: 'http://192.0.2.1/' }).end(); }); t.after(() => redirected.close());
  const other = new RpcClient(ExecutorDefinition.parse(definition(redirected.endpoint)), 'synthetic-secret', 'synthetic-job', async () => 'src:' + 'a'.repeat(64));
  await other.connect(); await assert.rejects(other.call('precheck', {}));
  const big = await startEndpoint(definition('x').allowed_tools, () => ({ text: 'x'.repeat(4096) })); t.after(() => big.close());
  const capped = new RpcClient(ExecutorDefinition.parse({ ...definition(big.endpoint), max_bytes: 2048 }), 'synthetic-secret', 'synthetic-job', async () => 'src:' + 'a'.repeat(64));
  await capped.connect(); await assert.rejects(capped.call('precheck', {}));
});

test('TLS trusts exactly the configured CA and verifies the endpoint identity', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-tls-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'cert.conf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=synthetic\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  for (const name of ['one', 'two']) execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-config', join(dir, 'cert.conf'), '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`)], { stdio: 'ignore' });
  const cert = await readFile(join(dir, 'one.pem'), 'utf8');
  const endpoint = await startEndpoint(definition('x').allowed_tools, () => ({ ok: true }), { key: await readFile(join(dir, 'one.key')), cert }); t.after(() => endpoint.close());
  const make = (ca: string) => new RpcClient(ExecutorDefinition.parse({ ...definition(endpoint.endpoint), ca }), 'synthetic-secret', 'synthetic-job', async () => 'src:' + 'a'.repeat(64));
  const right = make(cert); await right.connect(); assert.equal(((await right.call('precheck', {})).value as any).ok, true);
  await assert.rejects(make(await readFile(join(dir, 'two.pem'), 'utf8')).connect());
});

test('bounded SSE replies are saved before their matching JSON-RPC result is decoded', async t => {
  const endpoint = await startEndpoint(definition('x').allowed_tools, (_n, _args, res, id) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '{"ok":true}' }] } })}\n\n`);
  }); t.after(() => endpoint.close());
  let saved = false;
  const client = new RpcClient(ExecutorDefinition.parse(definition(endpoint.endpoint)), 'synthetic-secret', 'synthetic-job', async bytes => { if (new TextDecoder().decode(bytes).startsWith('event:')) saved = true; return 'src:' + 'a'.repeat(64); });
  await client.connect(); assert.equal(((await client.call('precheck', {})).value as any).ok, true); assert.equal(saved, true);
});

test('JSON-escaped and nested escaped key echoes are redacted before source storage', async t => {
  const endpoint = await startEndpoint(definition('x').allowed_tools, (_name, _args, res, id) => {
    const encoded = [...'synthetic-secret'].map(c => String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    const body = JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: { debug: 'synthetic-secret', nested: JSON.stringify({ debug: 'synthetic-secret' }) }, content: [] } }).replaceAll('synthetic-secret', encoded);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(body);
  }); t.after(() => endpoint.close());
  const client = new RpcClient(ExecutorDefinition.parse(definition(endpoint.endpoint)), 'synthetic-secret', 'synthetic-job', async bytes => { assert.ok(!new TextDecoder().decode(bytes).includes('synthetic-secret')); return 'src:' + 'a'.repeat(64); });
  await client.connect(); const result = await client.call('precheck', {});
  assert.equal((result.value as any).debug, '[已隐藏]'); assert.equal(JSON.parse(String((result.value as any).nested)).debug, '[已隐藏]');
});

test('a storage refusal takes precedence over interpreting an invalid remote reply', async t => {
  const endpoint = await startEndpoint(definition('x').allowed_tools, (_name, _args, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('synthetic invalid JSON'); }); t.after(() => endpoint.close());
  let saved = false;
  const client = new RpcClient(ExecutorDefinition.parse(definition(endpoint.endpoint)), 'synthetic-secret', 'synthetic-job', async (_bytes, _status, operation) => {
    if (operation === 'precheck') { saved = true; throw new Error('synthetic storage refusal'); }
    return 'src:' + 'a'.repeat(64);
  });
  await client.connect(); await assert.rejects(client.call('precheck', {}), /原件未能保存/); assert.equal(saved, true);
});

test('a complete matching SSE response is accepted even when the server keeps its stream open', async t => {
  const endpoint = await startEndpoint(definition('x').allowed_tools, (_name, _args, res, id) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: { ok: true }, content: [] } })}\n\n`);
  }); t.after(() => endpoint.close());
  const cfg = definition(endpoint.endpoint); cfg.calls.precheck = { ...cfg.calls.precheck, timeout_ms: 50 } as any;
  let boundary = false;
  const client = new RpcClient(ExecutorDefinition.parse(cfg), 'synthetic-secret', 'synthetic-job', async (_bytes, _status, role, _complete, metadata) => { if (role === 'precheck') boundary = metadata?.stream_cut_at_response === true; return 'src:' + 'a'.repeat(64); });
  await client.connect(); assert.equal(((await client.call('precheck', {})).value as any).ok, true); assert.equal(boundary, true);
});

test('the represented actor header comes only from deployment data and invalid actors never reach the endpoint', async t => {
  const server = await startEndpoint(definition('x').allowed_tools, () => ({ ok: true })); t.after(() => server.close());
  const d = ExecutorDefinition.parse({ ...definition(server.endpoint), actor: { header: 'X-Circle-Hub-Actor', pattern: '^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$', max_length: 128 } });
  const client = new RpcClient(d, 'synthetic-secret', 'synthetic-user/synthetic-job', async () => 'src:' + 'a'.repeat(64));
  await client.connect();
  assert.ok(server.calls.every(c => c.headers['x-circle-hub-actor'] === 'synthetic-user/synthetic-job' && c.headers['x-circle-hub-operator'] === undefined));
  const count = server.calls.length;
  await assert.rejects(async () => new RpcClient(d, 'synthetic-secret', 'invalid actor', async () => 'src:' + 'a'.repeat(64)).connect());
  assert.equal(server.calls.length, count);
});

test('forbidden capabilities stop at tools listing before any lifecycle tool call',async t=>{
  const server=await startEndpoint([...definition('x').allowed_tools,'synthetic_admin_reset'],()=>({ok:true}));t.after(()=>server.close());
  const d=ExecutorDefinition.parse({...definition(server.endpoint),refused_tools:['synthetic_admin_reset']});
  const client=new RpcClient(d,'synthetic-secret','synthetic-job',async()=> 'src:'+'a'.repeat(64));
  await assert.rejects(client.connect(),/密钥权限超出运行权限/);
  assert.equal(server.calls.filter(c=>c.method==='tools/call').length,0);
});

test('retry classification is declared from the generated vocabulary without enabling retransmission',()=>{
  assert.equal(ExecutorDefinition.parse({...definition('http://127.0.0.1:1/'),retry_safety:'dedup_window'}).retry_safety,'dedup_window');
  assert.equal(ExecutorDefinition.safeParse({...definition('http://127.0.0.1:1/'),retry_safety:'invented'}).success,false);
});

test('conformance payloads must be distinct nonempty bytes rather than different spellings of one base64 value',()=>{
  const base=definition('http://127.0.0.1:1/');
  for(const payloads of [['=','=='],['YQ==','YR=='],['YQ==','YQ==']])assert.equal(ExecutorDefinition.safeParse({...base,conformance:{expected_stage:'guard',payloads}}).success,false);
  assert.ok(ExecutorDefinition.safeParse({...base,conformance:{expected_stage:'guard',payloads:['YQ==','Yg==']}}).success);
});

test('published parameter names prevent silent legacy fallback when request bindings use undeclared fields',async t=>{
  const server=await startEndpoint(definition('x').allowed_tools,()=>({ok:true}),undefined,{send_blob:{type:'object',properties:{blob:{},request:{},until:{},ticket:{},ids:{},digest:{}},required:['blob','request','until'],additionalProperties:false}});t.after(()=>server.close());
  const base=definition(server.endpoint);base.calls.submit.arguments={...base.calls.submit.arguments,legacy_request:base.calls.submit.arguments.request} as any;
  delete (base.calls.submit.arguments as any).request;
  const client=new RpcClient(ExecutorDefinition.parse(base),'synthetic-secret','synthetic-job',async()=> 'src:'+'a'.repeat(64));
  await client.connect();
  await assert.rejects(client.call('submit',{request_id:'id:1',not_after:'2026-10-23T00:00:00Z',payload_base64:'YQ==',sha256:'a'.repeat(64),items:[],lease_id:'lease'}),/参数名/);
  assert.equal(server.calls.filter(c=>c.method==='tools/call').length,0);
});

test('R21 representation cannot occupy any reserved MCP header namespace',()=>{
  assert.equal(ExecutorDefinition.safeParse({...definition('http://127.0.0.1:1/'),actor:{header:'Mcp-Future-Protocol-Field',pattern:'^.*$',max_length:128}}).success,false);
});
