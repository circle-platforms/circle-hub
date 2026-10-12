import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate} from 'node:crypto';
import {sha256} from '../../packages/contracts/src/index.ts';
import {PrivateVault} from '../../packages/assets/src/vault.ts';
import {RotatingToken} from '../../packages/assets/src/rotating-token.ts';
import {McpGateway} from '../../packages/connectors/src/case-gateway.ts';

test('Gateway session: concurrent refresh has one writer, persists the new refresh token across instances and never replays an uncertain rotation',async t=>{
  const directory=await mkdtemp(`${tmpdir()}/circle-server-token-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  let refreshes=0,unavailable=false,drop=false;const server=createServer(async(req,res)=>{
    let body='';for await(const data of req)body+=data;assert.equal(new URLSearchParams(body).get('refresh_token'),refreshes===0?'refresh-one':'refresh-two');refreshes++;
    if(drop){req.socket.destroy();return;}if(unavailable){res.writeHead(503);res.end('{}');return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'access-two',refresh_token:'refresh-two',expires_in:900,scope:'jumphost:run'}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const issuer=`http://127.0.0.1:${(server.address() as any).port}`,vault=new PrivateVault(directory),binding='synthetic-owner',key=await vault.put(JSON.stringify({access_token:'access-one',refresh_token:'refresh-one',expires_at:1,scope:'jumphost:run'}),binding);
  const make=()=>new RotatingToken(vault,{key,binding},{issuer});const tokens=await Promise.all([make().access(),make().access(),make().access()]);assert.deepEqual(tokens,['access-two','access-two','access-two']);assert.equal(refreshes,1);
  assert.equal(await make().access(),'access-two');assert.equal(refreshes,1);const stored=JSON.parse(await vault.get(key,binding));assert.equal(stored.refresh_token,'refresh-two');assert.ok(!(await readFile(vault.path(key),'utf8')).includes('refresh-two'));
  unavailable=true;await vault.replace(key,JSON.stringify({...stored,expires_at:1}),binding);await assert.rejects(make().access(),(error:any)=>error.code==='SOURCE_UNREACHABLE');assert.equal(JSON.parse(await vault.get(key,binding)).refresh_token,'refresh-two');
  unavailable=false;drop=true;await assert.rejects(make().access(),(error:any)=>error.code==='SOURCE_UNREACHABLE');const count=refreshes;await assert.rejects(make().access(),(error:any)=>error.code==='SOURCE_LOGIN_EXPIRED'&&error.details.reason==='refresh_outcome_unknown');assert.equal(refreshes,count);
});

test('Gateway transport: 503 introspection outage is unavailable, 401 is login expiry, and no redirects receive tokens',async t=>{
  let status=503,received=0;const server=createServer((req,res)=>{received++;assert.equal(req.headers.authorization,'Bearer synthetic-access');res.writeHead(status,status===302?{location:'http://hidden.example.test/'}:{'content-type':'application/json'});res.end(JSON.stringify({error:'cannot verify token: server unreachable'}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const gateway=new McpGateway({endpoint:`http://127.0.0.1:${(server.address() as any).port}/mcp`},async()=> 'synthetic-access');
  for(const [value,code] of [[503,'SOURCE_UNREACHABLE'],[401,'SOURCE_LOGIN_EXPIRED'],[302,'SOURCE_UNREACHABLE']] as const){status=value;await assert.rejects(gateway.call('lease_status',{}),(error:any)=>error.code===code&&!error.message.includes('hidden')&&!error.message.includes('synthetic-access'));}assert.equal(received,3);
});

test('Gateway trust: pinned local CA is checked on every call and changed trust stops before sending a token',async t=>{
  const directory=await mkdtemp(`${tmpdir()}/circle-server-ca-`);t.after(()=>rm(directory,{recursive:true,force:true}));
  const run=promisify(execFile);await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${directory}/key.pem`,'-out',`${directory}/ca.pem`,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{timeout:10000});
  const cert=await readFile(`${directory}/ca.pem`),key=await readFile(`${directory}/key.pem`);let calls=0;
  const server=createTlsServer({cert,key},async(req,res)=>{calls++;let text='';for await(const chunk of req)text+=chunk;const rpc=JSON.parse(text);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:{ok:true,busy:false}}}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const profile={endpoint:`https://localhost:${(server.address() as any).port}/mcp`,caFile:`${directory}/ca.pem`,caSha256:sha256(new X509Certificate(cert).raw)},gateway=new McpGateway(profile,async()=> 'synthetic-access');assert.equal((await gateway.call('lease_status',{})).busy,false);assert.equal(calls,1);
  await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',`${directory}/other-key.pem`,'-out',`${directory}/other-ca.pem`,'-days','1','-subj','/CN=OtherSynthetic']);await writeFile(profile.caFile,await readFile(`${directory}/other-ca.pem`));await assert.rejects(gateway.call('lease_status',{}),(error:any)=>error.code==='TARGET_IDENTITY_MISMATCH');assert.equal(calls,1);
});
