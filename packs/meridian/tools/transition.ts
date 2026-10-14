// Synthetic execution protocol fixture. Network, credentials and D state belong
// to the Hub; this function only chooses declared actions from recorded facts.
export function transition(input:any){
 const state=input.state??{stage:'prepare'},value=input.currentInput.value.value??{},mode=value.mode??'normal';
 const observation=(id:string)=>input.observations.find((row:any)=>row.facts.stepId===id);
 const action=(kind:string,stepId:string,fields:any={})=>({kind,stepId,occurrence:0,...fields});
 const result=(stage:string,actions:any[])=>({schema:'hub-execution-transition/1',state:{stage},actions});
 const verify=(operationId:string)=>result('verified',[
  action('hook.verify','verify-device',{event:'verify.deviceCommand',subject:{command:'synthetic observe',tree:{heads:[{command:'synthetic observe',present:true}]}}}),
  action('hook.verify','verify-host',{event:'verify.hostCommand',subject:{command:'synthetic query',host:'synthetic-client',method:'literal',kwargs:{}}}),
  action('hook.verify','verify-workbook',{event:'verify.workbook',subject:{client:'synthetic-client',contract:{testEnvEnabled:['synthetic-client']}}}),
  action('hook.verify','before-dispatch',{event:'beforeDispatch',subject:{input:input.currentInput.value,operationId}}),
 ]);
 if(state.stage==='prepare')return result('prepared',[action('provider.call','prepare',{resource:'gateway',tool:'meridian_prepare',args:{}})]);
 if(state.stage==='prepared'){
  const ready=observation('prepare');if(!ready)return result('prepared',[]);
  if(ready.facts.status!=='succeeded')return result('failed',[action('outcome.error','prepare-failed',{code:ready.facts.error?.code??'SOURCE_UNREACHABLE',facts:{stage:'prepare'}})]);
  if(mode.startsWith('wait-'))return result('waited',[action('operation.wait','wait-prepare',{operationId:mode==='wait-own'?ready.operationId:value.operationId})]);
  return verify(ready.operationId);
 }
 if(state.stage==='waited'){
  const waited=observation('wait-prepare');if(!waited)return result('waited',[]);
  if(waited.facts.status!=='succeeded')return result('failed',[action('outcome.error','wait-failed',{code:waited.facts.error?.code??'EVIDENCE_INSUFFICIENT',facts:{stage:'operation-wait'}})]);
  return verify(observation('prepare').operationId);
 }
 if(state.stage==='verified'){
  const checks=['verify-device','verify-host','verify-workbook','before-dispatch'].map(observation);if(checks.some(row=>!row))return result('verified',[]);
  if(checks.some(row=>row.facts.status!=='succeeded'))return result('failed',[action('outcome.error','verification-failed',{code:'HOOK_FAILED',facts:{stage:'verification'}})]);
  const byteArgs:Record<string,string>={payload_b64:'request'};if(mode==='wire-expansion')for(let i=0;i<400;i++)byteArgs['copy_'+i]='request';
  const submit=action('provider.call','submit',{resource:mode==='unbound-resource'?'unbound':'gateway',tool:mode==='undeclared-tool'?'not_declared':'meridian_submit',args:{label:value.label??'synthetic',...(mode==='endpoint-override'?{endpoint:'https://invalid.example.test'}:{}),...(mode==='lease-override'?{token:999}:{})},byteArgs,...(mode==='effect-override'?{effect:'read'}:{})});
  return result('submitted',[submit,...(mode==='premature-delivery'?[action('delivery.propose','unproven-delivery',{status:'succeeded',result:{terminal:true,selfReported:true},references:input.observations.map((row:any)=>row.reference)})]:[])]);
 }
 if(state.stage==='submitted'){
  const submitted=observation('submit');if(!submitted)return result('submitted',[]);
  if(submitted.facts.status!=='succeeded')return result('failed',[action('outcome.error','submit-failed',{code:submitted.facts.error?.code??'GATEWAY_REFUSED',facts:{stage:'submit'}})]);
  return result('interpreted',[action('tool.call','interpret',{path:'tools/interpret.ts',export:'interpret',args:[submitted.facts.result,mode],...(submitted.facts.result?.original?.slot?{byteSlots:[submitted.facts.result.original.slot]}:{})})]);
 }
 if(state.stage==='interpreted'){
  const parsed=observation('interpret');if(!parsed)return result('interpreted',[]);
  if(parsed.facts.status!=='succeeded')return result('failed',[action('outcome.error','interpret-failed',{code:parsed.facts.error?.code??'HOOK_FAILED',facts:{stage:'interpretation'}})]);
  return result('hooked',[action('hook.verify','after-result',{event:'afterResult',subject:{result:mode==='after-result-block'?{syntheticAfterResultBlock:true}:parsed.facts.result,operationId:observation('submit').operationId}})]);
 }
 if(state.stage==='hooked'){
  const checked=observation('after-result');if(!checked)return result('hooked',[]);if(checked.facts.status!=='succeeded')return result('failed',[action('outcome.error','after-result-failed',{code:'HOOK_FAILED',facts:{stage:'after-result'}})]);
  const parsed=observation('interpret').facts.result;return result('done',[action('delivery.propose','deliver',{status:parsed.unmapped?.length?'partial':'succeeded',result:parsed,references:input.observations.map((row:any)=>row.reference)})]);
 }
 return result(state.stage,[]);
}
