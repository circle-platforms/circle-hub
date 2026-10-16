export function devStackSecret(name:string,configured:string|undefined,generated:string):string{
 if(configured===undefined||configured==='')return generated;
 if(configured.length<12||configured.length>200){
  const error=new Error(`${name} must be 12 to 200 characters. The value is not shown.`);
  error.name='HubEnvironmentError';throw error;
 }
 return configured;
}
export function devStackForeground(stdinIsTTY:boolean|undefined,stdoutIsTTY:boolean|undefined):boolean{return Boolean(stdinIsTTY&&stdoutIsTTY);}
export function devStackStopLine(foreground:boolean,pid:number):string{
 return foreground
  ? 'Stop: press Ctrl+C in this terminal. That stops the processes and deletes this temporary database.'
  : `Stop: send SIGTERM to pid ${pid}. That stops the processes and deletes this temporary database.`;
}
export function devStackNextLines(facts:{url:string;userPassword:string;approverPassword:string;samplePath:string;pid:number;foreground:boolean}):string[]{
 const login=`/hub login ${facts.url} developer`;
 return [
  `Hub is ready at ${facts.url}.`,
  'Next, in Circle: /extensions enable hub',
  `Then: ${login}`,
  `Developer password: ${facts.userPassword}`,
  `Approver username: approver. Approver password: ${facts.approverPassword}`,
  'Scope: scp_lab',
  `Synthetic XMind sample: ${facts.samplePath}`,
  devStackStopLine(facts.foreground,facts.pid),
  `下一步：在 Circle 里执行 /extensions enable hub，然后 ${login}。开发者密码见上一行，审批人是 approver。范围 scp_lab。`,
 ];
}
