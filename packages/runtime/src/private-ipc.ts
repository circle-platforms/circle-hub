import {createServer,createConnection,type Server} from 'node:net';
import {chmod,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError,MAX_BODY_BYTES} from '../../contracts/src/index.ts';

export class PrivateIPC {
  path=join(tmpdir(),`cs-${randomUUID().slice(0,18)}.sock`);server?:Server;
  async start(handle:(message:any)=>Promise<any>):Promise<void>{
    this.server=createServer(socket=>{let pending='';socket.setTimeout(10_000,()=>socket.destroy());
      socket.on('data',chunk=>{pending+=chunk.toString();if(pending.length>MAX_BODY_BYTES){socket.destroy();return;}if(!pending.includes('\n'))return;
        socket.removeAllListeners('data');let message:any;try{message=JSON.parse(pending.slice(0,pending.indexOf('\n')));}catch{socket.end('{"error":"INVALID_PAYLOAD"}\n');return;}
        void handle(message).then(value=>socket.end(JSON.stringify({data:value})+'\n')).catch(error=>socket.end(JSON.stringify({error:error instanceof ApiError?error.code:'INTERNAL_ERROR'})+'\n'));
      });
    });await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(this.path,resolve);});await chmod(this.path,0o600);
  }
  async close():Promise<void>{if(this.server){await new Promise<void>(resolve=>this.server!.close(()=>resolve()));await unlink(this.path).catch(()=>{});}}
}
export async function privateRequest(path:string,value:unknown):Promise<any>{return new Promise((resolve,reject)=>{
  const socket=createConnection(path);let pending='';socket.setTimeout(10_000,()=>{socket.destroy();reject(new ApiError('SOURCE_UNREACHABLE','Private execution channel timed out'));});
  socket.once('error',()=>reject(new ApiError('SOURCE_UNREACHABLE','Private execution channel is unavailable')));
  socket.once('connect',()=>socket.write(JSON.stringify(value)+'\n'));socket.on('data',chunk=>{pending+=chunk.toString();if(pending.length>2*1024*1024){socket.destroy();reject(new ApiError('BODY_TOO_LARGE','Private execution message exceeds the byte limit'));}});
  socket.once('end',()=>{try{const result=JSON.parse(pending);if(result.error)reject(new ApiError(result.error,'Private execution request was rejected'));else resolve(result.data);}catch{reject(new ApiError('RUNTIME_FAILED','Private execution message was invalid'));}});
});}
