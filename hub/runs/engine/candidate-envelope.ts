// Candidate bytes must be separated before canonicalization, validation, fallback object storage or diagnostics.
import type { CandidateSummary } from '../../../contracts/src/candidates.ts';
import { receivedDigest } from './util.ts';

export interface CandidateEnvelope {
  ordinary:Record<string,unknown>;
  stored:Record<string,unknown>;
  payload:unknown;
  summary:CandidateSummary|null;
  forgedSummary:boolean;
  snapshotFailed:boolean;
}
export function candidateEnvelope(args:Record<string,unknown>,documentOutputs:ReadonlySet<string>=new Set()):CandidateEnvelope {
  const ordinary={...args};
  let present=Object.hasOwn(ordinary,'candidates');
  let payload=ordinary.candidates;delete ordinary.candidates;
  // A document output does not become public run data by being put into the wrong output channel.
  if(Array.isArray(ordinary.task_outputs)){
    const privateRows=ordinary.task_outputs.filter(row=>row!==null&&typeof row==='object'&&documentOutputs.has(row.output));
    if(privateRows.length){
      present=true;payload=[...(Array.isArray(payload)?payload:payload===undefined?[]:[payload]),...privateRows];
      ordinary.task_outputs=ordinary.task_outputs.filter(row=>!privateRows.includes(row));
      if((ordinary.task_outputs as unknown[]).length===0)delete ordinary.task_outputs;
    }
  }
  // A caller cannot forge the Hub's stored summary.
  delete ordinary.candidate_summary;
  const summary=present?{count:Array.isArray(payload)?payload.length:0,sha256:receivedDigest(payload).digest}:null;
  let snapshotFailed=false;
  try{payload=structuredClone(payload);}catch{payload=null;snapshotFailed=true;}
  return {ordinary,stored:summary===null?ordinary:{...ordinary,candidate_summary:summary},payload,summary,forgedSummary:Object.hasOwn(args,'candidate_summary'),snapshotFailed};
}
