import type {DispatchService} from '../service.ts';
import type {RecordsKit,Transaction} from '../../records/api.ts';

/** Inject a committed source change before admission locks, never while holding the lock it needs. */
export function tracePermissionBoundary(records:Pick<RecordsKit,'store'>,executor:string,beforeLock:()=>Promise<void>) {
  let networkAdmissions=0;
  const intentTransactions=new Set<Transaction>();
  const original=records.store.lock.bind(records.store);
  records.store.lock=async(key,tx)=>{
    if(key==='test-environment.permissions'&&networkAdmissions===0)await beforeLock();
    if(key==='dispatch-config:executor:'+executor)intentTransactions.add(tx);
    return original(key,tx);
  };
  return {isIntent:(tx:Transaction)=>intentTransactions.has(tx),attach:(service:DispatchService)=>{
    const original=Reflect.get(service,'admitNewUse') as (...args:unknown[])=>Promise<void>;
    Reflect.set(service,'admitNewUse',async(...args:unknown[])=>{
      networkAdmissions++;
      try{return await original.apply(service,args);}finally{networkAdmissions--;}
    });
  }};
}
