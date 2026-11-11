// Only this allow-listed diagnostic crosses from sandbox failures into feeding records. Child logs, stacks and
// arbitrary detail fields are never copied. Credential protection is the existing B02 scanner; source protection
// compares exact scalar values and verbatim fragments, without semantic classification or spelling recovery.
import {SandboxError,type SandboxErrorCode} from '../rules/api.ts';
import {scanForCredentials} from '../records/api.ts';
export interface FeedingErrorDetail {
 function:string;
 code:SandboxErrorCode;
 message:string|null;
 message_status:'included'|'credential_withheld'|'source_withheld'|'source_unchecked';
 truncated:boolean;
}
const clean=(text:string)=>{const scan=scanForCredentials(new TextEncoder().encode(text));return scan.inspected&&!scan.truncated&&scan.findings.length===0;};
function sourceStatus(message:string,inputs:readonly unknown[]):'source_withheld'|'source_unchecked'|null {
 const pending=[...inputs],seen=new Set<object>();let nodes=0,chars=0;
 const windows=new Set<string>();for(let i=0;i+8<=message.length;i++)windows.add(message.slice(i,i+8));
 while(pending.length){if(++nodes>100000)return 'source_unchecked';const value=pending.pop();if(typeof value==='string'){
   chars+=value.length;if(chars>2*1024*1024)return 'source_unchecked';if(!value.length)continue;
   const escaped=JSON.stringify(value).slice(1,-1);
   for(const text of escaped===value?[value]:[value,escaped]){if(message.includes(text))return 'source_withheld';for(let i=0;i+8<=text.length;i++)if(windows.has(text.slice(i,i+8)))return 'source_withheld';}
  }else if(value!==null&&typeof value==='object'&&!seen.has(value)){seen.add(value);const children=Object.values(value);if(pending.length+children.length>100000)return 'source_unchecked';for(const child of children)pending.push(child);}
 }
 return null;
}
export class FeedingFunctionFailure extends Error {
 readonly detail:FeedingErrorDetail;
 constructor(error:SandboxError,identity:string,inputs:readonly unknown[]){
  const raw=typeof error.detail.message==='string'?error.detail.message:error.message;
  let message_status:FeedingErrorDetail['message_status']='included';
  if(!raw.isWellFormed())message_status='source_unchecked';else if(!clean(raw)||!clean(identity))message_status='credential_withheld';else message_status=sourceStatus(raw,inputs)??'included';
  const points=Array.from(raw),detail:FeedingErrorDetail={function:clean(identity)?identity:'[函数标识未通过凭据扫描]',code:error.code,message:message_status==='included'?points.slice(0,500).join(''):null,message_status,truncated:points.length>500};
  if(detail.message!==null&&!clean(JSON.stringify(detail))){detail.message=null;detail.message_status='credential_withheld';}
  // The caller-facing unknown identifies the failure without sending the private message or input contents.
  super(`包函数失败（${detail.code}，${detail.function}）；原件整份未进入喂入层，管理员查看喂入待办详情`);this.name='FeedingFunctionFailure';this.detail=detail;
 }
}
export async function feedingFunctionCall<T>(identity:string,inputs:readonly unknown[],call:()=>Promise<T>):Promise<T>{
 try{return await call();}catch(error){if(error instanceof SandboxError)throw new FeedingFunctionFailure(error,identity,inputs);throw error;}
}
