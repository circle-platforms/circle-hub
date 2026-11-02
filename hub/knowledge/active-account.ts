// User row locks share the committing transaction; deactivation never waits for a process-local queue.
import {AccessError,type Principal,type Transaction} from '../records/api.ts';
import type {KnowledgeContext} from './context.ts';
import {KnowledgeError} from './errors.ts';
export async function lockActive(ctx:KnowledgeContext,by:Principal,tx:Transaction,owners:readonly string[]=[]){
 try{return await ctx.records.principals.lockActive(by,tx,owners);}
 catch(error){if(error instanceof AccessError)throw new KnowledgeError('该内容不存在或无权查看',{code:'SOURCE_UNAVAILABLE'});throw error;}
}
