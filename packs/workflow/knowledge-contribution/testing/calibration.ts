// Synthetic tree-backed calibration fixtures; no manually asserted probabilities without judgment records.
import {ScriptedJev} from '../../../../hub/jev/api.ts';
import {inputDigest,judgmentRecord,topChoice} from '../tools/jev/lib/api.ts';
import {deriveCalibrationTasks} from '../tools/jev/lib/workflow.ts';
import type {Hub} from '../tools/jev/lib/hub.ts';
import type {LocalStore} from '../tools/jev/lib/local.ts';
import {MODEL,ROOT} from './servers.ts';
export async function seedCalibration(store:LocalStore,hub:Hub,under:string,p=0.9){
 const samples:any[]=[];const judgments:string[]=[];
 for(const task of await deriveCalibrationTasks(hub,ROOT,under)){
  const request={model:MODEL,state:{[task.piece.id]:task.piece.text},questions:{[task.piece.id]:task.question}};
  const response=await new ScriptedJev(()=>({choice:task.expected,p}),{model:MODEL}).ask(request);
  const r=judgmentRecord({request,response,questionId:task.piece.id,input:task.piece.text,at:'2026-10-24T00:00:00.000Z'});await store.append('judgments.jsonl',r);const top=topChoice(r.answer);samples.push({input:inputDigest({piece:r.input_digest,node:task.path}),expected:task.expected,chosen:top.choice,probability:top.p});judgments.push(inputDigest(r));
 }
 const set={chain:'placement.choice',model:MODEL,root:ROOT,under,samples,judgments};await store.append('calibration.jsonl',set);return set;
}
