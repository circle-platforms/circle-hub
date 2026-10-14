import {z} from 'zod';
import type {Store} from '../../storage/src/index.ts';
import type {Auth} from './auth.ts';
import {ApiError,NotificationQuery,type AuthContext} from '../../contracts/src/index.ts';
import {replayWindow} from './outbox-retention.ts';import {notificationKinds,projectedEvent} from './notification-payload.ts';
export {NotificationQuery};
export class Notifications{
  store:Store;auth:Auth;
  streams=new Map<string,number>();maxStreams=Number(process.env.CIRCLE_SERVER_NOTIFICATION_STREAMS??4);
  constructor(store:Store,auth:Auth){this.store=store;this.auth=auth;}
  reserve(ctx:AuthContext){if(!Number.isSafeInteger(this.maxStreams)||this.maxStreams<1)throw new ApiError('INVALID_PAYLOAD','Notification stream limit is invalid');const key=ctx.tenantId+'/'+ctx.principalId,prior=this.streams.get(key)??0;if(prior>=this.maxStreams)throw new ApiError('NOTIFICATION_STREAM_LIMIT','Close an existing notification stream before opening another');this.streams.set(key,prior+1);let done=false;return ()=>{if(done)return;done=true;const count=(this.streams.get(key)??1)-1;if(count)this.streams.set(key,count);else this.streams.delete(key);};}
  async page(ctx:AuthContext,query:z.infer<typeof NotificationQuery>){const p=await this.auth.check(ctx,'tasks.read');return this.store.transaction(async tx=>{
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const window=await replayWindow(this.store,query.cursor,tx);
    const rows=(await tx.query(`SELECT e.*,COALESCE(t.scope_id,e.notification_context->>'scopeId') AS scope_id FROM outbox e LEFT JOIN tasks t USING(task_id) WHERE e.seq>$1 AND ((t.tenant_id=$2 AND t.scope_id=ANY($3::text[]) AND (t.context->>'privateOwnerId' IS NULL OR t.context->>'privateOwnerId'=$4)) OR (e.task_id IS NULL AND e.notification_context->>'tenantId'=$2 AND e.notification_context->>'scopeId'=ANY($3::text[]) AND e.notification_context->>'principalId'=$4)) AND e.kind=ANY($5::text[]) ORDER BY e.seq LIMIT $6`,[query.cursor,p.tenantId,p.scopes,p.principalId,notificationKinds,query.limit+1])).rows;
    const items=rows.slice(0,query.limit).map(row=>({...projectedEvent(row),scopeId:row.scope_id})),last=items.at(-1)?.seq??query.cursor;
    return {items,cursor:last,hasMore:rows.length>query.limit,replayWindow:window};
  });}
}
