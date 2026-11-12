// Read-only engine calls share verified lookups only within their caller's asynchronous request.
import {withReadScope,scopedRecordStore,memoReadPort,memoReadCall} from '../../records/api.ts';
import type {EngineContext} from './deps.ts';
export function withQueryReads<T>(ctx:EngineContext,read:(current:EngineContext)=>T,options:{isolated?:boolean}={}):T{
 return withReadScope(()=>read({...ctx,queryRead:(key,load)=>memoReadCall(ctx,key,load),deps:{...ctx.deps,records:{...ctx.deps.records,
  store:scopedRecordStore(ctx.deps.records.store),
  artifacts:memoReadPort(ctx.deps.records.artifacts,['canRead','records','canReadForRun','mayDeclareUpload']),
  ...(ctx.deps.records.principals?{principals:memoReadPort(ctx.deps.records.principals,['get','list'])}:{})
 }}}),options);
}

/** Full input keys keep readers, frozen versions and diagnostic exceptions separate. Failures are evicted. */
export function queryRead<K extends readonly unknown[],T>(ctx:EngineContext,key:K,read:(snapshot:K)=>Promise<T>):Promise<T>{
 if(!ctx.queryRead)return read(key);
 // The read scope validates/snapshots once and uses that same value for identity and execution.
 return ctx.queryRead(key,read);
}
