import type {Migration,Transaction} from '../../storage/src/index.ts';
import type {AuthContext} from '../../contracts/src/index.ts';
export const notificationMigration:Migration={version:31,name:'Persist owner scoped notifications without a fabricated task',sql:`
ALTER TABLE outbox ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE outbox ADD COLUMN notification_context jsonb;
ALTER TABLE outbox ADD CONSTRAINT outbox_subject CHECK(task_id IS NOT NULL OR (notification_context->>'tenantId' IS NOT NULL AND notification_context->>'scopeId' IS NOT NULL AND notification_context->>'principalId' IS NOT NULL));
`};
export async function publishBotFailure(tx:Transaction,ctx:AuthContext&{scopeId:string},botAssetId:string,occurrenceKey:string,error:any){
 const seq=(await tx.query('UPDATE event_clock SET value=value+1 WHERE singleton RETURNING value')).rows[0].value;
 await tx.query("INSERT INTO outbox(seq,task_id,kind,payload,notification_context) VALUES($1,NULL,'bot.admission-failed',$2,$3)",[seq,JSON.stringify({botAssetId,occurrenceKey,error}),JSON.stringify({tenantId:ctx.tenantId,scopeId:ctx.scopeId,principalId:ctx.principalId})]);
}
