// Freeze the epoch before asynchronous admission; recheck after acquiring the actual write transaction.
import type {KnowledgeContext} from '../context.ts';
import {RecordsError,type Transaction} from '../../records/api.ts';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
export async function personalEpoch(ctx:KnowledgeContext,owner:string,tx?:Transaction){return (await ctx.records.personalPayloads?.scope(owner,tx))?.epoch;}
export async function guardPersonalEpoch(ctx:KnowledgeContext,owner:string,epoch:string|undefined,tx:Transaction){if(epoch!==undefined&&(await personalEpoch(ctx,owner,tx))!==epoch)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});}
