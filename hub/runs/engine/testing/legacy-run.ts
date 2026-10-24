// Synthetic legacy input fixture only; production admission never calls this helper.
import {RunSummary,type RunRecord} from '../../../../contracts/src/run.ts';
import {newId,type RecordsKit} from '../../../records/api.ts';
import {putRun,runById} from '../store.ts';

/** Keep real parsed bindings from an admitted synthetic run, then seed a separately identified old declaration. */
export async function seedLegacyRun(records:Pick<RecordsKit,'store'>,admitted:RunSummary,pack:{id:string;version:string;digest:string},requirements:RunRecord['requirements']):Promise<RunSummary>{
  const source=await runById(records.store,admitted.run);
  if(!source)throw new Error('Synthetic bootstrap run is missing');
  const identity={run:newId('run',Date.parse(source.body.started_at)),pack:pack.id+'@'+pack.version,pack_digest:pack.digest,requirements};
  await putRun(records.store,{...source.body,...identity},source.body.started_at);
  return RunSummary.parse({...admitted,...identity});
}
