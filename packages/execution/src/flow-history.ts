import {canonicalHash,canonicalJson,sha256,EXECUTION_TRANSITION_LIMITS,requireCondition} from '../../contracts/src/index.ts';

export function selectFlowHistory(rows:any[],capacity=EXECUTION_TRANSITION_LIMITS.arrayItems){
 const active=new Set(['accepted','running','waiting-review','unknown']);
 const critical=(row:any)=>Boolean(row.intent||row.authorization_asset_id||active.has(row.status));
 const required=rows.filter(critical);requireCondition(required.length<=capacity,'RESULT_TOO_LARGE','Active dispatch and authorization history exceeds the inline window');
 const selected=new Set(required),remaining=rows.filter(row=>!critical(row)),available=capacity-required.length;if(available>0)for(const row of remaining.slice(-available))selected.add(row);
 return {selected:rows.filter(row=>selected.has(row)),complete:selected.size===rows.length,total:rows.length};
}
export function requireSameHistorySlot(existing:any,requested:any){requireCondition(existing.role===requested.role&&canonicalHash(existing.reference)===canonicalHash(requested.reference),'SOURCE_HASH_MISMATCH','Controlled history slot cannot shadow a different role or original');}
export function flowLedgerFacts(row:any){return {stepId:row.step_id,occurrence:Number(row.occurrence),status:row.status,origin:'hub-step-ledger',intent:row.intent,terminal:row.terminal,...(row.authorization_asset_id?{authorizationAssetId:row.authorization_asset_id}:{})};}
export async function authorizedHistoryBytes(knowledge:any,tx:any,actor:any,reference:any){const checked=await knowledge.contentReference(actor,'artifact',reference.artifactId,tx);requireCondition(checked.sha256===reference.sha256&&checked.size===reference.size,'SOURCE_HASH_MISMATCH','History original differs from its authorized B reference');const bytes=await knowledge.objects.getObject({Bucket:'evidence',Key:checked.sha256});requireCondition(bytes.length===checked.size&&sha256(bytes)===checked.sha256,'SOURCE_HASH_MISMATCH','History original bytes differ from their authorized SHA');return bytes;}

export async function controlledHistoryArchive(knowledge:any,tx:any,task:any,actor:any,kind:'observations'|'occurrences',items:any[]){
 const property=kind==='observations'?'observations':'expectedOccurrences',bytes=Buffer.from(canonicalJson({schema:kind==='observations'?'hub-flow-history/1':'hub-flow-occurrences/1',[property]:items}));
 requireCondition(bytes.length<=EXECUTION_TRANSITION_LIMITS.controlledBytes,'BODY_TOO_LARGE','Flow history archive exceeds the unchanged controlled-byte ceiling');
 const artifact=await knowledge.materialize(tx,task,`flow-history-${kind}-${canonicalHash(items)}`,`flow-${kind}-history.json`,'application/json',bytes,{transformation:'hub-persisted-flow-history',inputRevisionId:task.inputRevisionId});
 const reference={kind:'artifact',artifactId:artifact.artifactId,sha256:artifact.sha256,size:artifact.size};await knowledge.contentReference(actor,'artifact',artifact.artifactId,tx);
 const slot=`hub.history.${kind}.${artifact.sha256}`,role=kind==='observations'?'flow-history':'flow-occurrences';return {archive:{slot,reference},controlled:{slot,role,encoding:'base64',reference,contentBase64:bytes.toString('base64')}};
}

export async function authorizeFlowHistory(knowledge:any,tx:any,actor:any,observations:any[]){
 for(const observation of observations){const ref=observation.reference;requireCondition(ref.kind==='artifact','EVIDENCE_INSUFFICIENT','Flow observation must retain its original artifact');const available=await knowledge.contentReference(actor,'artifact',ref.artifactId,tx);requireCondition(available.sha256===ref.sha256&&available.size===ref.size,'SOURCE_HASH_MISMATCH','Flow history original differs from its authorized B reference');}
}
