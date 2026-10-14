import '../../contracts/src/hub-environment.ts';
import {ApiError,registerErrorCodes} from '../../contracts/src/index.ts';import type {Transaction,Store} from '../../storage/src/index.ts';
registerErrorCodes({CURSOR_EXPIRED:[409,'validation'],NOTIFICATION_STREAM_LIMIT:[429,'permission']});
function setting(name:string,value:number){const configured=Number(process.env[name]??value);if(!Number.isSafeInteger(configured)||configured<1)throw new ApiError('INVALID_PAYLOAD','Event retention configuration is invalid');return configured;}
export const eventRetention={maxRows:setting('CIRCLE_HUB_OUTBOX_MAX_ROWS',100000),replayEvents:setting('CIRCLE_HUB_OUTBOX_REPLAY_EVENTS',10000),maxAgeMs:setting('CIRCLE_HUB_OUTBOX_MAX_AGE_MS',7*86400000)};
if(eventRetention.replayEvents>eventRetention.maxRows)throw new ApiError('INVALID_PAYLOAD','Replay window exceeds the event row limit');
export async function replayWindow(store:Store,after:number,tx?:Transaction){const row=(await(tx??store.pool).query('SELECT discarded_through FROM outbox_retention WHERE singleton')).rows[0],minCursor=Number(row.discarded_through);if(after>0&&after<minCursor)throw new ApiError('CURSOR_EXPIRED','Events were retained for a bounded window; restart the query from cursor zero',{minCursor,replayEvents:eventRetention.replayEvents});return {minCursor,replayEvents:eventRetention.replayEvents,maxRows:eventRetention.maxRows};}
export async function trimOutbox(tx:Transaction,targetRows=eventRetention.maxRows){
 await tx.query('SELECT value FROM event_clock WHERE singleton FOR UPDATE');
 const bounds=(await tx.query(`SELECT (SELECT seq-1 FROM outbox ORDER BY seq DESC OFFSET $1 LIMIT 1) AS window_floor,
   (SELECT seq FROM outbox ORDER BY seq DESC OFFSET $2 LIMIT 1) AS count_cut,
   (SELECT max(seq) FROM outbox WHERE created_at<clock_timestamp()-($3::double precision*interval '1 millisecond')) AS age_cut`,[eventRetention.replayEvents-1,targetRows,eventRetention.maxAgeMs])).rows[0];
 const cut=bounds.window_floor===null?0:Math.min(Number(bounds.window_floor),Math.max(Number(bounds.count_cut??0),Number(bounds.age_cut??0)));
 if(cut)await tx.query('DELETE FROM outbox WHERE seq<=$1',[cut]);await tx.query('UPDATE outbox_retention SET discarded_through=GREATEST(discarded_through,$1),retained_rows=(SELECT count(*) FROM outbox) WHERE singleton',[cut]);
}
export async function outboxWritten(tx:Transaction){const row=(await tx.query('UPDATE outbox_retention SET retained_rows=retained_rows+1 WHERE singleton RETURNING retained_rows')).rows[0];if(Number(row.retained_rows)>eventRetention.maxRows)await trimOutbox(tx,Math.max(eventRetention.replayEvents,Math.floor(eventRetention.maxRows*.9)));}
