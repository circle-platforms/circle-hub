import {canonicalHash,canonicalJson,requireCondition,sha256} from '../../contracts/src/index.ts';
import {verifyProviderReceipt} from './flow-provider.ts';

// C supplies these fields from a unique persisted write in this exact revision.
// Neither a read action's byteArgs nor a caller's result body grants identity.
export function resultReadParentBinding(parent:any,expected:any){
 for(const key of ['taskId','inputRevisionId','tenantId','scopeId','remoteId'])requireCondition(parent[key]===expected[key],'EVIDENCE_INSUFFICIENT','Result parent is outside its frozen task partition');
 requireCondition(parent.terminal===true&&['succeeded','reconciled'].includes(parent.status)&&canonicalHash(parent.resource)===canonicalHash(expected.resource),'EVIDENCE_INSUFFICIENT','Result parent is not a known terminal of the bound resource');
 const stored=parent.identity,isHash=(value:any)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);requireCondition(stored?.remoteId===expected.remoteId&&isHash(stored.requestHash)&&isHash(stored.inputSha256)&&stored.byteHashes&&typeof stored.byteHashes==='object'&&!Array.isArray(stored.byteHashes)&&Object.values(stored.byteHashes).every(isHash)&&isHash(parent.submittedSha256)&&isHash(parent.terminalSha256),'EVIDENCE_INSUFFICIENT','Result parent has no verified submitted identity or proof hashes');
 const identity={remoteId:stored.remoteId,requestHash:stored.requestHash,inputSha256:stored.inputSha256,byteHashes:stored.byteHashes,...(stored.receiptFacts?{receiptFacts:stored.receiptFacts}:{})},hashes=Object.values(stored.byteHashes),sourceByteProofSha256=stored.receiptFacts?.byteSha256??(hashes.length===1?hashes[0]:canonicalHash(stored.byteHashes));
 const binding={schema:'hub-provider-result-binding/1',taskId:parent.taskId,inputRevisionId:parent.inputRevisionId,tenantId:parent.tenantId,scopeId:parent.scopeId,resource:parent.resource,operationId:parent.operationId,identity,submittedSha256:parent.submittedSha256,terminalSha256:parent.terminalSha256,terminalStage:parent.terminalStage??'status',sourceByteProofSha256};return {...binding,bindingSha256:canonicalHash(binding)};
}
export function freezeResultReadBinding(parent:any,expected:any,policy:any,submittedBytes:Buffer,terminalBytes:Buffer){
 const binding=resultReadParentBinding(parent,expected);
 requireCondition(Buffer.isBuffer(submittedBytes)&&sha256(submittedBytes)===parent.submittedSha256&&Buffer.isBuffer(terminalBytes)&&sha256(terminalBytes)===parent.terminalSha256,'SOURCE_HASH_MISMATCH','Result parent original proof differs from its SHA');
 let submitted:any,terminal:any;try{submitted=JSON.parse(submittedBytes.toString('utf8'));terminal=JSON.parse(terminalBytes.toString('utf8'));}catch{requireCondition(false,'EVIDENCE_INSUFFICIENT','Result parent proof is not JSON');}
 verifyProviderReceipt({receiptPolicy:policy},submitted,binding.identity,binding.identity.byteHashes,false,'submit',binding.identity.receiptFacts);verifyProviderReceipt({receiptPolicy:policy},terminal,binding.identity,binding.identity.byteHashes,true,binding.terminalStage,binding.identity.receiptFacts);return binding;
}

export function extendResultReadGaps(previous:any[],fact:any){
 requireCondition(Array.isArray(previous),'EVIDENCE_INSUFFICIENT','Result interpretation history is not an array');const gaps=previous.some(item=>canonicalHash(item)===canonicalHash(fact))?previous:[...previous,fact];
 return {schema:'hub-result-read-gaps/1' as const,gaps,count:gaps.length};
}

export function resultReadGapSummary(history:ReturnType<typeof extendResultReadGaps>,reference:any,terminalOperationId:string,code:string){
 const bytes=Buffer.from(canonicalJson(history));requireCondition(reference.kind==='artifact'&&reference.sha256===sha256(bytes)&&reference.size===bytes.length,'SOURCE_HASH_MISMATCH','Result gap summary must reference its complete B history');
 return {unmapped:[{terminalOperationId,reason:'interpretation_unavailable',code,count:history.count,reference}],interpretationGapArchive:{count:history.count,reference}};
}
