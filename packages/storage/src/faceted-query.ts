import {z} from 'zod';
import {ApiError,canonicalHash,type AuthContext,type RegistryPageQuery} from '../../contracts/src/index.ts';
import type {Transaction} from './index.ts';
export interface FacetColumns {id:string;created:string;updated:string;scopeId?:string;owner?:string;productLineId?:string;flowVersion?:string;status?:string;lifecycle?:string}
const Cursor=z.object({binding:z.string(),anchor:z.string().datetime(),at:z.string().datetime(),id:z.string().min(1).max(200)}).strict();
export function pageBinding(ctx:AuthContext,collection:string,query:RegistryPageQuery){const {cursor,...filters}=query;return canonicalHash({tenantId:ctx.tenantId,principalId:ctx.principalId,runTaskId:ctx.run?.taskId??null,collection,filters});}
export async function facetedWhere(tx:Transaction,query:RegistryPageQuery,visible:string,parameters:any[],columns:FacetColumns,anchor?:string){
 anchor??=(await tx.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
 const params=[...parameters],bind=(value:any)=>{params.push(value);return `$${params.length}`;},clauses=[visible];
 for(const name of ['scopeId','owner','productLineId','flowVersion','status','lifecycle'] as const)if(query[name]!==undefined){if(!columns[name]||columns[name]==='NULL')throw new ApiError('INVALID_PAYLOAD','This registry does not support the requested facet',{facet:name});clauses.push(`${columns[name]}=${bind(query[name])}`);}
 if(query.minAgeMs!==undefined)clauses.push(`${columns.created}<=${bind(anchor)}::timestamptz-(${bind(query.minAgeMs)}::double precision*interval '1 millisecond')`);
 if(query.maxAgeMs!==undefined)clauses.push(`${columns.created}>=${bind(anchor)}::timestamptz-(${bind(query.maxAgeMs)}::double precision*interval '1 millisecond')`);
 if(query.sort==='updatedAt')clauses.push(`${columns.updated}<=${bind(anchor)}::timestamptz`);
 return {anchor:anchor!,params,clauses,bind,where:clauses.join(' AND ')};
}
export async function facetedPage(tx:Transaction,ctx:AuthContext,collection:string,query:RegistryPageQuery,from:string,visible:string,parameters:any[],columns:FacetColumns,select:string,view:(row:any)=>any){
 const binding=pageBinding(ctx,collection,query);let cursor:z.infer<typeof Cursor>|undefined;try{if(query.cursor){cursor=Cursor.parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')));if(cursor.binding!==binding)throw Error();}}catch{throw new ApiError('INVALID_PAYLOAD','List cursor belongs to another query or identity');}
 const {anchor,params,bind,clauses,where}=await facetedWhere(tx,query,visible,parameters,columns,cursor?.anchor),total=Number((await tx.query(`SELECT count(*) AS n FROM ${from} WHERE ${where}`,params)).rows[0].n),sort=query.sort==='age'?columns.created:columns.updated,direction=query.sort==='age'?(query.order==='desc'?'ASC':'DESC'):query.order.toUpperCase();
 if(cursor)clauses.push(`(${sort},${columns.id})${direction==='ASC'?'>':'<'}(${bind(cursor.at)}::timestamptz,${bind(cursor.id)})`);
 const rows=(await tx.query(`SELECT ${select},to_char(${sort} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS _cursor_at,${columns.id} AS _cursor_id FROM ${from} WHERE ${clauses.join(' AND ')} ORDER BY ${sort} ${direction},${columns.id} ${direction} LIMIT ${bind(query.limit+1)}`,params)).rows,selected=rows.slice(0,query.limit),last=selected.at(-1);
 return {total,items:selected.map(view),cursor:rows.length>query.limit?Buffer.from(JSON.stringify({binding,anchor,at:last._cursor_at,id:last._cursor_id})).toString('base64url'):null};
}
export function memoryPage(ctx:AuthContext,collection:string,query:RegistryPageQuery,items:{value:any;id:string;createdAt:string;updatedAt:string;scopeId?:string;owner?:string;productLineId?:string;flowVersion?:string;status?:string;lifecycle?:string}[]){
 const binding=pageBinding(ctx,collection,query);let cursor:z.infer<typeof Cursor>|undefined;try{if(query.cursor){cursor=Cursor.parse(JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8')));if(cursor.binding!==binding)throw Error();}}catch{throw new ApiError('INVALID_PAYLOAD','List cursor belongs to another query or identity');}
 const anchor=cursor?.anchor??new Date().toISOString(),now=Date.parse(anchor),direction=query.sort==='age'?(query.order==='desc'?1:-1):(query.order==='desc'?-1:1),time=(item:typeof items[number])=>query.sort==='age'?item.createdAt:item.updatedAt;
 const matching=items.filter(item=>['scopeId','owner','productLineId','flowVersion','status','lifecycle'].every(name=>(query as any)[name]===undefined||(item as any)[name]===(query as any)[name])&&(query.sort!=='updatedAt'||item.updatedAt<=anchor)&&(query.minAgeMs===undefined||now-Date.parse(item.createdAt)>=query.minAgeMs)&&(query.maxAgeMs===undefined||now-Date.parse(item.createdAt)<=query.maxAgeMs)).sort((a,b)=>direction*(time(a).localeCompare(time(b))||a.id.localeCompare(b.id))),following=matching.filter(item=>!cursor||direction*(time(item).localeCompare(cursor.at)||item.id.localeCompare(cursor.id))>0),selected=following.slice(0,query.limit),last=selected.at(-1);
 return {total:matching.length,items:selected.map(item=>item.value),cursor:following.length>query.limit?Buffer.from(JSON.stringify({binding,anchor,at:time(last!),id:last!.id})).toString('base64url'):null};
}
