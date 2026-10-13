import {scrypt} from 'node:crypto';
import {ApiError} from '../../contracts/src/index.ts';
let active=0;
export const passwordDigest=async(value:string,salt:Buffer)=>{
  if(active>=8)throw new ApiError('RATE_LIMITED','Authentication hashing capacity is exhausted');
  active++;try{return await new Promise<Buffer>((resolve,reject)=>scrypt(value,salt,32,(error,key)=>error?reject(error):resolve(key)));}finally{active--;}
};
