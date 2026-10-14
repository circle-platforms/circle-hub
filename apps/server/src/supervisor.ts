import {hubChildEnvironment} from '../../../packages/contracts/src/hub-environment.ts';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {SERVER_STOP_TIMEOUT_MS} from './shutdown.ts';

const root=fileURLToPath(new URL('../../../',import.meta.url));
let child:ChildProcess|undefined,closing=false,restarting=false;const env=hubChildEnvironment(process.env);
function record(type:string,facts:Record<string,unknown>){process.stdout.write(JSON.stringify({type,at:new Date().toISOString(),supervisorId:process.pid,...facts})+'\n');}
async function stop():Promise<void>{
  if(closing)return;closing=true;
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timeout=setTimeout(()=>{child?.kill('SIGKILL');},SERVER_STOP_TIMEOUT_MS);try{await exited;}finally{clearTimeout(timeout);}}
  if(process.connected)process.disconnect();
}
function start(reason='initial'):void{
  const next=spawn(process.execPath,['apps/server/src/main.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});child=next;let output='';
  record('supervisor.child.start',{processId:next.pid,reason,graceful:reason==='graceful-restart'});
  next.stderr!.on('data',data=>process.stderr.write(data));
  next.stdout!.on('data',data=>{output+=data.toString();const lines=output.split('\n');output=lines.pop()!;for(const line of lines){
    try{const item=JSON.parse(line);if(item.type==='ready')env.CIRCLE_HUB_PORT=String(new URL(item.url).port);}catch{}process.stdout.write(line+'\n');
  }});
  next.on('message',message=>{if((message as any)?.type==='graceful-restart'&&!closing){restarting=true;if(process.connected&&env.CIRCLE_HUB_MANAGED_WORKERS==='1')process.send?.({type:'workers-restart'});next.send({type:'graceful-restart-now'});}});
  next.once('exit',(code,signal)=>{record('supervisor.child.exit',{processId:next.pid,code,signal,graceful:(closing||restarting)&&code===0,reason:closing?'shutdown':restarting?'graceful-restart':'unexpected'});if(closing)return;if(restarting){restarting=false;start('graceful-restart');}else{process.exitCode=code||1;void stop();}});
  next.once('error',()=>{record('supervisor.child.error',{processId:next.pid??null,reason:'spawn-failed',graceful:false});process.exitCode=1;void stop();});
}
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});process.on('SIGHUP',()=>{void stop();});process.once('disconnect',()=>{void stop();});start();
