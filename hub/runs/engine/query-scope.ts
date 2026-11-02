// Read-only engine calls share verified lookups only within their caller's asynchronous request.
import {withReadScope,scopedRecordStore,memoReadPort,memoReadValue} from '../../records/api.ts';
import type {EngineContext} from './deps.ts';
export function withQueryReads<T>(ctx:EngineContext,read:(current:EngineContext)=>T):T{
 return withReadScope(()=>read({...ctx,queryRead:(key,load)=>memoReadValue(ctx,key,load),deps:{...ctx.deps,records:{...ctx.deps.records,
  store:scopedRecordStore(ctx.deps.records.store),
  artifacts:memoReadPort(ctx.deps.records.artifacts,['canRead','records','canReadForRun','mayDeclareUpload']),
  ...(ctx.deps.records.principals?{principals:memoReadPort(ctx.deps.records.principals,['get','list'])}:{})
 }}}));
}

/** Full input keys keep readers, frozen versions and diagnostic exceptions separate. Failures are evicted. */
export function queryRead<K extends readonly unknown[],T>(ctx:EngineContext,key:K,read:(snapshot:K)=>Promise<T>):Promise<T>{
 if(!ctx.queryRead)return read(key);
 // The proof must use the same JSON snapshot as its identity, even if a caller mutates input before the first await.
 const encoded=JSON.stringify(key);
 return ctx.queryRead([encoded],()=>read(JSON.parse(encoded) as K));
}
