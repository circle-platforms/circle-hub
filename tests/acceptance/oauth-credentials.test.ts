import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {writeFile,readFile} from 'node:fs/promises';
import {setup} from './harness.ts';
import {PrivateVault} from '../../packages/assets/src/vault.ts';

async function environment(t:any){
  const requests:any[]=[],state={mode:'pending',tokenCalls:0};
  const issuer=createServer(async(req,res)=>{let text='';for await(const bytes of req)text+=bytes;const form=Object.fromEntries(new URLSearchParams(text));requests.push({path:req.url,form,authorization:req.headers.authorization});res.setHeader('content-type','application/json');
    if(req.url==='/manual.md'){res.setHeader('content-type','text/plain');res.end('Generic OAuth protected source');return;}
    if(req.url==='/device'){res.end(JSON.stringify({device_code:'synthetic-private-device-code',user_code:'SYNTH-CODE',verification_uri:`${origin}/activate`,expires_in:600,interval:5}));return;}
    if(req.url==='/oauth/token'){state.tokenCalls++;if(form.grant_type==='urn:ietf:params:oauth:grant-type:device_code'&&state.mode!=='approved'){res.writeHead(400);res.end(JSON.stringify({error:state.mode==='slow'?'slow_down':state.mode==='denied'?'access_denied':'authorization_pending'}));return;}
      res.end(JSON.stringify({access_token:`synthetic-access-${state.tokenCalls}`,token_type:'Bearer',expires_in:900,...(form.grant_type==='client_credentials'?{}:{refresh_token:`synthetic-refresh-${state.tokenCalls}`}),scope:'read run'}));return;}
    res.writeHead(404);res.end('{}');});await new Promise<void>(resolve=>issuer.listen(0,'127.0.0.1',resolve));t.after(()=>{issuer.closeAllConnections();issuer.close();});const origin=`http://127.0.0.1:${(issuer.address() as any).port}`;
  const h=await setup(t);await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"credentials.register\",\"credentials.use\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\",\"credentials.register\",\"credentials.use\"]'::jsonb WHERE principal_id='prn_bob'");
  await writeFile(`${h.scratch}/oauth.json`,JSON.stringify({profiles:{generic:{issuer:origin,tokenEndpoint:`${origin}/oauth/token`,deviceAuthorizationEndpoint:`${origin}/device`,clientId:'synthetic-client',clientAuthentication:'none',scope:'read run'},confidential:{issuer:origin,tokenEndpoint:`${origin}/oauth/token`,clientId:'synthetic-client',clientAuthentication:'client_secret_basic',scope:'read run'}}}),{mode:0o600});
  // The configured values are runtime only; the HTTP issuer is a loopback stub.
  h.env.CIRCLE_HUB_OAUTH_PROFILES=`${h.scratch}/oauth.json`;await h.stop();await h.startServer();
  const parent=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Generic OAuth caller',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',alias:'oauth_user_docs',oauthProfileRef:'generic'},readers:['prn_alice','prn_bob']});
  const service=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Generic client credentials caller',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',alias:'oauth_service_docs',oauthProfileRef:'confidential'},readers:['prn_alice','prn_bob']});
  const client=await h.request(`/v1/assets/${service.assetId}/credentials`,{version:'1.0.0',value:JSON.stringify({client_id:'synthetic-client',client_secret:'synthetic-private-client-secret'})});
  const body={connectorAssetId:parent.assetId,connectorVersion:parent.version,profileRef:'generic',idempotencyKey:'generic-device-start'};
  return {h,origin,requests,state,parent,service,client,body};
}

