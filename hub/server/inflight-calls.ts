// A process-local index of running MCP calls. It retains no arguments or source content.
import { argumentDigest } from '../records/api.ts';
import type { ServerDeps } from './api.ts';

type ActiveCall = {trace:string;started_at:string};
const indexes=new WeakMap<ServerDeps,Map<string,Set<ActiveCall>>>();
const keyOf=(user:string,tool:string,args:unknown)=>JSON.stringify([user,tool,argumentDigest(args).digest]);

export function beginObservedCall(deps:ServerDeps,user:string,tool:string,args:unknown,trace:string):()=>void {
  let index=indexes.get(deps);if(!index){index=new Map();indexes.set(deps,index);}
  const key=keyOf(user,tool,args),entry={trace,started_at:(deps.now?.()??new Date()).toISOString()};
  let calls=index.get(key);if(!calls){calls=new Set();index.set(key,calls);}calls.add(entry);
  return ()=>{calls!.delete(entry);if(calls!.size===0)index!.delete(key);};
}

export function observedCalls(deps:ServerDeps,user:string,tool:string,args:unknown):ActiveCall[] {
  return [...(indexes.get(deps)?.get(keyOf(user,tool,args))??[])];
}
