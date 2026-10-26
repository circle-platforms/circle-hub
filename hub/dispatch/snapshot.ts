// Hub-internal read capability; it exposes digests rather than privileged executor listing data.
import type {RecordsKit,VariableSnapshot} from '../records/api.ts';
import {canonicalBytes} from '../records/api.ts';
import {ExecutorRegistry} from './executors.ts';
import {boundaryPolicy} from './policy.ts';
export async function freezeEffectRegistry(records:RecordsKit,variables:VariableSnapshot):Promise<{policy:string;executors:string}> {
 const policy=await boundaryPolicy();await records.objects.put(canonicalBytes(policy.document),'application/json');
 const executors=await new ExecutorRegistry(records).snapshot(variables);
 return {policy:policy.version,executors};
}
