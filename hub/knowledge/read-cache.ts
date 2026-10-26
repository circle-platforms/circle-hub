// Read-derived payloads are useful only within one operation. Async contexts may outlive a read (for example on a
// pooled connection), so dispose their maps explicitly instead of relying on the AsyncLocalStorage context being GC'd.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ReadCacheState {
  map: Map<unknown, {value:unknown;weight:number}>;
  weight: number;
}
interface ReadCacheScope {states:Map<object,ReadCacheState>;closed:boolean}
const reads=new AsyncLocalStorage<ReadCacheScope>();

export function currentReadCache():ReadCacheScope|undefined {return reads.getStore();}

export async function withReadCache<T>(operation:()=>T|Promise<T>):Promise<T> {
  const parent=reads.getStore();
  if(parent&&!parent.closed)return operation();
  const scope:ReadCacheScope={states:new Map(),closed:false};
  return reads.run(scope,async()=>{
    try{return await operation();}
    finally{
      scope.closed=true;
      for(const state of scope.states.values()){state.map.clear();state.weight=0;}
      scope.states.clear();
    }
  });
}
