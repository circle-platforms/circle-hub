import {createServer} from 'node:http';
import type {TestContext} from 'node:test';

export async function caseGateway(t:TestContext){
  const state={unavailable:false,lost:false,hold:false,dropSubmit:false,wrongSha:false,failCase:false,command:'service create port 443',sha:'',taskId:'cex_synthetic_301',calls:[] as string[]};
  const server=createServer(async(req,res)=>{
    let input='';for await(const bytes of req)input+=bytes;const rpc=JSON.parse(input),name=rpc.params?.name;state.calls.push(name??rpc.method);
    if(state.unavailable){res.writeHead(503);res.end('{"error":"cannot verify token: server unreachable"}');return;}
    let result:any={ok:true};
    if(name==='lease_acquire')result={ok:true,lease_id:'synthetic-lease',token:1,expires_in_s:1800};
    if(name==='env_prepare')result={ok:true,ready:true,build_checked:true,device_count:2,checks:[{check:'device_build',ok:true}]};
    if(name==='case_submit'){
      const {createHash}=await import('node:crypto');state.sha=createHash('sha256').update(Buffer.from(rpc.params.arguments.xlsx_b64,'base64')).digest('hex');
      if(state.dropSubmit){req.socket.destroy();return;}
      result={ok:true,task_id:state.taskId,sha256:state.wrongSha?'0'.repeat(64):state.sha,bytes:1,case_ids:['301'],submit_autoid:'301',module:'synthetic'};
    }
    if(name==='case_status')result={ok:true,task_id:state.taskId,state:state.lost?'lost':state.hold?'running':'done',rc:0};
    if(name==='case_results')result={ok:true,task_id:state.taskId,channel:state.lost?'runner_lost':'ready',rc:state.lost?null:0,xlsx_sha256:state.sha,cases:state.lost?[]:[{case_id:'301',result:state.failCase?'fail':'pass',log_stale:false,log:`node-a - sends command in config: ${state.command}\nhealthy\nLAB#\n#### ${state.failCase?'Fail':'Success'} Num 1: ${state.failCase?'fail':'successed'} to find healthy in:\n${state.command}\nhealthy\nLAB#\n#### Success Num 2: fail to find panic in:\n${state.command}\nhealthy\nLAB#\n`,sessions:{}}],ignored_rows:0};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]}}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {origin:`http://127.0.0.1:${(server.address() as any).port}`,state};
}
