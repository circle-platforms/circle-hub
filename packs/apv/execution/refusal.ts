// Legacy gateways report contract validation only as text. These exact public
// contract diagnostics are emitted before their runner launch; no other reason
// text establishes dispatch state or a device build.
const contractDiagnostics=[/^expected exactly one 'IST_EXCEL_CONTRACT' identity marker, found \d+$/,/^execution sheet does not satisfy the Excel contract:/];
export function refusalFacts(receipt:any){
 const reason=typeof receipt?.reason==='string'?receipt.reason:typeof receipt?.error==='string'?receipt.error:'Gateway refused the requested operation',declaredStage=receipt?.stage??receipt?.details?.stage,legacyContract=contractDiagnostics.some(rule=>rule.test(reason)),stage=legacyContract?'validation':declaredStage;
 const preDispatch=receipt?.ok===false&&!Object.hasOwn(receipt??{},'task_id')&&receipt?.dispatched!==true&&(legacyContract||['lease','environment','validation'].includes(stage));
 const codes=new Set(['BUILD_MISMATCH','LEASE_UNAVAILABLE','INVALID_EXECUTION_WORKBOOK','COMMAND_VALIDATION_FAILED','GATEWAY_REFUSED']),code=codes.has(receipt?.code)?receipt.code:'GATEWAY_REFUSED';
 return {preDispatch,stage:typeof stage==='string'?stage:null,code,reason,classification:legacyContract?'legacy-contract-diagnostic':typeof declaredStage==='string'?'gateway-declared-stage':'dispatch-unproven'};
}
