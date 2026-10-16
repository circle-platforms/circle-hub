#!/usr/bin/env node
import '../../../packages/contracts/src/hub-environment.ts';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {ADMIN_ROUTES,ApiError,ScopeId} from '../../../packages/contracts/src/index.ts';
import {moduleCommand} from '../../../packages/modules/src/cli.ts';

const args=process.argv.slice(2);
const USAGE=`Usage: circle-hub [help]
  circle-hub admin help
  circle-hub admin tasks
  circle-hub admin approvals
  circle-hub admin audit [--format json|csv] [--timezone <IANA>] [--action <name>] [--principal <prn_...>] [--since <iso>] [--until <iso>]
  circle-hub admin workers drain <workerId>
  circle-hub admin connectors enable|disable <connectorId>
  circle-hub admin events --tail [--once]
  circle-hub admin restart --graceful
  circle-hub modules check|install
`;
async function main():Promise<void>{
  const requested=args[0];
  if(!requested||requested==='help'||requested==='--help'||requested==='-h'||requested==='admin'&&['help','--help','-h'].includes(args[1]??'')){console.log(USAGE);return;}
  const mode=args.shift();if(mode==='modules'){await moduleCommand(args);return;}
  if(mode!=='admin')throw new ApiError('INVALID_PAYLOAD',USAGE.trim());
  const target=new URL(process.env.CIRCLE_HUB_URL??'http://127.0.0.1:8080');
  if(!['http:','https:'].includes(target.protocol)||target.hostname!=='127.0.0.1'||target.username||target.password)throw new ApiError('INVALID_PAYLOAD','Admin requires HTTP or HTTPS on the authorized 127.0.0.1 loopback server without embedded credentials');
  let token=process.env.CIRCLE_HUB_TOKEN;
  if(!token&&process.env.CIRCLE_HUB_TOKEN_FILE)token=(await readFile(process.env.CIRCLE_HUB_TOKEN_FILE,'utf8')).trim();
  if(!token)throw new ApiError('UNAUTHENTICATED','Set CIRCLE_HUB_TOKEN or CIRCLE_HUB_TOKEN_FILE');
  const request=async(path:string,body?:unknown)=>{
    const response=await fetch(new URL(path,target),{method:body===undefined?'GET':'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const envelope=await response.json() as any;if(!response.ok)throw new ApiError(envelope.error.code,envelope.error.message);return envelope.data;
  };
  const output=(value:unknown)=>{console.log(JSON.stringify(value));},command=args.shift();
  if(command==='tasks'||command==='approvals'){if(args.length)throw new ApiError('INVALID_PAYLOAD','Unexpected arguments');output(await request(ADMIN_ROUTES[command]));return;}
  if(command==='audit'){
    if(!args.length){output(await request(ADMIN_ROUTES.audit));return;}
    const params=new URLSearchParams();let format='json';
    while(args.length){const flag=args.shift(),value=args.shift();if(!flag?.startsWith('--')||!value||value.startsWith('--'))throw new ApiError('INVALID_PAYLOAD','Unexpected arguments');
      if(flag==='--format'&&(value==='json'||value==='csv')){format=value;params.set('format',value);}
      else if(flag==='--timezone')params.set('timezone',value);
      else if(flag==='--action')params.set('action',value);
      else if(flag==='--principal')params.set('principalId',value);
      else if(flag==='--since')params.set('since',value);
      else if(flag==='--until')params.set('until',value);
      else throw new ApiError('INVALID_PAYLOAD','Unexpected arguments');
    }
    const path=`/v1/admin/audit/export?${params.toString()}`;
    if(format==='csv'){const response=await fetch(new URL(path,target),{redirect:'error',headers:{authorization:`Bearer ${token}`}});const text=await response.text();if(!response.ok){const envelope=JSON.parse(text);throw new ApiError(envelope.error.code,envelope.error.message);}process.stdout.write(text);return;}
    output(await request(path));return;
  }
  if(command==='workers'&&args.shift()==='drain'){
    const id=args.shift();if(!id||args.length)throw new ApiError('INVALID_PAYLOAD','Usage: workers drain <workerId>');
    let drained=await request(`${ADMIN_ROUTES.workers}/${encodeURIComponent(id)}/drain`,{});const until=Date.now()+120_000;
    while(drained.inFlight&&Date.now()<until){await delay(100);drained=await request(`${ADMIN_ROUTES.workers}/${encodeURIComponent(id)}/drain`,{});}if(drained.inFlight)throw new ApiError('RESOURCE_BUSY','Worker still has active operations');output(drained);return;
  }
  if(command==='connectors'){
    const action=args.shift(),id=args.shift();if(!['enable','disable'].includes(action??'')||!id||args.length)throw new ApiError('INVALID_PAYLOAD','Usage: connectors enable|disable <connectorId>');
    const scopeId=ScopeId.parse(process.env.CIRCLE_HUB_SCOPE??'scp_lab');output(await request(`${ADMIN_ROUTES.connectors}/${encodeURIComponent(id)}`,{scopeId,enabled:action==='enable'}));return;
  }
  if(command==='events'){
    if(!args.includes('--tail')||args.some(arg=>!['--tail','--once'].includes(arg)))throw new ApiError('INVALID_PAYLOAD','Usage: events --tail [--once]');
    let after=0,stopped=false;process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
    do{const page=await request(`${ADMIN_ROUTES.events}?after=${after}&waitMs=${args.includes('--once')?0:1000}`);after=page.after;output(page);}while(!stopped&&!args.includes('--once'));return;
  }
  if(command==='restart'&&args.length===1&&args[0]==='--graceful'){
    const before=await request('/v1/status'),accepted=await request(ADMIN_ROUTES.restart,{graceful:true});const until=Date.now()+20_000;
    while(Date.now()<until){await delay(100);try{const status=await request('/v1/status');if(status.bootId!==before.bootId){output({restarted:true,previousBootId:before.bootId,bootId:status.bootId,processId:status.processId,workersRestartRequested:accepted.workersRestartRequested===true});return;}}catch(error){if(error instanceof ApiError)throw error;}}
    throw new ApiError('INTERNAL_ERROR','Graceful restart did not produce a new server process');
  }
  throw new ApiError('INVALID_PAYLOAD','Unsupported admin command');
}
try{await main();}catch(error){const failure=error instanceof ApiError?error:new ApiError('INTERNAL_ERROR','Admin command failed');console.error(JSON.stringify({code:failure.code,message:failure.message}));process.exitCode=1;}
