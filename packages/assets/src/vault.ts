import {mkdir,readFile,writeFile,unlink,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ApiError} from '../../contracts/src/index.ts';

export class PrivateVault {
  #directory:string;#key?:Buffer;
  constructor(directory:string){this.#directory=directory;}
  async initialize():Promise<void>{
    if(this.#key)return;await mkdir(this.#directory,{recursive:true,mode:0o700});
    const keyFile=join(this.#directory,'.key');
    try{await writeFile(keyFile,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    this.#key=await readFile(keyFile);if(this.#key.length!==32)throw new Error('Private credential key is unavailable');
  }
  path(reference:string):string{if(!/^[a-f0-9-]{36}$/.test(reference))throw new Error('Invalid private reference');return join(this.#directory,`${reference}.sealed`);}
  async put(value:string,binding:string):Promise<string>{
    await this.initialize();const id=randomUUID(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key!,iv);cipher.setAAD(Buffer.from(binding));
    const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    await writeFile(this.path(id),JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),bytes:bytes.toString('base64')}),{flag:'wx',mode:0o600});return id;
  }
  async get(reference:string,binding:string):Promise<string>{
    await this.initialize();const stored=JSON.parse(await readFile(this.path(reference),'utf8'));
    const decipher=createDecipheriv('aes-256-gcm',this.#key!,Buffer.from(stored.iv,'base64'));decipher.setAAD(Buffer.from(binding));decipher.setAuthTag(Buffer.from(stored.tag,'base64'));
    return Buffer.concat([decipher.update(Buffer.from(stored.bytes,'base64')),decipher.final()]).toString('utf8');
  }
  async replace(reference:string,value:string,binding:string):Promise<void>{
    await this.get(reference,binding);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key!,iv);cipher.setAAD(Buffer.from(binding));
    const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]),temporary=`${this.path(reference)}.${randomUUID()}.tmp`;
    try{await writeFile(temporary,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),bytes:bytes.toString('base64')}),{flag:'wx',mode:0o600});await rename(temporary,this.path(reference));}finally{await unlink(temporary).catch(()=>{});}
  }
  async withLock<T>(reference:string,run:()=>Promise<T>):Promise<T>{
    await this.initialize();const path=`${this.path(reference)}.lock`,deadline=Date.now()+125000;
    while(true){try{await writeFile(path,String(process.pid),{flag:'wx',mode:0o600});break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      try{const pid=Number(await readFile(path,'utf8'));if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')await unlink(path);}}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(Date.now()>deadline)throw new ApiError('SOURCE_UNREACHABLE','Credential rotation is still in progress');await delay(25);
    }}
    try{return await run();}finally{await unlink(path).catch(()=>{});}
  }
  async remove(reference:string):Promise<void>{await unlink(this.path(reference)).catch(()=>{});}
}
