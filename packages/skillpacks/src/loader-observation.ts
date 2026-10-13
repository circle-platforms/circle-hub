// RPC results contain a call id, not its arguments. Correlate it with the
// preceding assistant call; output prose cannot assert a skill identity.
export function skillWasLoaded(events:any[],id:string):boolean{
 const calls=new Map<string,{name:string;args:any}|null>();
 for(const event of events){
  if(event?.type==='assistant'&&Array.isArray(event.tool_calls))for(const call of event.tool_calls){if(typeof call?.id!=='string')continue;calls.set(call.id,calls.has(call.id)?null:{name:call.name,args:call.args});}
  if(event?.type==='tool_result'&&event.name==='skill'&&event.status==='success'){
   const call=calls.get(event.id);if(call?.name==='skill'&&call.args?.name===id)return true;
  }
 }
 return false;
}
