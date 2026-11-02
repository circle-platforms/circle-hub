// Read-only engine calls share verified lookups only within their caller's asynchronous request.
import {withReadScope,scopedRecordStore,memoReadPort} from '../../records/api.ts';
import type {EngineContext} from './deps.ts';
export function withQueryReads<T>(ctx:EngineContext,read:(current:EngineContext)=>T):T{
 return withReadScope(()=>read({...ctx,deps:{...ctx.deps,records:{...ctx.deps.records,
  store:scopedRecordStore(ctx.deps.records.store),
  artifacts:memoReadPort(ctx.deps.records.artifacts,['canRead','records','canReadForRun','mayDeclareUpload']),
  ...(ctx.deps.records.principals?{principals:memoReadPort(ctx.deps.records.principals,['get','list'])}:{})
 }}}));
}
