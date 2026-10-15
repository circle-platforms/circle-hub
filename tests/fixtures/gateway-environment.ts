import {writeFile} from 'node:fs/promises';
import {setup} from '../acceptance/harness.ts';
import {caseGateway} from './case-gateway.ts';
export async function gatewayEnvironment(t:any){
  const gateway=await caseGateway(t),h=await setup(t);
  await writeFile(`${h.scratch}/gateway.json`,JSON.stringify({profiles:{lab:{endpoint:`${gateway.origin}/mcp`,issuer:gateway.origin,pollMs:25}}}));h.env.CIRCLE_HUB_EXECUTION_GATEWAYS=`${h.scratch}/gateway.json`;await h.stop();await h.startServer();
  const activate=async(asset:any)=>{await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');return h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});};
  const definition={scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic enforced resource',version:'1.0.0',declaration:{reads:['test-bed'],writes:['device-config'],allowedTestHosts:['clientc','clientd','cliente','routera','routerb','server213','server231','server232'],credentials:[],},configuration:{packageId:'case-gateway',productLineId:'apv',runtimeProfileRef:'lab'},readers:['*']};
  const draft=await h.request('/v1/assets',definition),credential=await h.request(`/v1/assets/${draft.assetId}/credentials`,{version:'1.0.0',value:JSON.stringify({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+900,scope:'jumphost:run'})});
  const bed=await activate(await h.request('/v1/assets',{...definition,assetId:draft.assetId,version:'2.0.0',declaration:{...definition.declaration,credentials:[credential.assetId]}}));
  return {h,gateway,bed};
}
