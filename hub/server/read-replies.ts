// Short-lived in-process copies of already returned get_nodes data. No argument, source text or result reaches disk.
import { performance } from 'node:perf_hooks';
import { argumentDigest } from '../records/api.ts';
import type { ServerDeps } from './api.ts';

const TTL_MS=10*60_000, MAX_BYTES=64*1024*1024, MAX_ENTRIES=32;
type Entry={json:string;bytes:number;at:string;expires:number;ambiguous:boolean;timer:ReturnType<typeof setTimeout>};
const keyOf=(user:string,args:unknown,trace:string)=>JSON.stringify([user,argumentDigest(args).digest,trace]);

export class ReadReplies {
  private readonly rows=new Map<string,Entry>();private bytes=0;
  private readonly now:()=>number;private readonly cap:number;private readonly ttl:number;
  constructor(now:()=>number=()=>performance.now(),cap=MAX_BYTES,ttl=TTL_MS){this.now=now;this.cap=cap;this.ttl=ttl;}
  private drop(key:string){const row=this.rows.get(key);if(row){clearTimeout(row.timer);this.bytes-=row.bytes;this.rows.delete(key);}}
  private prune(){for(const [key,row] of this.rows)if(row.expires<=this.now())this.drop(key);}
  retain(user:string,args:unknown,trace:string,at:string,answer:Record<string,unknown>):void {
    this.prune();
    if(answer.call_result!=='ok'||answer.call_status!==undefined||answer.content===undefined&&answer.nodes===undefined)return;
    let json:string;try{json=JSON.stringify(answer);}catch{return;}
    const bytes=Math.max(Buffer.byteLength(json),json.length*2);if(bytes>this.cap)return;
    const key=keyOf(user,args,trace),existing=this.rows.get(key);
    if(existing){this.bytes-=existing.bytes;existing.json='';existing.bytes=0;existing.ambiguous=true;return;}
    while(this.rows.size>=MAX_ENTRIES||this.bytes+bytes>this.cap){const oldest=this.rows.keys().next().value as string|undefined;if(oldest===undefined)return;this.drop(oldest);}
    const timer=setTimeout(()=>this.drop(key),this.ttl);timer.unref();
    this.rows.set(key,{json,bytes,at,expires:this.now()+this.ttl,ambiguous:false,timer});this.bytes+=bytes;
  }
  get(user:string,args:unknown,trace:string):{answer:Record<string,unknown>;at:string}|null {
    this.prune();const row=this.rows.get(keyOf(user,args,trace));if(!row||row.ambiguous)return null;
    return {answer:JSON.parse(row.json) as Record<string,unknown>,at:row.at};
  }
}
const caches=new WeakMap<ServerDeps,ReadReplies>();
function cache(deps:ServerDeps){let value=caches.get(deps);if(!value){value=new ReadReplies();caches.set(deps,value);}return value;}
export function retainReadReply(deps:ServerDeps,user:string,args:unknown,trace:string,answer:Record<string,unknown>):void {
  cache(deps).retain(user,args,trace,(deps.now?.()??new Date()).toISOString(),answer);
}
export function cachedReadReply(deps:ServerDeps,user:string,args:unknown,trace:string){return cache(deps).get(user,args,trace);}
