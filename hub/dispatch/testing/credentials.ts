// Synthetic-only setup through the same named-secret boundary as administrator commands.
import {randomBytes} from 'node:crypto';
import type {Principal,RecordsKit} from '../../records/api.ts';
import {ExecutorRegistry} from '../executors.ts';
export async function addSyntheticExecutor(records:RecordsKit,registry:ExecutorRegistry,by:Principal,input:unknown,value:string){
 const name='DEMO_'+randomBytes(10).toString('hex').toUpperCase();
 const source={...input as object,credential:'${secret:'+name+'}'};
 if(JSON.stringify(source).includes(value))throw new Error('合成定义含调用密钥');
 const result=await registry.add(by,source);
 await records.variables.setSecrets(by,[{name,value,short:true}],'DEMO_ENROLLMENT');
 return result;
}
