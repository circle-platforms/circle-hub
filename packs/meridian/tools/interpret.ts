export function interpret(receipt:any,mode='normal',originalBytes?:Uint8Array){
 if(mode==='parser-throw')throw new Error('Synthetic interpretation failure');
 if(mode==='parser-timeout'){for(;;){/* Deliberate synthetic interpreter timeout. */}}
 if(mode==='parser-too-large')return {text:'x'.repeat(17*1024*1024)};
 if(mode==='parser-invalid')return undefined;
 const original=originalBytes?JSON.parse(new TextDecoder().decode(originalBytes)):receipt,result=original?.result??original,items=result?.items;
 return {kind:'synthetic-observation',items:Array.isArray(items)?items:[],unmapped:[...(!Array.isArray(items)?[{reason:'result_unavailable'}]:[]),...(mode==='missing-mapping'?[{reason:'synthetic_missing_mapping'}]:[])]};
}
