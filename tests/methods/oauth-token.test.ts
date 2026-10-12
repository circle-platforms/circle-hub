import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {PrivateVault} from '../../packages/assets/src/vault.ts';
import {OAuthToken} from '../../packages/assets/src/oauth-token.ts';

test('OAuth tokens: standard client_credentials renews without a refresh token and one writer persists the latest receipt',async t=>{
  const directory=await mkdtemp(`${tmpdir()}/oauth-token-`);t.after(()=>rm(directory,{recursive:true,force:true}));const vault=new PrivateVault(directory),binding='synthetic-owned-client',key=await vault.put(JSON.stringify({access_token:'old-synthetic-access',expires_at:1,scope:'read'}),binding);let calls=0;
  const server=createServer(async(req,res)=>{let text='';for await(const data of req)text+=data;assert.equal(new URLSearchParams(text).get('grant_type'),'client_credentials');assert.equal(req.headers.authorization,`Basic ${Buffer.from('synthetic-client:synthetic-secret').toString('base64')}`);calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'new-synthetic-access',token_type:'Bearer',expires_in:900}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`,profile={issuer:origin,tokenEndpoint:`${origin}/custom/access`,clientId:'synthetic-client',clientAuthentication:'client_secret_basic' as const,scope:'read',timeoutMs:5000};const make=()=>new OAuthToken(vault,{key,binding},profile,'client_credentials','synthetic-secret');assert.deepEqual(await Promise.all([make().access(),make().access(),make().access()]),['new-synthetic-access','new-synthetic-access','new-synthetic-access']);assert.equal(calls,1);assert.equal(await make().access(),'new-synthetic-access');assert.equal(JSON.parse(await vault.get(key,binding)).refresh_token,undefined);
});

test('OAuth tokens: optional standard refresh receipts retain a nonrotating token and uncertain refresh is never replayed',async t=>{
  const directory=await mkdtemp(`${tmpdir()}/oauth-token-`);t.after(()=>rm(directory,{recursive:true,force:true}));const vault=new PrivateVault(directory),binding='synthetic-person',key=await vault.put(JSON.stringify({access_token:'old-access',refresh_token:'nonrotating-refresh',expires_at:1,scope:'read'}),binding);let calls=0,drop=false;
  const server=createServer(async(req,res)=>{let text='';for await(const data of req)text+=data;assert.equal(new URLSearchParams(text).get('refresh_token'),'nonrotating-refresh');calls++;if(drop){req.socket.destroy();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'new-access',token_type:'Bearer',expires_in:900}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});const origin=`http://127.0.0.1:${(server.address() as any).port}`,profile={issuer:origin,tokenEndpoint:`${origin}/oauth/token`,clientId:'public-client',clientAuthentication:'none' as const,scope:'read',timeoutMs:5000},make=()=>new OAuthToken(vault,{key,binding},profile,'device_authorization');assert.equal(await make().access(),'new-access');assert.equal(JSON.parse(await vault.get(key,binding)).refresh_token,'nonrotating-refresh');
  drop=true;await assert.rejects(make().access(true),(error:any)=>error.code==='SOURCE_UNREACHABLE');const count=calls;await assert.rejects(make().access(),(error:any)=>error.code==='SOURCE_LOGIN_EXPIRED'&&error.details.reason==='refresh_outcome_unknown');assert.equal(calls,count);
});
