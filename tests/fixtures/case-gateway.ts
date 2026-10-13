import {createServer} from 'node:http';
import type {TestContext} from 'node:test';

export async function caseGateway(t:TestContext){
  const state={staticSecret:'',staticAccepted:false,refuseLease:false,unavailable:false,lost:false,hold:false,dropSubmit:false,wrongSha:false,failCase:false,hostLog:'',actualBuild:'Rel_PHOTON_10_5_0_101',missingBuild:false,command:'service create port 443',sha:'',taskId:'cex_synthetic_301',calls:[] as string[],identityServer:'',clientId:'',clientSecret:'',ruleBuild:'',ruleSha:'',verified:[] as any[]};
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/mcp'){res.writeHead(405);res.end();return;}
    let rpc:any;try{let input='';for await(const bytes of req)input+=bytes;rpc=JSON.parse(input);}catch{res.writeHead(400);res.end();return;}
    const name=rpc.params?.name;state.calls.push(name??rpc.method);
    if(state.unavailable){res.writeHead(503);res.end('{"error":"cannot verify token: server unreachable"}');return;}
    if(state.staticSecret){if(req.headers.authorization!==`Bearer ${state.staticSecret}`){res.writeHead(401);res.end();return;}state.staticAccepted=true;}
    if(state.identityServer){try{
      const auth=`Basic ${Buffer.from(`${encodeURIComponent(state.clientId)}:${encodeURIComponent(state.clientSecret)}`).toString('base64')}`,token=(req.headers.authorization??'').slice(7),checked=await fetch(`${state.identityServer}/v1/introspect`,{method:'POST',headers:{authorization:auth,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})}),info=await checked.json() as any;
      if(!checked.ok){res.writeHead(503);res.end();return;}if(!info.active||!info.scope.split(' ').includes('jumphost:run')){res.writeHead(401);res.end();return;}state.verified.push({...info,tokenDigest:(await import('node:crypto')).createHash('sha256').update(token).digest('hex')});
      if(name==='env_prepare'){
        const issued=await fetch(`${state.identityServer}/token`,{method:'POST',headers:{authorization:auth,'content-type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials&scope=bundles%3Aread'}),session=await issued.json() as any,headers={authorization:`Bearer ${session.access_token}`},bundle=await fetch(`${state.identityServer}/v1/builds/${encodeURIComponent(state.ruleBuild)}/bundle`,{headers}),manifest=await bundle.json() as any,file=manifest.entries?.find((entry:any)=>entry.path==='projections/domain_grammar.json');
        if(!issued.ok||!bundle.ok||!file){res.writeHead(503);res.end();return;}const blob=await fetch(`${state.identityServer}/v1/blobs/${file.sha256}`,{headers}),bytes=Buffer.from(await blob.arrayBuffer());state.ruleSha=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');if(!blob.ok||state.ruleSha!==file.sha256){res.writeHead(503);res.end();return;}
      }
    }catch{res.writeHead(503);res.end();return;}}
    let result:any={ok:true};
    if(name==='lease_status')result={ok:true,lease:null};
    if(name==='bed_topology')result={ok:true,topology:{devices:[{name:'routera',interfaces:[{address:'192.0.2.31'}]},{name:'node-a'},{name:'node-b'}]}};
    if(name==='lease_acquire')result=state.refuseLease?{ok:false,error:'lease unavailable'}:{ok:true,lease_id:'synthetic-lease',token:1,expires_in_s:1800};
    if(name==='env_prepare'){const wanted=rpc.params.arguments.device_build,match=!state.missingBuild&&state.actualBuild===wanted;result={ok:true,ready:match,build_checked:true,device_count:2,checks:[{check:'device_build',ok:match,detail:state.missingBuild?'build not found in output':`device reports ${state.actualBuild}, gateway bundle is ${wanted}`} ]};}
    if(name==='case_submit'){
      const {createHash}=await import('node:crypto');state.sha=createHash('sha256').update(Buffer.from(rpc.params.arguments.xlsx_b64,'base64')).digest('hex');
      if(state.dropSubmit){req.socket.destroy();return;}
      result={ok:true,task_id:state.taskId,sha256:state.wrongSha?'0'.repeat(64):state.sha,bytes:1,case_ids:['301'],submit_autoid:'301',module:'synthetic'};
    }
    if(name==='case_status')result={ok:true,task_id:state.taskId,state:state.lost?'lost':state.hold?'running':'done',rc:0};
    if(name==='case_results')result={ok:true,task_id:state.taskId,channel:state.lost?'runner_lost':'ready',rc:state.lost?null:0,xlsx_sha256:state.sha,cases:state.lost?[]:[{case_id:'301',result:state.failCase?'fail':'pass',log_stale:false,log:`node-a - sends command in config: ${state.command}\nhealthy\nLAB#\n${state.hostLog}#### ${state.failCase?'Fail':'Success'} Num 1: ${state.failCase?'fail':'successed'} to find healthy in:\n${state.command}\nhealthy\nLAB#\n#### Success Num 2: fail to find panic in:\n${state.command}\nhealthy\nLAB#\n`,sessions:{}}],ignored_rows:0};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]}}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {origin:`http://127.0.0.1:${(server.address() as any).port}`,state};
}
