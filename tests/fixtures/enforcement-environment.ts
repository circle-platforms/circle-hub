import {writeFile} from 'node:fs/promises';
import {setup} from '../acceptance/harness.ts';
import {readonlySources} from './readonly-sources.ts';
import {caseGateway} from './case-gateway.ts';
import {executionWorkbook} from './execution-workbook.ts';
export async function enforcementEnvironment(t:any,executionIsChange=false,autoHooks=true){
  const source=await readonlySources(t),gateway=await caseGateway(t),h=await setup(t);source.state.expandedCommands=true;h.autoHooks=autoHooks;
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{source:{origin:source.origin,index:'/builds/'}}}));h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;
  await writeFile(`${h.scratch}/gateway.json`,JSON.stringify({profiles:{lab:{endpoint:`${gateway.origin}/mcp`,issuer:gateway.origin,pollMs:25}}}));h.env.CIRCLE_HUB_EXECUTION_GATEWAYS=`${h.scratch}/gateway.json`;await h.stop();await h.startServer();
  const activate=async(asset:any)=>{await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');return h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});};
  const build=await activate(await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic command authority',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'build-site',runtimeProfileRef:'source'},readers:['*']}));
  const definition={scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic enforced resource',version:'1.0.0',declaration:{reads:['test-bed'],writes:['device-config'],allowedTestHosts:['clientc','clientd','cliente','routera','routerb','server213','server231','server232'],credentials:[],...(executionIsChange?{executionIsChange:true}:{})},configuration:{packageId:'case-gateway',productLineId:'apv',runtimeProfileRef:'lab'},readers:['*']};
  const draft=await h.request('/v1/assets',definition),credential=await h.request(`/v1/assets/${draft.assetId}/credentials`,{version:'1.0.0',value:JSON.stringify({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+900,scope:'jumphost:run'})});
  const bed=await activate(await h.request('/v1/assets',{...definition,assetId:draft.assetId,version:'2.0.0',declaration:{...definition.declaration,credentials:[credential.assetId]}}));
  const payload=async(command='service create port 443',key=`enforcement-${Math.random()}`,options:any={})=>{const bytes=await executionWorkbook({command,...options}),original=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'case.xlsx',contentBase64:bytes.toString('base64')});return {scopeId:'scp_lab',capabilityPackId:'apv-case-execute',input:{methodAssetId:h.approvedMethodAssetId(),sourceRevisionId:original.sourceRevisionId,gatewayAssetId:bed.assetId,commandSourceAssetId:build.assetId,build:'Rel_PHOTON_10_5_0_101'},idempotencyKey:key};};
  const submit=async(command?:string,key?:string,options?:any)=>h.request('/v1/tasks/submit',await payload(command,key,options));
  return {h,source,gateway,build,bed,submit,payload};
}
