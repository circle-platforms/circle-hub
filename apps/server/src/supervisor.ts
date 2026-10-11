import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
let child:ChildProcess|undefined,closing=false,restarting=false;const env={...process.env};
async function stop():Promise<void>{
  if(closing)return;closing=true;
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timeout=setTimeout(()=>{child?.kill('SIGKILL');},5000);try{await exited;}finally{clearTimeout(timeout);}}
  if(process.connected)process.disconnect();
}
function start():void{
  const next=spawn(process.execPath,['apps/server/src/main.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});child=next;let output='';
  next.stderr!.on('data',data=>process.stderr.write(data));
  next.stdout!.on('data',data=>{output+=data.toString();const lines=output.split('\n');output=lines.pop()!;for(const line of lines){
    try{const item=JSON.parse(line);if(item.type==='ready')env.CIRCLE_SERVER_PORT=String(new URL(item.url).port);}catch{}process.stdout.write(line+'\n');
  }});
  next.on('message',message=>{if((message as any)?.type==='graceful-restart'&&!closing){restarting=true;next.send({type:'graceful-restart-now'});}});
  next.once('exit',code=>{if(closing)return;if(restarting){restarting=false;start();}else{process.exitCode=code||1;void stop();}});
  next.once('error',()=>{process.exitCode=1;void stop();});
}
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});process.on('SIGHUP',()=>{void stop();});process.once('disconnect',()=>{void stop();});start();