test('OAuth: a generic device grant keeps codes tokens and client secrets private and survives restart with one credential reference',async t=>{
  const {h,requests,state,body}=await environment(t),flow=await h.request('/v1/credentials/oauth/device',body);assert.equal(flow.status,'pending');assert.equal(flow.userCode,'SYNTH-CODE');assert.ok(flow.verificationUri);assert.ok(!JSON.stringify(flow).includes('synthetic-private-device-code'));
  assert.equal((await h.request('/v1/credentials/oauth/device',body)).flowId,flow.flowId);assert.equal(requests.filter(req=>req.path==='/device').length,1);
  await h.db.query('UPDATE oauth_flows SET next_poll_at=clock_timestamp()-interval \'1 second\' WHERE flow_id=$1',[flow.flowId]);const pending=await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{});assert.equal(pending.status,'pending');const count=state.tokenCalls;await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{});assert.equal(state.tokenCalls,count);
  await h.stop();await h.startServer();state.mode='approved';await h.db.query('UPDATE oauth_flows SET next_poll_at=clock_timestamp()-interval \'1 second\' WHERE flow_id=$1',[flow.flowId]);const issued=await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{});assert.equal(issued.status,'authorized');assert.match(issued.credentialAssetId,/^ast_/);assert.ok(!JSON.stringify(issued).includes('synthetic-access'));
  assert.equal((await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{})).credentialAssetId,issued.credentialAssetId);
  const stored=await h.request(`/v1/assets/${issued.credentialAssetId}`);assert.ok(!JSON.stringify(stored).includes('synthetic-refresh'));assert.equal(stored.configuration.oauth.profileRef,'generic');
  const audit=(await h.db.query('SELECT detail FROM audit')).rows;assert.ok(!JSON.stringify(audit).includes('synthetic-private-device-code'));assert.ok(!JSON.stringify(audit).includes('synthetic-access'));
});

test('OAuth: polling honors slow_down expiry owner and connector version without issuing through another identity',async t=>{
  const {h,state,body}=await environment(t),flow=await h.request('/v1/credentials/oauth/device',{...body,idempotencyKey:'slow-device'});
  await h.reject(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{},'SOURCE_FORBIDDEN','bob');await h.db.query('UPDATE oauth_flows SET next_poll_at=clock_timestamp()-interval \'1 second\' WHERE flow_id=$1',[flow.flowId]);state.mode='slow';assert.equal((await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{})).intervalSeconds,10);
  await h.db.query('UPDATE oauth_flows SET expires_at=clock_timestamp()-interval \'1 second\' WHERE flow_id=$1',[flow.flowId]);assert.equal((await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{})).status,'expired');
});

test('OAuth: client_credentials uses an owned private client reference at a configured endpoint and exposes no token value',async t=>{
  const {h,requests,service,client}=await environment(t),body={connectorAssetId:service.assetId,connectorVersion:service.version,profileRef:'confidential',clientCredentialId:client.assetId,idempotencyKey:'generic-service-grant'};
  const issued=await h.request('/v1/credentials/oauth/client-credentials',body);assert.equal(issued.status,'authorized');assert.match(issued.credentialAssetId,/^ast_/);assert.ok(!JSON.stringify(issued).includes('synthetic-access'));assert.equal((await h.request('/v1/credentials/oauth/client-credentials',body)).credentialAssetId,issued.credentialAssetId);
  assert.equal(requests.filter(req=>req.form.grant_type==='client_credentials').length,1);assert.ok(requests.find(req=>req.form.grant_type==='client_credentials').authorization.startsWith('Basic '));
  await h.reject('/v1/credentials/oauth/client-credentials',body,'FORBIDDEN_ACTION','bob');
  const row=(await h.db.query('SELECT a.*,v.*,p.secret_key FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version JOIN personal_credentials p ON p.asset_id=a.asset_id AND p.version=v.version WHERE a.asset_id=$1',[issued.credentialAssetId])).rows[0];const vault=new PrivateVault(`${h.scratch}/objects/private-credentials`),binding=JSON.stringify([row.tenant_id,row.scope_id,row.owner_principal_id,row.asset_id,row.version]);const value=JSON.parse(await vault.get(row.secret_key,binding));assert.ok(value.access_token);assert.equal(value.refresh_token,undefined);assert.ok(!(await readFile(vault.path(row.secret_key),'utf8')).includes(value.access_token));
});

