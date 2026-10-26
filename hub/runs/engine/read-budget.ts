// Process-wide source concurrency plus an evaluation-owned, deduplicated byte/reference budget.
// A budget is reserved before I/O, so rejected work cannot occupy database connections.
import {HubReadFailure} from './retry-read.ts';
export const CHECK_READ_CONCURRENCY=4;
export const CHECK_READ_REFERENCES=256;
export const CHECK_READ_TOTAL_BYTES=16*1024*1024;
let active=0;
const waiting:Array<()=>void>=[];
async function limited<T>(work:()=>Promise<T>):Promise<T>{
 if(active<CHECK_READ_CONCURRENCY)active++;else await new Promise<void>(resolve=>waiting.push(resolve));
 try{return await work();}finally{const next=waiting.shift();if(next)next();else active--;}
}
export class CheckReadBudget {
 readonly references=new Set<string>();
 readonly sizes=new Map<string,number>();
 bytes=0;
 fail(reference:string):never{throw new HubReadFailure(reference,'check_error',[],'检查来源读取预算已用尽，核验未完成（最多 256 个来源、合计 16 MiB）','运行者拆分计划或输入后开新修订；管理员核对读取预算，不能把未读取部分当作已通过；本次不计模型修复轮数');}
 reserve(reference:string):void{
  if(this.references.has(reference))return;
  if(this.references.size>=CHECK_READ_REFERENCES)this.fail(reference);
  this.references.add(reference);
 }
 async read<T>(reference:string,work:()=>Promise<T>):Promise<T>{
  this.reserve(reference);
  return limited(async()=>{
   const result=await work();
   const text=result!==null&&typeof result==='object'&&'text' in result?result.text:null;
   const size=typeof text==='string'?Buffer.byteLength(text):0,old=this.sizes.get(reference)??0;
   if(this.bytes+Math.max(0,size-old)>CHECK_READ_TOTAL_BYTES)this.fail(reference);
   this.bytes+=Math.max(0,size-old);this.sizes.set(reference,Math.max(size,old));return result;
  });
 }
}
