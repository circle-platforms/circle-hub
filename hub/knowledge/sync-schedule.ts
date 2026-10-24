// In-process scheduling only. Deployment decides which product and interval to configure.
export function scheduleSync<T>(run:(signal:AbortSignal)=>Promise<T>,options:{intervalMs:number;onError:(error:unknown)=>Promise<void>;onReport?:(report:T)=>void}):{runNow:()=>Promise<T|undefined>;stop:()=>Promise<void>}{
 if(!Number.isSafeInteger(options.intervalMs)||options.intervalMs<1)throw new TypeError('同步间隔必须是正整数毫秒');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|null=null,pending:Promise<T|undefined>|null=null,stopped=false;
 const arm=()=>{if(!stopped){timer=setTimeout(()=>{timer=null;void runNow();},options.intervalMs);timer.unref();}};
 const runNow=():Promise<T|undefined>=>{
  if(stopped)return Promise.resolve(undefined);
  if(pending)return pending;
  if(timer){clearTimeout(timer);timer=null;}
  pending=Promise.resolve().then(()=>run(controller.signal)).then(report=>{options.onReport?.(report);return report;},async error=>{await options.onError(error);return undefined;}).finally(()=>{pending=null;arm();});
  return pending;
 };
 arm();
 return {runNow,stop:async()=>{stopped=true;controller.abort();if(timer)clearTimeout(timer);timer=null;await pending;}};
}