test('OAuth: arbitrary endpoints and remote cleartext issuers are refused before credentials are sent',async t=>{
  const {h,requests,body}=await environment(t);await h.reject('/v1/credentials/oauth/device',{...body,tokenEndpoint:'http://unsafe.example.test/token'},'INVALID_PAYLOAD');assert.equal(requests.length,0);
  const profiles={profiles:{generic:{issuer:'http://issuer.example.test',tokenEndpoint:'http://issuer.example.test/token',deviceAuthorizationEndpoint:'http://issuer.example.test/device',clientId:'synthetic-client',clientAuthentication:'none',scope:'read'}}};await writeFile(`${h.scratch}/oauth.json`,JSON.stringify(profiles));await h.reject('/v1/credentials/oauth/device',{...body,idempotencyKey:'unsafe-issuer'},'INVALID_PAYLOAD');assert.equal(requests.length,0);
});

test('OAuth: a receipt resumes after a server restart without issuing again or creating another credential asset',async t=>{
  const {h,body,state}=await environment(t),flow=await h.request('/v1/credentials/oauth/device',{...body,idempotencyKey:'resume-device-receipt'});state.mode='approved';await h.db.query('UPDATE oauth_flows SET next_poll_at=clock_timestamp()-interval \'1 second\' WHERE flow_id=$1',[flow.flowId]);const issued=await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{}),calls=state.tokenCalls;
  await h.db.query("UPDATE oauth_flows SET state='exchanging',credential_asset_id=NULL WHERE flow_id=$1",[flow.flowId]);await h.stop();await h.startServer();const recovered=await h.request(`/v1/credentials/oauth/device/${flow.flowId}/poll`,{});assert.equal(recovered.credentialAssetId,issued.credentialAssetId);assert.equal(state.tokenCalls,calls);assert.equal((await h.db.query("SELECT 1 FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version WHERE v.configuration ? 'oauth'")).rowCount,1);
});

test('OAuth: a configured client grant supplies a connector bearer header and renews its encrypted reference before use',async t=>{
  const {h,origin,requests,state,service,client}=await environment(t),issued=await h.request('/v1/credentials/oauth/client-credentials',{connectorAssetId:service.assetId,connectorVersion:service.version,profileRef:'confidential',clientCredentialId:client.assetId,idempotencyKey:'connector-client-grant'});
  await writeFile(`${h.scratch}/sources.json`,JSON.stringify({profiles:{reader:{origin,authorizationScheme:'bearer'}}}));h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/sources.json`;await h.stop();await h.startServer();
  const active=await h.request('/v1/assets',{assetId:service.assetId,scopeId:'scp_lab',kind:'connector-instance',name:service.name,version:'2.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[issued.credentialAssetId]},configuration:{...service.configuration,runtimeProfileRef:'reader'},readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${active.assetId}/lifecycle`,{version:active.version,sha256:active.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${active.assetId}/lifecycle`,{version:active.version,sha256:active.sha256,state:'running'});
  const row=(await h.db.query('SELECT a.*,v.*,p.secret_key FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version JOIN personal_credentials p ON p.asset_id=a.asset_id AND p.version=v.version WHERE a.asset_id=$1',[issued.credentialAssetId])).rows[0],vault=new PrivateVault(`${h.scratch}/objects/private-credentials`),binding=JSON.stringify([row.tenant_id,row.scope_id,row.owner_principal_id,row.asset_id,row.version]),stored=JSON.parse(await vault.get(row.secret_key,binding));await vault.replace(row.secret_key,JSON.stringify({...stored,expires_at:1}),binding);
  const before=state.tokenCalls;await h.startWorker();const result=await h.request('/v1/tools/oauth_service_docs.get/call',{args:{file:'/manual.md'},idempotencyKey:'materialized-client-token'});assert.equal(Buffer.from(result.result.contentBase64,'base64').toString(),'Generic OAuth protected source');assert.equal(state.tokenCalls,before+1);assert.equal(requests.find(request=>request.path==='/manual.md').authorization,`Bearer synthetic-access-${state.tokenCalls}`);assert.ok(!JSON.stringify(result).includes('synthetic-access'));
});
