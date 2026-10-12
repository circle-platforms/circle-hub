import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import type {TestContext} from 'node:test';

export async function scriptModel(t:TestContext){
  const requests:any[]=[],key=randomBytes(20).toString('hex');
  const state:{hold:boolean;sequence:{name:string;args:Record<string,unknown>}[]}={hold:false,sequence:[
    {name:'skill',args:{name:'rpc-fixture'}},
    {name:'srv_docs_search',args:{query:'service'}},
    {name:'write_file',args:{file_path:'result.json',content:'{"synthetic":true,"source":"scripted-rpc"}'}},
  ]};
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'scripted-fixture'}]}));return;}
    if(req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
    if(state.hold){res.write(': waiting for cancellation\n\n');return;}
    const completed=body.messages.filter((m:any)=>m.role==='tool').length,step=state.sequence[completed];
    const chunk=(delta:any,finish_reason:string|null)=>({id:`synthetic-${completed}`,object:'chat.completion.chunk',created:1,model:'scripted-fixture',choices:[{index:0,delta,finish_reason}]});
    if(step){res.write(`data: ${JSON.stringify(chunk({role:'assistant',tool_calls:[{index:0,id:`call-${completed}`,type:'function',function:{name:step.name,arguments:JSON.stringify(step.args)}}]},null))}\n\n`);res.write(`data: ${JSON.stringify(chunk({},'tool_calls'))}\n\n`);}
    else{res.write(`data: ${JSON.stringify(chunk({role:'assistant',content:'Synthetic skill completed.'},null))}\n\n`);res.write(`data: ${JSON.stringify(chunk({},'stop'))}\n\n`);}
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {url:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,key,requests,state};
}
