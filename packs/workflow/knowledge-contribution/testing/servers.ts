// Scripted loopback fixtures only. No live account, content, or model is used.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GetNodesOutput } from '../../../../contracts/src/tools.ts';
import { ScriptedJev, type JevRequest } from '../../../../hub/jev/api.ts';
export const MODEL = 'jev-scripted-10.6.0';
export const JEV_KEY = ["FictJe","V_K8rZ","9yX7vW","6uT5sR","4qP3nM","2"].join('');
export const HUB_KEY = 'FictHub_L2mN3pQ4rS5tU6vW7xY8zA9bC0';
export const ROOT = 'a'.repeat(64);
export const digest = (n: number) => n.toString(16).padStart(64, '0');
export function entry(kind: string, text: string, n: number, path: string, data: Record<string,unknown> = {}) { return { entry: digest(n), kind, statement: text, reference: `tree:${ROOT}${path}@${digest(n)}`, applicability: '合成适用条件', data }; }
export function node(path: string, entries: any[] = [], children: Array<{name:string;path:string;digest:string}> = []) { return { path, reference: `tree:${ROOT}${path}`, name: path.split('/').at(-1) || 'root', level: 'leaf', digest: path==='/'?ROOT:digest(900+path.length), entries, children }; }
async function body(req: IncomingMessage) { const chunks: Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return JSON.parse(Buffer.concat(chunks).toString()); }
async function listen(handler: (req: IncomingMessage,res: ServerResponse)=>void|Promise<void>) { const server=createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(()=>{res.writeHead(500);res.end('{}');});});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,close:()=>new Promise<void>(done=>{server.close(()=>done());server.closeAllConnections();})}; }
export async function fakeJev(handler?: (request: JevRequest, index: number) => {status?:number;headers?:Record<string,string>;body?:unknown;delay?:number}) {
  const requests: Array<{headers:IncomingMessage['headers'];body:JevRequest}>=[];
  const scripted=new ScriptedJev((q)=>q.type==='choice'?{choice:Object.keys(q.criteria)[0],p:1}:q.type==='noul'?{noul:0.9}:{level:q.criteria.length-1,p:1},{model:MODEL});
  const server=await listen(async(req,res)=>{const input=await body(req) as JevRequest;requests.push({headers:req.headers,body:input});const spec=handler?.(input,requests.length)??{};if(spec.delay)await new Promise(done=>setTimeout(done,spec.delay));const result=spec.body??await scripted.ask(input).then(v=>({model:v.model,answers:v.answers,usage:{input_tokens:v.usage.inputTokens,output_tokens:v.usage.outputTokens}}));res.writeHead(spec.status??200,{'content-type':'application/json','x-typesafe-request-id':`synthetic-request-${requests.length}`,...spec.headers});res.end(typeof result==='string'?result:JSON.stringify(result));});return {...server,requests};
}
export async function fakeHub(nodes: any[], sources: Record<string,{text?:string;tier?:string}> = {}, paginate = false) {
  const requests:any[]=[];
  const server=await listen(async(req,res)=>{const input=await body(req);requests.push({headers:req.headers,body:input});let result:any;
    if(input.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'synthetic-hub',version:'10.6.0'}};
    else{const args=input.params.arguments;let value:any;
      if(args.reference){const row=nodes.flatMap(n=>n.entries).find(e=>e.reference===args.reference);const source=sources[args.reference];value={call_result:'ok',errors:[],trace:'b'.repeat(32),content:{reference:args.reference,read_tier:source?.tier??'model_readable',readable:(source?.tier??'model_readable')==='model_readable',...((source?.tier??'model_readable')==='model_readable'?{text:source?.text??row?.statement??'synthetic source'}:{note:'只给函数读取'})}};}
      else{let selected=nodes.filter(n=>args.paths.some((p:string)=>n.path===p||args.depth>0&&n.path.startsWith(p==='/'?p:p+'/')));if(paginate){const offset=Number(args.cursor??0);const next=offset+1<selected.length?String(offset+1):null;selected=selected.slice(offset,offset+1);value={call_result:'ok',errors:[],trace:'b'.repeat(32),root:ROOT,nodes:selected,next};}else value={call_result:'ok',errors:[],trace:'b'.repeat(32),root:ROOT,nodes:selected};}
      GetNodesOutput.parse(value);result={content:[{type:'text',text:'合成返回'}],structuredContent:value};}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result}));});return {...server,requests};
}
