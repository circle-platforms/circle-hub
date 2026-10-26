import {at,readDeclaredTime} from './definition.ts';
import {canonicalize} from '../records/api.ts';
export interface RequestIdentity {epoch:string;since:number|null;subject:unknown}
export function requestIdentity(value:unknown,fields:{epoch:string;since:string;subject:string}|undefined,scale?:number):RequestIdentity|null {
  if(!fields)return null;
  const epoch=at(value,fields.epoch),subject=at(value,fields.subject),since=readDeclaredTime(at(value,fields.since),scale);
  if(typeof epoch!=='string' || !epoch.trim() || epoch.length>512 || epoch.includes('[已隐藏]') || /[\u0000-\u001f]/.test(epoch))return null;
  if(!(typeof subject==='string' && subject.trim() || subject && typeof subject==='object' && !Array.isArray(subject) && Object.keys(subject).length))return null;
  if(canonicalize(subject).includes('[已隐藏]'))return null;
  return {epoch,since:Number.isFinite(since)?since:null,subject};
}
export function sameRequestIdentity(before:unknown,after:RequestIdentity|null):boolean {
  return !!before && !!after && typeof before==='object' && 'epoch' in before && 'subject' in before && canonicalize({epoch:before.epoch,subject:before.subject})===canonicalize({epoch:after.epoch,subject:after.subject});
}
