// Controlled condition identifiers and hash-only field observations, never exception text or source fragments.
import {canonicalize,sha256Hex} from '../records/api.ts';
export interface ReleaseField {field:string;matches:boolean|null;expected_sha256:string;actual_sha256:string}
export interface ReleaseCheck {condition:string;label:string;satisfied:boolean|null;fields:ReleaseField[];missing_fact?:string;next_action?:string}
export const releaseDigest=(value:unknown):string=>{try{return sha256Hex(canonicalize(value===undefined?{present:false}:{present:true,value}));}catch{return sha256Hex('unserializable');}};
export const releaseField=(field:string,expected:unknown,actual:unknown,matches:boolean|null):ReleaseField=>({field,matches,expected_sha256:releaseDigest(expected),actual_sha256:releaseDigest(actual)});
export class ReleaseTrace {
 readonly checks:ReleaseCheck[]=[];
 check(condition:string,label:string,satisfied:boolean|null,fields:ReleaseField[]=[]):void{this.checks.push({condition,label,satisfied,fields,...(satisfied===null?{missing_fact:'尚缺完成“'+label+'”所需的前置事实或可读记录',next_action:'管理员恢复该条件所列字段及记录的可读性，再运行 job explain-release；条件齐备后重新核验'}:{})});}
 async read<T>(condition:string,label:string,work:()=>Promise<T>):Promise<T|null>{
  try{const value=await work();this.check(condition,label,true);return value;}
  catch(error){this.check(condition,label,null,[releaseField('exception',undefined,error instanceof Error?{name:error.name,message:error.message}:error,null)]);return null;}
 }
}
export class ReleaseDiagnosticError extends Error {
 readonly checks:ReleaseCheck[];
 constructor(message:string,checks:ReleaseCheck[]=[]){super(message);this.checks=checks;}
}
export function releaseFailure(error:unknown):ReleaseCheck[]{
 return error instanceof ReleaseDiagnosticError&&error.checks.length?error.checks:[{condition:'release.execution',label:'放行核对未完成，异常内容仅保留摘要',satisfied:null,missing_fact:'放行核对中断，缺少完整条件结果',next_action:'管理员按异常摘要定位故障，恢复读取与核对能力后重跑 job explain-release 和核验',fields:[releaseField('exception',undefined,error instanceof Error?{name:error.name,message:error.message}:error,null)]}];
}
/** Structural JSON differences only: names locate mismatches; values are hashed. */
export function releaseDifferences(field:string,expected:unknown,actual:unknown):ReleaseField[]{
 if(releaseDigest(expected)===releaseDigest(actual))return [];
 if(Array.isArray(expected)!==Array.isArray(actual))return [releaseField(field,expected,actual,false)];
 if(expected&&actual&&typeof expected==='object'&&typeof actual==='object'){
  const left=expected as Record<string,unknown>,right=actual as Record<string,unknown>;
  return [...new Set([...Object.keys(left),...Object.keys(right)])].sort().flatMap(key=>releaseDifferences(field+'/'+key.replaceAll('~','~0').replaceAll('/','~1'),left[key],right[key]));
 }
 return [releaseField(field,expected,actual,false)];
}
